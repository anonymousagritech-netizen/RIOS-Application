/**
 * Retrocession module (brief §7.5, §29.3).
 *
 * Retrocession is outwards protection: the tenant (as retrocedent) cedes part of
 * its assumed book to a retrocessionaire. Contracts are direction='OUTWARDS'
 * (kind 'RETROCESSION'). The net-position view sums premium Financial Events on
 * inwards vs outwards contracts to show gross / ceded / net per currency - the
 * same party can appear as reinsurer on the way in and cedent on the way out
 * (§29.3). Money is summed with @rios/domain so currencies never mix.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  add, subtract, zero, money, allocateRetrocession,
  type Money, type RetroAllocationRule, type RetroEventKind,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

// Premium-type financial events count toward written/ceded premium (§7.6).
const PREMIUM_EVENT_TYPES = ['DEPOSIT_PREMIUM', 'INSTALMENT_PREMIUM', 'ADJUSTMENT_PREMIUM', 'MINIMUM_PREMIUM'];
// Loss-type financial events count toward incurred-paid losses (gross inwards vs ceded outwards).
const LOSS_EVENT_TYPES = ['PAID_LOSS', 'CASH_LOSS'];

const createRetrocessionSchema = z.object({
  name: z.string().min(1),
  basis: z.enum(['PROPORTIONAL', 'NON_PROPORTIONAL']),
  npType: z.enum(['PER_RISK_XL', 'CAT_XL', 'AGG_XL', 'STOP_LOSS']).optional(),
  currency: z.string().length(3),
  cedentPartyId: z.string().uuid().optional(),
  retrocessionairePartyId: z.string().uuid().optional(),
});

// A cession allocation rule: which retro contract takes what share of which
// inward premium/claim events (Tier-2 gap #10). Business meaning of the LOB
// filter comes from the line_of_business code list, not a hard-coded enum.
const allocationRuleSchema = z.object({
  retroContractId: z.string().uuid(),
  name: z.string().min(1),
  appliesTo: z.enum(['PREMIUM', 'CLAIM', 'BOTH']),
  lob: z.string().min(1).optional(),
  currency: z.string().length(3).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  method: z.literal('QUOTA_SHARE').default('QUOTA_SHARE'),
  cessionPct: z.number().gt(0).max(100),
  priority: z.number().int().min(0).default(100),
});

const allocationRunSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

interface AllocationRuleRow {
  id: string;
  retro_contract_id: string;
  applies_to: string;
  lob: string | null;
  currency: string | null;
  period_start: string | null;
  period_end: string | null;
  cession_pct: number;
  priority: number;
}

/**
 * Map a persisted rule row onto the pure domain rule shape. LOB columns are
 * citext (case-insensitive) in the DB, while the domain predicate compares
 * exactly, so both sides are lower-cased at the comparison boundary.
 */
function toDomainRule(r: AllocationRuleRow): RetroAllocationRule {
  return {
    id: r.id,
    retroContractId: r.retro_contract_id,
    appliesTo: r.applies_to as RetroAllocationRule['appliesTo'],
    filter: {
      lineOfBusiness: r.lob === null ? null : r.lob.toLowerCase(),
      currency: r.currency,
      periodStart: r.period_start,
      periodEnd: r.period_end,
    },
    method: 'QUOTA_SHARE',
    cessionPct: Number(r.cession_pct),
    priority: r.priority,
  };
}

