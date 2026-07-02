/**
 * UPR/DAC earnings module (brief §7.6, §9.8; industry-gap-analysis §2.2 item 6).
 *
 * Runs the unearned-premium / deferred-acquisition-cost accrual as of a date -
 * the valuation step a period close consumes. For every non-draft contract with
 * written premium it derives:
 *
 *  - written premium: the net of the contract's premium-type Financial Events
 *    booked on or before the as-of date (the same immutable events the
 *    statement/GL chain reads - no side channel);
 *  - acquisition cost: net commission/brokerage events if any were booked, else
 *    the term set's ceding-commission % of written premium;
 *  - earning pattern: the term set's `earningPattern` (metadata-driven; default
 *    PRO_RATA); a RISKS_ATTACHING period basis implies RISK_ATTACHING;
 *  - period: the contract's inception/expiry columns.
 *
 * All the maths (earning fractions, UPR/DAC splits) lives in @rios/domain -
 * this module only orchestrates and persists. Each run is audited in the same
 * transaction and its lines satisfy earned + UPR === written exactly.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  computeUPR,
  computeDAC,
  isEarningPattern,
  money,
  percentOf,
  zero,
  type EarningPattern,
  type Money,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/** Financial-event types that constitute written premium (see accounting.ts POSTING_RULES). */
const PREMIUM_EVENT_TYPES = [
  'DEPOSIT_PREMIUM',
  'INSTALMENT_PREMIUM',
  'ADJUSTMENT_PREMIUM',
  'REINSTATEMENT_PREMIUM',
  'MINIMUM_PREMIUM',
];

/** Financial-event types that constitute acquisition cost. */
const ACQUISITION_EVENT_TYPES = ['CEDING_COMMISSION', 'OVERRIDING_COMMISSION', 'BROKERAGE'];

/** Contract statuses that never carry earned premium (pre-bind or void). */
const NON_ACCRUING_STATUSES = ['DRAFT', 'QUOTED', 'PLACING', 'CANCELLED'];

const runSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be YYYY-MM-DD'),
});

/** Resolve the contract's earning pattern from its term set (metadata-driven). */
function resolvePattern(terms: Record<string, unknown> | null): EarningPattern {
  const explicit = terms?.earningPattern;
  if (isEarningPattern(explicit)) return explicit;
  if (terms?.periodBasis === 'RISKS_ATTACHING') return 'RISK_ATTACHING';
  return 'PRO_RATA';
}

interface UprLine {
  contractId: string;
  reference: string | null;
  pattern: EarningPattern;
  currency: string;
  fraction: number;
  written: Money;
  earned: Money;
  upr: Money;
  acquisition: Money;
  amortised: Money;
  dac: Money;
}

