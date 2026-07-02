/**
 * SOA verification module (industry-gap-analysis §2.2 item 8).
 *
 * FS-RI/Sapiens-class systems verify a cedent's statement of account against
 * the contract's terms rather than taking its figures on trust. This module is
 * that verifier: it recomputes the expected ceding commission (flat or
 * sliding-scale, collared by commissionMinPct/commissionMaxPct), overriding
 * commission, brokerage and reinstatement premium from the contract's typed
 * term set and the premium the statement itself carries - all through
 * @rios/domain, so the numbers are the ones the unit tests prove correct - then
 * flags each line whose deviation exceeds the tolerance. Runs are persisted
 * (soa_verification / soa_verification_item, migration 0055) and audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildStatement, money, add, zero,
  expectedCedingCommission, compareSoaItems, overridingCommission, brokerage, reinstatementPremium,
  type FinancialEvent as DomainEvent, type FinancialEventType, type Layer, type Money,
  type SoaItemComparison,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/** Premium base of a statement: the same premium vocabulary the dashboard GWP uses. */
const PREMIUM_TYPES: FinancialEventType[] = [
  'DEPOSIT_PREMIUM', 'INSTALMENT_PREMIUM', 'ADJUSTMENT_PREMIUM', 'MINIMUM_PREMIUM',
];
/** Loss payments on a statement (recoveries paid by the reinsurer, CR to the cedent). */
const LOSS_TYPES: FinancialEventType[] = ['PAID_LOSS', 'CASH_LOSS'];

const verifySchema = z.object({
  tolerancePct: z.number().min(0).max(100).optional(),
});

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Optional sliding-scale bands from the (passthrough) term set: [{ lossRatioUpTo, commissionRate }]. */
function bandsFromTerms(v: unknown): { lossRatioUpTo: number; commissionRate: number }[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const bands: { lossRatioUpTo: number; commissionRate: number }[] = [];
  for (const b of v) {
    const o = b as Record<string, unknown>;
    const lossRatioUpTo = num(o?.lossRatioUpTo);
    const commissionRate = num(o?.commissionRate);
    if (lossRatioUpTo === undefined || commissionRate === undefined) return undefined;
    bands.push({ lossRatioUpTo, commissionRate });
  }
  return bands;
}

const magnitude = (m: Money): Money => money(Math.abs(m.amount), m.currency);

