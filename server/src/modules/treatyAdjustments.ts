/**
 * Treaty adjustments module (brief §7.2, §28.3) - depth on the treaty domain.
 *
 * Profit commission, portfolio entry/withdrawal, endorsements and commutation.
 * The money figures come from @rios/domain so the numbers are the same ones the
 * unit tests prove correct; persisted runs and the booked Financial Events keep
 * the reconcilable accounting chain (§7.6) consistent.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { profitCommission, portfolioTransfer, mdPremiumAdjustment, fromMajor, money } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const profitCommissionSchema = z.object({
  cededPremium: z.number(),
  commissionPaid: z.number(),
  incurredLosses: z.number(),
  allowableExpensesPct: z.number(),
  ratePct: z.number(),
  lossBroughtForward: z.number().optional(),
  period: z.string().optional(),
});

const portfolioTransferSchema = z.object({
  direction: z.enum(['entry', 'withdrawal']),
  unearnedPremium: z.number(),
  outstandingLosses: z.number(),
  premiumPct: z.number(),
  lossPct: z.number(),
  effectiveDate: z.string().optional(),
});

const endorseSchema = z.object({
  effectiveDate: z.string().optional(),
  description: z.string().min(1),
  changes: z.record(z.unknown()).default({}),
});

const commuteSchema = z.object({
  settlementAmount: z.number(),
  reason: z.string().optional(),
});

const premiumAdjustmentSchema = z.object({
  /** Actual GNPI for the adjustment, in major units of the contract currency. */
  actualGnpi: z.number().nonnegative(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * The premium-event vocabulary the platform's GWP queries already use
 * (assistant/intelligence/retrocession all sum this set). Booked premium is the
 * signed net of these events: DR positive / CR negative (cedent perspective).
 */
const PREMIUM_EVENT_TYPES = ['DEPOSIT_PREMIUM', 'INSTALMENT_PREMIUM', 'ADJUSTMENT_PREMIUM', 'MINIMUM_PREMIUM'];

interface ContractRow {
  id: string;
  currency: string;
  status: string;
}

async function loadContract(db: Db, id: string): Promise<ContractRow | null> {
  const { rows } = await db.query<ContractRow>(
    `select id, currency, status from contract where id = $1 and not is_deleted`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadLatestTerms(db: Db, contractId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{ terms: Record<string, unknown> }>(
    `select terms from term_set where contract_id = $1 order by version desc limit 1`,
    [contractId],
  );
  return rows[0]?.terms ?? {};
}

/**
 * Resolve the M&D premium terms from the treaty's term set (treaties.ts
 * termsSchema keys). Typed keys: estimatedPremiumIncome (EPI), depositPremium,
 * minimumAndDepositPremium, rateOnLine. `premiumRatePct` (adjustable rate on
 * GNPI) and `minimumPremium` (a minimum distinct from the deposit) are not in
 * the typed schema; they ride on the schema's `.passthrough()` and take
 * precedence when present, falling back to rateOnLine / minimumAndDepositPremium.
 * All figures are major units, as terms are stored.
 */
function resolvePremiumTerms(terms: Record<string, unknown>): {
  epi?: number;
  minimumPremium?: number;
  depositPremium?: number;
  premiumRatePct?: number;
} {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const epi = num(terms.estimatedPremiumIncome);
  const mAndD = num(terms.minimumAndDepositPremium);
  const depositPct = num(terms.depositPct);
  return {
    epi,
    minimumPremium: num(terms.minimumPremium) ?? mAndD,
    // Mirrors treaties.ts bookDepositPremium: explicit deposit, else M&D, else EPI x depositPct.
    depositPremium:
      num(terms.depositPremium) ??
      mAndD ??
      (epi !== undefined && depositPct !== undefined ? (epi * depositPct) / 100 : undefined),
    premiumRatePct: num(terms.premiumRatePct) ?? num(terms.rateOnLine),
  };
}

/** Signed premium booked to date (DR - CR over the premium event types), per currency. */
async function bookedPremiumByCurrency(
  db: Db,
  contractId: string,
): Promise<Array<{ currency: string; bookedMinor: number; eventCount: number }>> {
  const { rows } = await db.query<{ currency: string; bookedMinor: number; eventCount: number }>(
    `select currency,
            sum(case when direction = 'DR' then amount_minor else -amount_minor end)::bigint as "bookedMinor",
            count(*)::int as "eventCount"
       from financial_event
      where contract_id = $1 and event_type = any($2::citext[])
      group by currency
      order by currency`,
    [contractId, PREMIUM_EVENT_TYPES],
  );
  return rows;
}

export async function treatyAdjustmentsModule(app: FastifyInstance): Promise<void> {
  // --- Profit commission (§7.2) ---
  app.post<{ Params: { id: string } }>(
    '/api/treaties/:id/profit-commission',
    { preHandler: requirePermission('treaty:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = profitCommissionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid profit-commission request', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        const ccy = contract.currency;
        const result = profitCommission(
          {
            cededPremium: fromMajor(b.cededPremium, ccy),
            commissionPaid: fromMajor(b.commissionPaid, ccy),
            incurredLosses: fromMajor(b.incurredLosses, ccy),
          },
          {
            ratePct: b.ratePct,
            allowableExpensesPct: b.allowableExpensesPct,
            lossCarriedForward:
              b.lossBroughtForward !== undefined ? fromMajor(b.lossBroughtForward, ccy) : undefined,
          },
        );

        const { rows } = await db.query<{ id: string }>(
          `insert into pc_run
             (tenant_id, contract_id, period, ceded_premium_minor, commission_paid_minor,
              incurred_losses_minor, allowable_expenses_pct, rate_pct, loss_brought_forward_minor,
              profit_minor, profit_commission_minor, loss_carried_forward_minor, currency, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
          [
            ctx.tenantId,
            contract.id,
            b.period ?? null,
            result.workings.cededPremium.amount,
            result.workings.commissionPaid.amount,
            result.workings.incurredLosses.amount,
            b.allowableExpensesPct,
            b.ratePct,
            result.workings.lossBroughtForward.amount,
            result.profit.amount,
            result.profitCommission.amount,
            result.lossCarriedForward.amount,
            ccy,
            ctx.userId,
          ],
        );
        const pcRunId = rows[0]!.id;

        // A positive profit commission is payable to the cedent (a credit on the
        // reinsurer account, like the other commission types).
        if (result.profitCommission.amount > 0) {
          await db.query(
            `insert into financial_event (tenant_id, contract_id, event_type, direction, amount_minor, currency, narrative, created_by)
             values ($1,$2,'PROFIT_COMMISSION','CR',$3,$4,'Profit commission',$5)`,
            [ctx.tenantId, contract.id, result.profitCommission.amount, ccy, ctx.userId],
          );
        }

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'pc_run',
          entityId: pcRunId,
          after: {
            contractId: contract.id,
            profitMinor: result.profit.amount,
            profitCommissionMinor: result.profitCommission.amount,
          },
          actorLabel: req.auth?.displayName,
        });

        return {
          id: pcRunId,
          contractId: contract.id,
          currency: ccy,
          workings: {
            cededPremiumMinor: result.workings.cededPremium.amount,
            allowableExpensesMinor: result.workings.allowableExpenses.amount,
            commissionPaidMinor: result.workings.commissionPaid.amount,
            incurredLossesMinor: result.workings.incurredLosses.amount,
            lossBroughtForwardMinor: result.workings.lossBroughtForward.amount,
          },
          profitMinor: result.profit.amount,
          profitCommissionMinor: result.profitCommission.amount,
          lossCarriedForwardMinor: result.lossCarriedForward.amount,
        };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/treaties/:id/profit-commission',
    { preHandler: requirePermission('treaty:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, contract_id as "contractId", period,
                  ceded_premium_minor as "cededPremiumMinor",
                  commission_paid_minor as "commissionPaidMinor",
                  incurred_losses_minor as "incurredLossesMinor",
                  allowable_expenses_pct as "allowableExpensesPct", rate_pct as "ratePct",
                  loss_brought_forward_minor as "lossBroughtForwardMinor",
                  profit_minor as "profitMinor",
                  profit_commission_minor as "profitCommissionMinor",
                  loss_carried_forward_minor as "lossCarriedForwardMinor",
                  currency, created_at as "createdAt"
             from pc_run where contract_id = $1 order by created_at desc`,
          [req.params.id],
        );
        return { runs: rows };
      });
    },
  );

  // --- Portfolio transfer (§7.2) ---
  app.post<{ Params: { id: string } }>(
    '/api/treaties/:id/portfolio-transfer',
    { preHandler: requirePermission('treaty:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = portfolioTransferSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid portfolio-transfer request', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        const ccy = contract.currency;
        const result = portfolioTransfer(
          fromMajor(b.unearnedPremium, ccy),
          fromMajor(b.outstandingLosses, ccy),
          { premiumPortfolioPct: b.premiumPct, lossPortfolioPct: b.lossPct, direction: b.direction },
        );

        const { rows } = await db.query<{ id: string }>(
          `insert into portfolio_transfer
             (tenant_id, contract_id, direction, unearned_premium_minor, outstanding_losses_minor,
              premium_pct, loss_pct, premium_transfer_minor, loss_transfer_minor, net_transfer_minor,
              currency, effective_date, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::date, current_date),$13) returning id`,
          [
            ctx.tenantId,
            contract.id,
            b.direction,
            fromMajor(b.unearnedPremium, ccy).amount,
            fromMajor(b.outstandingLosses, ccy).amount,
            b.premiumPct,
            b.lossPct,
            result.premiumTransfer.amount,
            result.lossTransfer.amount,
            result.netTransfer.amount,
            ccy,
            b.effectiveDate ?? null,
            ctx.userId,
          ],
        );
        const transferId = rows[0]!.id;

        // Convention: amounts here are from the reinsurer perspective (domain
        // signs an entry positive premium / positive assumed loss). On the cedent
        // financial-event ledger, a premium the cedent pays to the reinsurer is a
        // DR (owed) when positive; a loss transfer the reinsurer assumes reduces
        // what the cedent owes, so it is a CR when positive.
        const premiumAbs = Math.abs(result.premiumTransfer.amount);
        if (premiumAbs > 0) {
          await db.query(
            `insert into financial_event (tenant_id, contract_id, event_type, direction, amount_minor, currency, narrative, created_by)
             values ($1,$2,'PORTFOLIO_PREMIUM_TRANSFER',$3,$4,$5,'Portfolio premium transfer',$6)`,
            [ctx.tenantId, contract.id, result.premiumTransfer.amount >= 0 ? 'DR' : 'CR', premiumAbs, ccy, ctx.userId],
          );
        }
        const lossAbs = Math.abs(result.lossTransfer.amount);
        if (lossAbs > 0) {
          await db.query(
            `insert into financial_event (tenant_id, contract_id, event_type, direction, amount_minor, currency, narrative, created_by)
             values ($1,$2,'PORTFOLIO_LOSS_TRANSFER',$3,$4,$5,'Portfolio loss transfer',$6)`,
            [ctx.tenantId, contract.id, result.lossTransfer.amount >= 0 ? 'CR' : 'DR', lossAbs, ccy, ctx.userId],
          );
        }

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'portfolio_transfer',
          entityId: transferId,
          after: {
            contractId: contract.id,
            direction: b.direction,
            netTransferMinor: result.netTransfer.amount,
          },
          actorLabel: req.auth?.displayName,
        });

        return {
          id: transferId,
          contractId: contract.id,
          direction: b.direction,
          currency: ccy,
          premiumTransferMinor: result.premiumTransfer.amount,
          lossTransferMinor: result.lossTransfer.amount,
          netTransferMinor: result.netTransfer.amount,
        };
      });
    },
  );

  // --- Endorsement: a versioned amendment, not a new contract (§28.3) ---
  app.post<{ Params: { id: string } }>(
    '/api/treaties/:id/endorse',
    { preHandler: requirePermission('treaty:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = endorseSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid endorsement', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }

        const seq = await db.query<{ next: number }>(
          `select coalesce(max(endorsement_no), 0) + 1 as next from contract_endorsement where contract_id = $1`,
          [contract.id],
        );
        const endorsementNo = seq.rows[0]!.next;

        // If the endorsement updates terms, create a new versioned term_set merging
        // the prior terms with the supplied changes.terms.
        let termSetVersion: number | null = null;
        const changes = b.changes as { terms?: Record<string, unknown> };
        if (changes.terms && typeof changes.terms === 'object') {
          const prior = await db.query<{ version: number; terms: Record<string, unknown> }>(
            `select version, terms from term_set where contract_id = $1 order by version desc limit 1`,
            [contract.id],
          );
          const priorTerms = prior.rows[0]?.terms ?? {};
          const nextVersion = (prior.rows[0]?.version ?? 0) + 1;
          const mergedTerms = { ...priorTerms, ...changes.terms };
          await db.query(
            `insert into term_set (tenant_id, contract_id, version, terms, created_by) values ($1,$2,$3,$4,$5)`,
            [ctx.tenantId, contract.id, nextVersion, JSON.stringify(mergedTerms), ctx.userId],
          );
          termSetVersion = nextVersion;
        }

        const { rows } = await db.query<{ id: string }>(
          `insert into contract_endorsement
             (tenant_id, contract_id, endorsement_no, effective_date, description, changes, term_set_version, created_by)
           values ($1,$2,$3,coalesce($4::date, current_date),$5,$6,$7,$8) returning id`,
          [
            ctx.tenantId,
            contract.id,
            endorsementNo,
            b.effectiveDate ?? null,
            b.description,
            JSON.stringify(b.changes),
            termSetVersion,
            ctx.userId,
          ],
        );

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'contract_endorsement',
          entityId: rows[0]!.id,
          after: { contractId: contract.id, endorsementNo, termSetVersion },
          actorLabel: req.auth?.displayName,
        });

        return { id: rows[0]!.id, endorsementNo, termSetVersion };
      });
    },
  );

  // --- Commutation: settle and close the contract (§7.2, §28.3) ---
  app.post<{ Params: { id: string } }>(
    '/api/treaties/:id/commute',
    { preHandler: requirePermission('treaty:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = commuteSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid commutation', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        const ccy = contract.currency;
        const settlement = fromMajor(b.settlementAmount, ccy);

        await db.query(`update contract set status = 'COMMUTED', updated_at = now() where id = $1`, [contract.id]);

        if (settlement.amount > 0) {
          await db.query(
            `insert into financial_event (tenant_id, contract_id, event_type, direction, amount_minor, currency, narrative, created_by)
             values ($1,$2,'PAID_LOSS','CR',$3,$4,'Commutation settlement',$5)`,
            [ctx.tenantId, contract.id, settlement.amount, ccy, ctx.userId],
          );
        }

        const seq = await db.query<{ next: number }>(
          `select coalesce(max(endorsement_no), 0) + 1 as next from contract_endorsement where contract_id = $1`,
          [contract.id],
        );
        const endorsementNo = seq.rows[0]!.next;
        await db.query(
          `insert into contract_endorsement
             (tenant_id, contract_id, endorsement_no, description, changes, created_by)
           values ($1,$2,$3,$4,$5,$6)`,
          [
            ctx.tenantId,
            contract.id,
            endorsementNo,
            'Commutation',
            JSON.stringify({ status: 'COMMUTED', settlementAmountMinor: settlement.amount, reason: b.reason ?? null }),
            ctx.userId,
          ],
        );

        await writeAudit(db, ctx, {
          action: 'commute',
          entityType: 'contract',
          entityId: contract.id,
          before: { status: contract.status },
          after: { status: 'COMMUTED', settlementAmountMinor: settlement.amount, endorsementNo },
          actorLabel: req.auth?.displayName,
        });

        return { status: 'COMMUTED', settlementAmountMinor: settlement.amount, endorsementNo };
      });
    },
  );

  // --- EPI vs booked premium tracking (gap-analysis Tier-2 #7) ---
  // EPI, minimum/deposit and rate from the term set; booked premium from the
  // signed premium financial events; optional ?gnpi= projects the final premium.
  app.get<{ Params: { id: string }; Querystring: { gnpi?: string } }>(
    '/api/treaties/:id/premium-tracking',
    { preHandler: requirePermission('treaty:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        const ccy = contract.currency;
        const terms = resolvePremiumTerms(await loadLatestTerms(db, contract.id));
        const booked = await bookedPremiumByCurrency(db, contract.id);
        const bookedContractCcy = booked.find((b) => b.currency === ccy)?.bookedMinor ?? 0;

        // Optional projection: what would the adjustment be at this actual GNPI?
        let projection: Record<string, unknown> | null = null;
        const gnpi = req.query.gnpi !== undefined ? Number(req.query.gnpi) : undefined;
        if (gnpi !== undefined && Number.isFinite(gnpi) && gnpi >= 0
            && terms.premiumRatePct !== undefined && terms.minimumPremium !== undefined) {
          const result = mdPremiumAdjustment({
            actualGnpi: fromMajor(gnpi, ccy),
            premiumRatePct: terms.premiumRatePct,
            minimumPremium: fromMajor(terms.minimumPremium, ccy),
            bookedPremium: money(bookedContractCcy, ccy),
          });
          projection = {
            actualGnpiMinor: fromMajor(gnpi, ccy).amount,
            indicatedPremiumMinor: result.indicatedPremium.amount,
            finalPremiumMinor: result.finalPremium.amount,
            projectedAdjustmentMinor: result.adjustmentPremium.amount,
            minimumApplied: result.minimumApplied,
          };
        }

        return {
          contractId: contract.id,
          status: contract.status,
          currency: ccy,
          epiMinor: terms.epi !== undefined ? fromMajor(terms.epi, ccy).amount : null,
          minimumPremiumMinor: terms.minimumPremium !== undefined ? fromMajor(terms.minimumPremium, ccy).amount : null,
          depositPremiumMinor: terms.depositPremium !== undefined ? fromMajor(terms.depositPremium, ccy).amount : null,
          premiumRatePct: terms.premiumRatePct ?? null,
          bookedPremiumMinor: bookedContractCcy,
          bookedPremiumByCurrency: booked,
          projection,
        };
      });
    },
  );

  // --- M&D adjustment on actual GNPI: final = max(minimum, rate x GNPI);
  // book final - already-booked as an ADJUSTMENT_PREMIUM financial event so it
  // flows to statements/GL. Computing against booked-including-prior-adjustments
  // makes a repeat run with the same GNPI book nothing (idempotent). ---
  app.post<{ Params: { id: string } }>(
    '/api/treaties/:id/premium-adjustment',
    { preHandler: requirePermission('treaty:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = premiumAdjustmentSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid premium-adjustment request', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        if (contract.status !== 'BOUND') {
          reply.code(409);
          return { error: `Premium adjustment requires a BOUND contract; status is ${contract.status}` };
        }
        const terms = resolvePremiumTerms(await loadLatestTerms(db, contract.id));
        const missing: string[] = [];
        if (terms.premiumRatePct === undefined) missing.push('premiumRatePct (or rateOnLine)');
        if (terms.minimumPremium === undefined) missing.push('minimumPremium (or minimumAndDepositPremium)');
        if (missing.length > 0) {
          reply.code(400);
          return { error: `Treaty terms are missing required keys for M&D adjustment: ${missing.join(', ')}` };
        }

        const ccy = contract.currency;
        const booked = await bookedPremiumByCurrency(db, contract.id);
        const bookedMinor = booked.find((r) => r.currency === ccy)?.bookedMinor ?? 0;

        const result = mdPremiumAdjustment({
          actualGnpi: fromMajor(b.actualGnpi, ccy),
          premiumRatePct: terms.premiumRatePct!,
          minimumPremium: fromMajor(terms.minimumPremium!, ccy),
          bookedPremium: money(bookedMinor, ccy),
        });
        const adjustment = result.adjustmentPremium.amount;

        // Positive = additional premium due from the cedent (DR, like the other
        // premium events); negative = return premium to the cedent (CR).
        let eventId: string | null = null;
        if (adjustment !== 0) {
          const direction = adjustment > 0 ? 'DR' : 'CR';
          const { rows } = await db.query<{ id: string }>(
            `insert into financial_event
               (tenant_id, contract_id, event_type, direction, amount_minor, currency, booked_at, narrative, created_by)
             values ($1,$2,'ADJUSTMENT_PREMIUM',$3,$4,$5,coalesce($6::date, current_date),$7,$8) returning id`,
            [
              ctx.tenantId,
              contract.id,
              direction,
              Math.abs(adjustment),
              ccy,
              b.effectiveDate ?? null,
              `M&D premium adjustment on actual GNPI ${b.actualGnpi} ${ccy}`,
              ctx.userId,
            ],
          );
          eventId = rows[0]!.id;

          await writeAudit(db, ctx, {
            action: 'create',
            entityType: 'financial_event',
            entityId: eventId,
            after: {
              type: 'ADJUSTMENT_PREMIUM',
              contractId: contract.id,
              direction,
              amountMinor: Math.abs(adjustment),
              currency: ccy,
              actualGnpiMinor: fromMajor(b.actualGnpi, ccy).amount,
              minimumPremiumMinor: result.minimumPremium.amount,
              indicatedPremiumMinor: result.indicatedPremium.amount,
              finalPremiumMinor: result.finalPremium.amount,
              bookedBeforeMinor: bookedMinor,
            },
            actorLabel: req.auth?.displayName,
          });
        }

        return {
          contractId: contract.id,
          currency: ccy,
          actualGnpiMinor: fromMajor(b.actualGnpi, ccy).amount,
          premiumRatePct: terms.premiumRatePct,
          minimumPremiumMinor: result.minimumPremium.amount,
          indicatedPremiumMinor: result.indicatedPremium.amount,
          finalPremiumMinor: result.finalPremium.amount,
          bookedBeforeMinor: bookedMinor,
          adjustmentMinor: adjustment,
          minimumApplied: result.minimumApplied,
          booked: eventId !== null,
          eventId,
          direction: adjustment === 0 ? null : adjustment > 0 ? 'DR' : 'CR',
        };
      });
    },
  );
}