export async function earningsModule(app: FastifyInstance): Promise<void> {
  // Run the UPR/DAC accrual as of a date (period-close valuation step).
  app.post('/api/accounting/upr/run', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid UPR run request', details: parsed.error.flatten() };
    }
    const asOf = parsed.data.asOf;

    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        id: string;
        reference: string | null;
        currency: string;
        period_start: string | null;
        period_end: string | null;
        terms: Record<string, unknown> | null;
        written_minor: number;
        acquisition_minor: number;
      }>(
        `select c.id, c.reference, c.currency,
                to_char(c.period_start, 'YYYY-MM-DD') as period_start,
                to_char(c.period_end, 'YYYY-MM-DD') as period_end,
                (select ts.terms from term_set ts
                  where ts.contract_id = c.id order by ts.version desc limit 1) as terms,
                coalesce((select sum(case when fe.direction = 'DR' then fe.amount_minor else -fe.amount_minor end)
                   from financial_event fe
                  where fe.contract_id = c.id
                    and fe.event_type = any($2::citext[])
                    and fe.booked_at <= $1::date), 0) as written_minor,
                coalesce((select sum(case when fe.direction = 'CR' then fe.amount_minor else -fe.amount_minor end)
                   from financial_event fe
                  where fe.contract_id = c.id
                    and fe.event_type = any($3::citext[])
                    and fe.booked_at <= $1::date), 0) as acquisition_minor
           from contract c
          where not c.is_deleted
            and c.status <> all($4::citext[])
            and c.period_start is not null
            and c.period_end is not null
          order by c.created_at`,
        [asOf, PREMIUM_EVENT_TYPES, ACQUISITION_EVENT_TYPES, NON_ACCRUING_STATUSES],
      );

      const lines: UprLine[] = [];
      for (const c of rows) {
        const writtenMinor = Number(c.written_minor);
        // Only contracts with written premium, a coherent period, and no
        // exposure to inverted dates accrue.
        if (writtenMinor <= 0) continue;
        if (!c.period_start || !c.period_end || c.period_end < c.period_start) continue;

        const pattern = resolvePattern(c.terms);
        const written = money(writtenMinor, c.currency);

        // Acquisition cost: booked commission events if present, else the term
        // set's ceding-commission % of written premium (both via @rios/domain).
        let acquisition = zero(c.currency);
        const bookedAcq = Number(c.acquisition_minor);
        if (bookedAcq > 0) {
          acquisition = money(bookedAcq, c.currency);
        } else if (typeof c.terms?.cedingCommissionPct === 'number') {
          acquisition = percentOf(written, c.terms.cedingCommissionPct);
        }

        const uprSplit = computeUPR(written, pattern, c.period_start, c.period_end, asOf);
        const dacSplit = computeDAC(acquisition, pattern, c.period_start, c.period_end, asOf);

        lines.push({
          contractId: c.id,
          reference: c.reference,
          pattern,
          currency: c.currency,
          fraction: uprSplit.fraction,
          written,
          earned: uprSplit.earnedPremium,
          upr: uprSplit.upr,
          acquisition,
          amortised: dacSplit.amortised,
          dac: dacSplit.dac,
        });
      }

      // Header totals are raw sums over the lines - meaningful per currency;
      // the response carries the per-currency breakdown.
      const total = (pick: (l: UprLine) => Money) => lines.reduce((acc, l) => acc + pick(l).amount, 0);
      const inserted = await db.query<{ id: string }>(
        `insert into upr_run
           (tenant_id, as_of, status, line_count, total_written_minor, total_earned_minor,
            total_upr_minor, total_acquisition_minor, total_dac_minor, created_by)
         values ($1,$2,'COMPLETED',$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          ctx.tenantId, asOf, lines.length,
          total((l) => l.written), total((l) => l.earned), total((l) => l.upr),
          total((l) => l.acquisition), total((l) => l.dac),
          ctx.userId,
        ],
      );
      const runId = inserted.rows[0]!.id;

      for (const l of lines) {
        await db.query(
          `insert into upr_line
             (tenant_id, run_id, contract_id, pattern, currency,
              written_premium_minor, earned_minor, upr_minor, acquisition_cost_minor, dac_minor)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ctx.tenantId, runId, l.contractId, l.pattern, l.currency,
            l.written.amount, l.earned.amount, l.upr.amount, l.acquisition.amount, l.dac.amount,
          ],
        );
      }

      await writeAudit(db, ctx, {
        action: 'run',
        entityType: 'upr_run',
        entityId: runId,
        after: {
          asOf,
          lineCount: lines.length,
          totalWrittenMinor: total((l) => l.written),
          totalUprMinor: total((l) => l.upr),
          totalDacMinor: total((l) => l.dac),
        },
        actorLabel: req.auth?.displayName,
      });

      // Per-currency subtotals (money is never summed across currencies).
      const byCurrency = new Map<string, { writtenMinor: number; earnedMinor: number; uprMinor: number; acquisitionMinor: number; dacMinor: number }>();
      for (const l of lines) {
        const t = byCurrency.get(l.currency) ?? { writtenMinor: 0, earnedMinor: 0, uprMinor: 0, acquisitionMinor: 0, dacMinor: 0 };
        t.writtenMinor += l.written.amount;
        t.earnedMinor += l.earned.amount;
        t.uprMinor += l.upr.amount;
        t.acquisitionMinor += l.acquisition.amount;
        t.dacMinor += l.dac.amount;
        byCurrency.set(l.currency, t);
      }

      reply.code(201);
      return {
        id: runId,
        asOf,
        status: 'COMPLETED',
        lineCount: lines.length,
        totalsByCurrency: [...byCurrency.entries()].map(([currency, t]) => ({ currency, ...t })),
        lines: lines.map((l) => ({
          contractId: l.contractId,
          reference: l.reference,
          pattern: l.pattern,
          currency: l.currency,
          earnedFraction: l.fraction,
          writtenPremiumMinor: l.written.amount,
          earnedMinor: l.earned.amount,
          uprMinor: l.upr.amount,
          acquisitionCostMinor: l.acquisition.amount,
          dacMinor: l.dac.amount,
        })),
      };
    });
  });

  app.get('/api/accounting/upr/runs', { preHandler: requirePermission('accounting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select r.id, to_char(r.as_of, 'YYYY-MM-DD') as "asOf", r.status,
                r.line_count as "lineCount",
                r.total_written_minor as "totalWrittenMinor",
                r.total_earned_minor as "totalEarnedMinor",
                r.total_upr_minor as "totalUprMinor",
                r.total_acquisition_minor as "totalAcquisitionMinor",
                r.total_dac_minor as "totalDacMinor",
                r.created_at as "createdAt"
           from upr_run r
          order by r.created_at desc`,
      );
      return { runs: rows };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/accounting/upr/runs/:id',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const header = await db.query(
          `select r.id, to_char(r.as_of, 'YYYY-MM-DD') as "asOf", r.status,
                  r.line_count as "lineCount",
                  r.total_written_minor as "totalWrittenMinor",
                  r.total_earned_minor as "totalEarnedMinor",
                  r.total_upr_minor as "totalUprMinor",
                  r.total_acquisition_minor as "totalAcquisitionMinor",
                  r.total_dac_minor as "totalDacMinor",
                  r.created_at as "createdAt"
             from upr_run r where r.id = $1`,
          [req.params.id],
        );
        if (!header.rows[0]) {
          reply.code(404);
          return { error: 'UPR run not found' };
        }
        const lines = await db.query(
          `select l.id, l.contract_id as "contractId", c.reference, c.name as "contractName",
                  l.pattern, l.currency,
                  l.written_premium_minor as "writtenPremiumMinor",
                  l.earned_minor as "earnedMinor",
                  l.upr_minor as "uprMinor",
                  l.acquisition_cost_minor as "acquisitionCostMinor",
                  l.dac_minor as "dacMinor"
             from upr_line l
             join contract c on c.id = l.contract_id
            where l.run_id = $1
            order by c.reference`,
          [req.params.id],
        );
        return { ...header.rows[0], lines: lines.rows };
      });
    },
  );
}