export async function soaVerificationModule(app: FastifyInstance): Promise<void> {
  // Recompute the statement's verifiable figures from the contract terms and
  // flag deviations beyond tolerance (default 1% of the expected figure).
  app.post<{ Params: { id: string } }>(
    '/api/statements/:id/verify',
    { preHandler: requirePermission('statement:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = verifySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid verification request', details: parsed.error.flatten() };
      }
      const tolerancePct = parsed.data.tolerancePct ?? 1;

      return runAs(ctx, async (db) => {
        const st = await db.query<{
          id: string; reference: string | null; contract_id: string | null; currency: string;
        }>(
          `select id, reference, contract_id, currency from statement_of_account where id = $1`,
          [req.params.id],
        );
        if (!st.rows[0]) {
          reply.code(404);
          return { error: 'Statement not found' };
        }
        const statement = st.rows[0];
        const currency = statement.currency;

        const eventRows = await db.query<{
          id: string; contract_id: string; event_type: string; direction: 'DR' | 'CR';
          amount_minor: number; currency: string; booked_at: string;
        }>(
          `select id, contract_id, event_type, direction, amount_minor, currency,
                  to_char(booked_at, 'YYYY-MM-DD') as booked_at
             from financial_event where statement_id = $1 order by booked_at, created_at`,
          [statement.id],
        );
        const events: DomainEvent[] = eventRows.rows.map((r) => ({
          id: r.id,
          contractId: r.contract_id,
          type: r.event_type as DomainEvent['type'],
          amount: money(r.amount_minor, r.currency),
          direction: r.direction,
          bookedAt: r.booked_at,
        }));

        const termsRes = await db.query<{ terms: Record<string, unknown> }>(
          `select terms from term_set where contract_id = $1 order by version desc limit 1`,
          [statement.contract_id],
        );
        const terms = termsRes.rows[0]?.terms ?? {};

        let status: 'VERIFIED' | 'DEVIATIONS' | 'FAILED';
        let items: {
          itemKey: string; expectedMinor: number | null; actualMinor: number | null;
          deviationMinor: number | null; withinTolerance: boolean | null; note: string | null;
        }[];

        try {
          // Net the statement's events with the tested domain engine and index
          // the signed line totals (DR positive from the cedent's perspective).
          const soa = buildStatement(events, currency);
          const byType = new Map(soa.lines.map((l) => [l.type, l.total]));
          const lineTotal = (t: FinancialEventType): Money => byType.get(t) ?? zero(currency);

          const premiumBase = PREMIUM_TYPES.reduce((acc, t) => add(acc, lineTotal(t)), zero(currency));
          const incurredLoss = magnitude(LOSS_TYPES.reduce((acc, t) => add(acc, lineTotal(t)), zero(currency)));

          const cedingPct = num(terms.cedingCommissionPct);
          const minPct = num(terms.commissionMinPct);
          const maxPct = num(terms.commissionMaxPct);
          const bands = bandsFromTerms(terms.slidingScaleBands);
          const overridePct = num(terms.overridePct);
          const brokeragePct = num(terms.brokeragePct);

          const comparisons: SoaItemComparison[] = [];

          // Ceding commission: flat or sliding-scale, collared to [min, max].
          if (cedingPct !== undefined || minPct !== undefined || maxPct !== undefined
              || bands !== undefined || byType.has('CEDING_COMMISSION')) {
            comparisons.push({
              itemKey: 'CEDING_COMMISSION',
              expected: expectedCedingCommission(
                premiumBase,
                { provisionalRatePct: cedingPct, minRatePct: minPct, maxRatePct: maxPct, bands },
                incurredLoss,
              ),
              actual: magnitude(lineTotal('CEDING_COMMISSION')),
              note: bands ? 'sliding scale on statement loss ratio' : 'flat rate collared to [min,max]',
            });
          }

          if (overridePct !== undefined || byType.has('OVERRIDING_COMMISSION')) {
            comparisons.push({
              itemKey: 'OVERRIDING_COMMISSION',
              expected: overridingCommission(premiumBase, (overridePct ?? 0) / 100),
              actual: magnitude(lineTotal('OVERRIDING_COMMISSION')),
            });
          }

          if (brokeragePct !== undefined || byType.has('BROKERAGE')) {
            comparisons.push({
              itemKey: 'BROKERAGE',
              expected: brokerage(premiumBase, (brokeragePct ?? 0) / 100),
              actual: magnitude(lineTotal('BROKERAGE')),
            });
          }

          // Reinstatement premium, when the statement carries one: recompute
          // from the contract's layer terms against the statement's own loss
          // payments (in booked order) and premium base.
          if (byType.has('REINSTATEMENT_PREMIUM')) {
            const layerRes = await db.query<{
              attachment_minor: number; limit_minor: number;
              reinstatements: number | null; reinstatement_rates: number[] | null; currency: string;
            }>(
              `select attachment_minor, limit_minor, reinstatements, reinstatement_rates, currency
                 from contract_layer where contract_id = $1 order by layer_no limit 1`,
              [statement.contract_id],
            );
            const lr = layerRes.rows[0];
            if (lr) {
              const layer: Layer = {
                attachment: money(lr.attachment_minor, lr.currency),
                limit: money(lr.limit_minor, lr.currency),
                reinstatements: lr.reinstatements ?? Infinity,
                reinstatementRates: Array.isArray(lr.reinstatement_rates) ? lr.reinstatement_rates : [],
              };
              const recoveries = events
                .filter((e) => LOSS_TYPES.includes(e.type))
                .map((e) => e.amount);
              comparisons.push({
                itemKey: 'REINSTATEMENT_PREMIUM',
                expected: reinstatementPremium({ layer, annualPremium: premiumBase, recoveries })
                  .totalReinstatementPremium,
                actual: magnitude(lineTotal('REINSTATEMENT_PREMIUM')),
                note: 'recomputed from layer terms against statement loss payments',
              });
            } else {
              comparisons.push({
                itemKey: 'REINSTATEMENT_PREMIUM',
                expected: zero(currency),
                actual: magnitude(lineTotal('REINSTATEMENT_PREMIUM')),
                note: 'contract has no layer reinstatement terms; expected could not be recomputed',
              });
            }
          }

          const result = compareSoaItems(comparisons, tolerancePct);
          status = result.allWithinTolerance ? 'VERIFIED' : 'DEVIATIONS';
          items = result.items.map((i) => ({
            itemKey: i.itemKey,
            expectedMinor: i.expected.amount,
            actualMinor: i.actual.amount,
            deviationMinor: i.deviation.amount,
            withinTolerance: i.withinTolerance,
            note: i.note ?? null,
          }));
        } catch (err) {
          // Recompute failure (e.g. cross-currency events) is a first-class,
          // audited outcome - never a silent pass.
          status = 'FAILED';
          items = [{
            itemKey: 'ERROR',
            expectedMinor: null, actualMinor: null, deviationMinor: null, withinTolerance: null,
            note: err instanceof Error ? err.message : String(err),
          }];
        }

        const inserted = await db.query<{ id: string; created_at: string }>(
          `insert into soa_verification (tenant_id, statement_id, status, tolerance_pct, created_by)
           values ($1,$2,$3,$4,$5)
           returning id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`,
          [ctx.tenantId, statement.id, status, tolerancePct, ctx.userId],
        );
        const verificationId = inserted.rows[0]!.id;

        for (const item of items) {
          await db.query(
            `insert into soa_verification_item
               (tenant_id, verification_id, item_key, expected_minor, actual_minor, deviation_minor, within_tolerance, note)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              ctx.tenantId, verificationId, item.itemKey,
              item.expectedMinor, item.actualMinor, item.deviationMinor, item.withinTolerance, item.note,
            ],
          );
        }

        await writeAudit(db, ctx, {
          action: 'verify',
          entityType: 'soa_verification',
          entityId: verificationId,
          after: {
            statementId: statement.id,
            statementReference: statement.reference,
            contractId: statement.contract_id,
            status,
            tolerancePct,
            itemCount: items.length,
            deviations: items.filter((i) => i.withinTolerance === false).map((i) => i.itemKey),
          },
          actorLabel: req.auth?.displayName,
        });

        reply.code(201);
        return {
          id: verificationId,
          statementId: statement.id,
          status,
          tolerancePct,
          currency,
          createdAt: inserted.rows[0]!.created_at,
          items,
        };
      });
    },
  );

  // Verification history for a statement, newest first, with items.
  app.get<{ Params: { id: string } }>(
    '/api/statements/:id/verifications',
    { preHandler: requirePermission('statement:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const st = await db.query<{ id: string }>(
          `select id from statement_of_account where id = $1`,
          [req.params.id],
        );
        if (!st.rows[0]) {
          reply.code(404);
          return { error: 'Statement not found' };
        }

        const verifications = await db.query<{
          id: string; status: string; tolerancePct: number; createdAt: string;
        }>(
          `select id, status, tolerance_pct as "tolerancePct",
                  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt"
             from soa_verification where statement_id = $1 order by created_at desc, id`,
          [req.params.id],
        );
        const itemRows = await db.query<{
          verification_id: string; itemKey: string; expectedMinor: number | null;
          actualMinor: number | null; deviationMinor: number | null;
          withinTolerance: boolean | null; note: string | null;
        }>(
          `select verification_id, item_key as "itemKey", expected_minor as "expectedMinor",
                  actual_minor as "actualMinor", deviation_minor as "deviationMinor",
                  within_tolerance as "withinTolerance", note
             from soa_verification_item
            where verification_id = any($1::uuid[]) order by item_key`,
          [verifications.rows.map((v) => v.id)],
        );
        const byVerification = new Map<string, typeof itemRows.rows>();
        for (const item of itemRows.rows) {
          const list = byVerification.get(item.verification_id) ?? [];
          list.push(item);
          byVerification.set(item.verification_id, list);
        }

        return {
          statementId: req.params.id,
          verifications: verifications.rows.map((v) => ({
            ...v,
            items: (byVerification.get(v.id) ?? []).map(({ verification_id: _vid, ...rest }) => rest),
          })),
        };
      });
    },
  );
}