export async function retrocessionModule(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/retrocession',
    { preHandler: requirePermission('retro:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select c.id, c.reference, c.name, c.contract_kind as "contractKind", c.basis,
                  c.proportional_type as "proportionalType", c.np_type as "npType",
                  c.line_of_business as "lineOfBusiness", c.direction, c.currency,
                  c.period_start as "periodStart", c.period_end as "periodEnd", c.status,
                  ced.short_name as "cedentName"
             from contract c
             left join party ced on ced.id = c.cedent_party_id
            where not c.is_deleted
              and (c.direction = 'OUTWARDS' or c.contract_kind = 'RETROCESSION')
            order by c.created_at desc`,
        );
        return { retrocession: rows };
      });
    },
  );

  // Net position across the book: gross (inwards) − ceded (outwards) per currency (§29.3).
  app.get(
    '/api/retrocession/net-position',
    { preHandler: requirePermission('retro:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          direction: string;
          currency: string;
          amount_minor: number;
        }>(
          `select c.direction, fe.currency, sum(fe.amount_minor)::bigint as amount_minor
             from financial_event fe
             join contract c on c.id = fe.contract_id
            where not c.is_deleted
              and fe.event_type = any($1::citext[])
            group by c.direction, fe.currency`,
          [PREMIUM_EVENT_TYPES],
        );

        const gross = new Map<string, Money>();
        const ceded = new Map<string, Money>();
        for (const r of rows) {
          const m = money(Number(r.amount_minor), r.currency);
          const bucket = r.direction === 'OUTWARDS' ? ceded : gross;
          const prev = bucket.get(r.currency) ?? zero(r.currency);
          bucket.set(r.currency, add(prev, m));
        }

        const currencies = new Set<string>([...gross.keys(), ...ceded.keys()]);
        const positions = [...currencies].sort().map((ccy) => {
          const g = gross.get(ccy) ?? zero(ccy);
          const c = ceded.get(ccy) ?? zero(ccy);
          const net = subtract(g, c);
          return { currency: ccy, grossMinor: g.amount, cededMinor: c.amount, netMinor: net.amount };
        });
        return { positions };
      });
    },
  );

  // Portfolio-level gross/ceded/net rollup across inwards + outwards contracts,
  // per currency and per line of business, from the SAME financial_event source
  // the accounting chain reconciles (no parallel money path). Gross = events on
  // INWARDS contracts, ceded = events on OUTWARDS (retro) contracts, net = gross
  // − ceded; premiums and paid losses are rolled up separately. Currencies never
  // mix: `totals` is the whole-book position keyed by currency.
  app.get(
    '/api/portfolio/net-position',
    { preHandler: requirePermission('treaty:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          direction: string;
          line_of_business: string | null;
          currency: string;
          premium_minor: string;
          loss_minor: string;
        }>(
          `select c.direction, c.line_of_business, fe.currency,
                  coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($1::citext[])), 0)::bigint as premium_minor,
                  coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($2::citext[])), 0)::bigint as loss_minor
             from financial_event fe
             join contract c on c.id = fe.contract_id
            where not c.is_deleted
              and fe.event_type = any($3::citext[])
            group by c.direction, c.line_of_business, fe.currency`,
          [PREMIUM_EVENT_TYPES, LOSS_EVENT_TYPES, [...PREMIUM_EVENT_TYPES, ...LOSS_EVENT_TYPES]],
        );

        interface Bucket { grossPremium: Money; cededPremium: Money; grossLoss: Money; cededLoss: Money }
        const emptyBucket = (ccy: string): Bucket => ({
          grossPremium: zero(ccy),
          cededPremium: zero(ccy),
          grossLoss: zero(ccy),
          cededLoss: zero(ccy),
        });
        const accumulate = (bucket: Bucket, r: (typeof rows)[number]): void => {
          const premium = money(Number(r.premium_minor), r.currency);
          const loss = money(Number(r.loss_minor), r.currency);
          if (r.direction === 'OUTWARDS') {
            bucket.cededPremium = add(bucket.cededPremium, premium);
            bucket.cededLoss = add(bucket.cededLoss, loss);
          } else {
            bucket.grossPremium = add(bucket.grossPremium, premium);
            bucket.grossLoss = add(bucket.grossLoss, loss);
          }
        };
        const project = (b: Bucket) => ({
          grossPremiumMinor: b.grossPremium.amount,
          cededPremiumMinor: b.cededPremium.amount,
          netPremiumMinor: subtract(b.grossPremium, b.cededPremium).amount,
          grossLossMinor: b.grossLoss.amount,
          cededLossMinor: b.cededLoss.amount,
          netLossMinor: subtract(b.grossLoss, b.cededLoss).amount,
        });

        const byCcy = new Map<string, Bucket>();
        const byLobKey = new Map<string, { lineOfBusiness: string | null; currency: string; bucket: Bucket }>();
        for (const r of rows) {
          const ccyBucket = byCcy.get(r.currency) ?? emptyBucket(r.currency);
          accumulate(ccyBucket, r);
          byCcy.set(r.currency, ccyBucket);

          const lobKey = `${r.line_of_business ?? '\u0000'}|${r.currency}`;
          const lobEntry =
            byLobKey.get(lobKey) ?? { lineOfBusiness: r.line_of_business, currency: r.currency, bucket: emptyBucket(r.currency) };
          accumulate(lobEntry.bucket, r);
          byLobKey.set(lobKey, lobEntry);
        }

        const currencies = [...byCcy.keys()].sort();
        const byCurrency = currencies.map((ccy) => ({ currency: ccy, ...project(byCcy.get(ccy)!) }));
        const byLob = [...byLobKey.values()]
          .sort((a, b) => {
            if (a.lineOfBusiness !== b.lineOfBusiness) {
              if (a.lineOfBusiness === null) return 1; // unclassified last
              if (b.lineOfBusiness === null) return -1;
              return a.lineOfBusiness < b.lineOfBusiness ? -1 : 1;
            }
            return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
          })
          .map((e) => ({ lineOfBusiness: e.lineOfBusiness, currency: e.currency, ...project(e.bucket) }));
        const totals = Object.fromEntries(currencies.map((ccy) => [ccy, project(byCcy.get(ccy)!)]));
        return { byCurrency, byLob, totals };
      });
    },
  );

  app.post('/api/retrocession', { preHandler: requirePermission('retro:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createRetrocessionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid retrocession', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'retrocession_reference', 'RETRO');
      const { rows } = await db.query<{ id: string }>(
        `insert into contract
           (tenant_id, reference, name, contract_kind, basis, np_type,
            direction, cedent_party_id, currency, status, created_by)
         values ($1,$2,$3,'RETROCESSION',$4,$5,'OUTWARDS',$6,$7,'DRAFT',$8) returning id`,
        [ctx.tenantId, ref, b.name, b.basis, b.npType ?? null, b.cedentPartyId ?? null, b.currency, ctx.userId],
      );
      const id = rows[0]!.id;

      // The retrocessionaire takes the outwards line (recorded as a participation).
      if (b.retrocessionairePartyId) {
        await db.query(
          `insert into participation (tenant_id, contract_id, party_id, role_code)
           values ($1,$2,$3,'retrocessionaire')`,
          [ctx.tenantId, id, b.retrocessionairePartyId],
        );
      }

      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'contract',
        entityId: id,
        after: { name: b.name, contractKind: 'RETROCESSION', direction: 'OUTWARDS', status: 'DRAFT' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, reference: ref, status: 'DRAFT' };
    });
  });

  // ---------------------------------------------------------------------------
  // Cession allocation engine (Tier-2 gap #10): rules that automatically
  // allocate every inward premium/claim financial event to the outward
  // retrocession program. The math is @rios/domain allocateRetrocession; this
  // module only persists. Ceded events reuse the source event's type/direction
  // on the OUTWARDS retro contract, so the existing net-position, statement and
  // GL-posting paths pick them up with no new vocabulary.
  // ---------------------------------------------------------------------------

  app.post(
    '/api/retrocession/allocation-rules',
    { preHandler: requirePermission('retro:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = allocationRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid allocation rule', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      if (b.periodStart && b.periodEnd && b.periodStart > b.periodEnd) {
        reply.code(400);
        return { error: 'periodStart must not be after periodEnd' };
      }
      return runAs(ctx, async (db) => {
        // The target must be an outward retro contract - never an inward one.
        const retro = await db.query<{ id: string }>(
          `select id from contract
            where id = $1 and not is_deleted
              and (direction = 'OUTWARDS' or contract_kind = 'RETROCESSION')`,
          [b.retroContractId],
        );
        if (!retro.rows[0]) {
          reply.code(404);
          return { error: 'Retrocession contract not found' };
        }

        const { rows } = await db.query<{ id: string }>(
          `insert into retro_allocation_rule
             (tenant_id, retro_contract_id, name, applies_to, lob, currency,
              period_start, period_end, method, cession_pct, priority, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [
            ctx.tenantId, b.retroContractId, b.name, b.appliesTo, b.lob ?? null,
            b.currency?.toUpperCase() ?? null, b.periodStart ?? null, b.periodEnd ?? null,
            b.method, b.cessionPct, b.priority, ctx.userId,
          ],
        );
        const id = rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'retro_allocation_rule',
          entityId: id,
          after: {
            name: b.name, retroContractId: b.retroContractId, appliesTo: b.appliesTo,
            method: b.method, cessionPct: b.cessionPct, lob: b.lob ?? null,
            currency: b.currency?.toUpperCase() ?? null, priority: b.priority,
          },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { id, name: b.name, appliesTo: b.appliesTo, method: b.method, cessionPct: b.cessionPct, priority: b.priority, active: true };
      });
    },
  );

  app.get(
    '/api/retrocession/allocation-rules',
    { preHandler: requirePermission('retro:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select r.id, r.retro_contract_id as "retroContractId", rc.reference as "retroContractRef",
                  rc.name as "retroContractName", r.name, r.applies_to as "appliesTo", r.lob, r.currency,
                  to_char(r.period_start, 'YYYY-MM-DD') as "periodStart",
                  to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd",
                  r.method, r.cession_pct as "cessionPct", r.priority, r.active,
                  r.created_at as "createdAt"
             from retro_allocation_rule r
             join contract rc on rc.id = r.retro_contract_id
            order by r.priority, r.created_at`,
        );
        return { rules: rows };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/retrocession/allocation-rules/:id/deactivate',
    { preHandler: requirePermission('retro:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string; name: string; active: boolean }>(
          `update retro_allocation_rule set active = false where id = $1 returning id, name, active`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Allocation rule not found' };
        }
        await writeAudit(db, ctx, {
          action: 'deactivate',
          entityType: 'retro_allocation_rule',
          entityId: rows[0].id,
          before: { active: true },
          after: { active: false },
          actorLabel: req.auth?.displayName,
        });
        return { id: rows[0].id, name: rows[0].name, active: false };
      });
    },
  );

  // Run the allocation engine: allocate every inward premium/claim financial
  // event in range that each active matching rule has not yet allocated. The
  // whole run is one transaction (runAs); the UNIQUE (tenant_id, rule_id,
  // source_event_id) + `on conflict do nothing` makes re-runs idempotent.
  app.post(
    '/api/retrocession/allocation/run',
    { preHandler: requirePermission('retro:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = allocationRunSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid allocation run request', details: parsed.error.flatten() };
      }
      const { from, to } = parsed.data;
      return runAs(ctx, async (db) => {
        const ruleRows = await db.query<AllocationRuleRow>(
          `select r.id, r.retro_contract_id, r.applies_to, r.lob, r.currency,
                  to_char(r.period_start, 'YYYY-MM-DD') as period_start,
                  to_char(r.period_end, 'YYYY-MM-DD') as period_end,
                  r.cession_pct, r.priority
             from retro_allocation_rule r
             join contract rc on rc.id = r.retro_contract_id
            where r.active and not rc.is_deleted
            order by r.priority, r.created_at`,
        );
        if (ruleRows.rows.length === 0) {
          return { allocated: 0, totalByCurrency: {}, skipped: 0 };
        }
        const rules = ruleRows.rows.map(toDomainRule);

        // Candidate source events: premium/loss events on live INWARDS
        // contracts. Ceded events live on OUTWARDS contracts, so the engine's
        // own output can never be re-allocated.
        const events = await db.query<{
          id: string;
          event_type: string;
          direction: 'DR' | 'CR';
          amount_minor: number;
          currency: string;
          booked_at: string;
          line_of_business: string | null;
        }>(
          `select fe.id, fe.event_type, fe.direction, fe.amount_minor, fe.currency,
                  to_char(fe.booked_at, 'YYYY-MM-DD') as booked_at, c.line_of_business
             from financial_event fe
             join contract c on c.id = fe.contract_id
            where not c.is_deleted
              and c.direction = 'INWARDS'
              and c.contract_kind <> 'RETROCESSION'
              and fe.event_type = any($1::citext[])
              and ($2::date is null or fe.booked_at >= $2)
              and ($3::date is null or fe.booked_at <= $3)
            order by fe.booked_at, fe.created_at`,
          [[...PREMIUM_EVENT_TYPES, ...LOSS_EVENT_TYPES], from ?? null, to ?? null],
        );

        let allocated = 0;
        let skipped = 0;
        const totals = new Map<string, Money>();

        for (const ev of events.rows) {
          const kind: RetroEventKind = PREMIUM_EVENT_TYPES.includes(ev.event_type.toUpperCase())
            ? 'PREMIUM'
            : 'CLAIM';
          const result = allocateRetrocession(
            {
              kind,
              amount: money(Number(ev.amount_minor), ev.currency),
              lineOfBusiness: ev.line_of_business === null ? null : ev.line_of_business.toLowerCase(),
              eventDate: ev.booked_at,
            },
            rules,
          );

          for (const line of result.allocations) {
            const ins = await db.query<{ id: string }>(
              `insert into retro_allocation
                 (tenant_id, rule_id, source_event_id, retro_contract_id, amount_minor, currency)
               values ($1,$2,$3,$4,$5,$6)
               on conflict (tenant_id, rule_id, source_event_id) do nothing
               returning id`,
              [ctx.tenantId, line.ruleId, ev.id, line.retroContractId, line.amount.amount, ev.currency],
            );
            if (!ins.rows[0]) {
              skipped += 1; // already allocated under this rule on a prior run
              continue;
            }

            // Book the ceded event on the outward retro contract. Same event
            // type and DR/CR as the source: premiums are owed by the tenant
            // (as retrocedent) to the retrocessionaire exactly as the cedent
            // owed them inwards, and ceded losses are recoveries the other way.
            // Zero-minor-unit cessions record the allocation but book no event.
            if (line.amount.amount > 0) {
              const ceded = await db.query<{ id: string }>(
                `insert into financial_event
                   (tenant_id, contract_id, event_type, direction, amount_minor, currency, booked_at, narrative, created_by)
                 values ($1,$2,$3,$4,$5,$6,$7::date,$8,$9) returning id`,
                [
                  ctx.tenantId, line.retroContractId, ev.event_type, ev.direction,
                  line.amount.amount, ev.currency, ev.booked_at,
                  `Retro cession ${line.cessionPct}% of ${ev.event_type} (allocation rule)`, ctx.userId,
                ],
              );
              await db.query(`update retro_allocation set ceded_event_id = $1 where id = $2`, [
                ceded.rows[0]!.id, ins.rows[0].id,
              ]);
              await writeAudit(db, ctx, {
                action: 'create',
                entityType: 'financial_event',
                entityId: ceded.rows[0]!.id,
                after: {
                  type: ev.event_type, amountMinor: line.amount.amount, currency: ev.currency,
                  retroContractId: line.retroContractId, sourceEventId: ev.id, allocationRuleId: line.ruleId,
                },
                actorLabel: req.auth?.displayName,
              });
              const prev = totals.get(ev.currency) ?? zero(ev.currency);
              totals.set(ev.currency, add(prev, line.amount));
            }
            allocated += 1;
          }
        }

        const totalByCurrency = Object.fromEntries(
          [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ccy, m]) => [ccy, m.amount]),
        );
        if (allocated > 0) {
          await writeAudit(db, ctx, {
            action: 'allocate',
            entityType: 'retro_allocation_run',
            after: { allocated, skipped, totalByCurrency, from: from ?? null, to: to ?? null },
            actorLabel: req.auth?.displayName,
          });
        }
        return { allocated, totalByCurrency, skipped };
      });
    },
  );

  // Allocation trace: source event → rule → ceded event. contractId matches
  // either side (the inward source contract or the outward retro contract).
  app.get<{ Querystring: { contractId?: string } }>(
    '/api/retrocession/allocations',
    { preHandler: requirePermission('retro:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select ra.id,
                  ra.rule_id as "ruleId", r.name as "ruleName", r.cession_pct as "cessionPct",
                  ra.source_event_id as "sourceEventId", sfe.event_type as "sourceEventType",
                  sfe.amount_minor as "sourceAmountMinor",
                  sfe.contract_id as "sourceContractId", sc.reference as "sourceContractRef",
                  ra.retro_contract_id as "retroContractId", rc.reference as "retroContractRef",
                  ra.ceded_event_id as "cededEventId",
                  ra.amount_minor as "amountMinor", ra.currency,
                  to_char(sfe.booked_at, 'YYYY-MM-DD') as "bookedAt",
                  ra.created_at as "allocatedAt"
             from retro_allocation ra
             join retro_allocation_rule r on r.id = ra.rule_id
             join financial_event sfe on sfe.id = ra.source_event_id
             join contract sc on sc.id = sfe.contract_id
             join contract rc on rc.id = ra.retro_contract_id
            where ($1::uuid is null or sfe.contract_id = $1 or ra.retro_contract_id = $1)
            order by ra.created_at desc, ra.id`,
          [req.query.contractId ?? null],
        );
        return { allocations: rows };
      });
    },
  );
}
