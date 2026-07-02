/**
 * Claims advanced module (brief §7.7) - depth on the claims domain.
 *
 * Cash calls, reinstatement-premium automation (§7.7 step 5), recoveries and the
 * net (inuring) retained position (§7.7 step 6). Money figures come from
 * @rios/domain so reinstatement premiums match the proven unit tests, and every
 * loss/recovery books a Financial Event to keep the accounting chain consistent.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  reinstatementPremium, fromMajor, money, recoveryPosition, type Layer, type RecoveryEntry, type RecoveryType,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const cashCallSchema = z.object({
  amount: z.number(),
  priority: z.enum(['NORMAL', 'URGENT', 'SIMULTANEOUS_SETTLEMENT']).default('NORMAL'),
});

const reinstatementSchema = z.object({
  layerId: z.string().uuid(),
  annualPremium: z.number(),
  recoveries: z.array(z.number()),
  timeFractions: z.array(z.number()).optional(),
});

const recoverySchema = z.object({
  recoveryType: z.enum(['REINSURANCE', 'SALVAGE', 'SUBROGATION']),
  amount: z.number(),
  recoveryContractId: z.string().uuid().optional(),
});

interface ClaimRow {
  id: string;
  contract_id: string;
  currency: string;
  gross_loss_minor: number;
  paid_minor: number;
  recovered_minor: number;
}

async function loadClaim(db: Db, id: string): Promise<ClaimRow | null> {
  const { rows } = await db.query<ClaimRow>(
    `select id, contract_id, currency, gross_loss_minor, paid_minor, recovered_minor
       from claim where id = $1 and not is_deleted`,
    [id],
  );
  return rows[0] ?? null;
}

export async function claimsAdvancedModule(app: FastifyInstance): Promise<void> {
  // --- Cash call (§7.7) ---
  app.post<{ Params: { id: string } }>(
    '/api/claims/:id/cash-call',
    { preHandler: requirePermission('claims:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = cashCallSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid cash call', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const claim = await loadClaim(db, req.params.id);
        if (!claim) {
          reply.code(404);
          return { error: 'Claim not found' };
        }
        const ccy = claim.currency;
        const amount = fromMajor(b.amount, ccy);

        const { rows } = await db.query<{ id: string; status: string }>(
          `insert into cash_call (tenant_id, claim_id, contract_id, amount_minor, currency, status, priority, created_by)
           values ($1,$2,$3,$4,$5,'requested',$6,$7) returning id, status`,
          [ctx.tenantId, claim.id, claim.contract_id, amount.amount, ccy, b.priority, ctx.userId],
        );
        const cashCallId = rows[0]!.id;

        // A cash call is an advance on the loss - book a CASH_LOSS financial event.
        await db.query(
          `insert into financial_event (tenant_id, contract_id, claim_id, event_type, direction, amount_minor, currency, narrative, created_by)
           values ($1,$2,$3,'CASH_LOSS','CR',$4,$5,'Cash call',$6)`,
          [ctx.tenantId, claim.contract_id, claim.id, amount.amount, ccy, ctx.userId],
        );

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'cash_call',
          entityId: cashCallId,
          after: { claimId: claim.id, amountMinor: amount.amount, status: 'requested', priority: b.priority },
          actorLabel: req.auth?.displayName,
        });

        return {
          id: cashCallId,
          claimId: claim.id,
          contractId: claim.contract_id,
          amountMinor: amount.amount,
          currency: ccy,
          status: 'requested',
          priority: b.priority,
        };
      });
    },
  );

  // Approve a cash call (maker/checker: the approver must not be the requester).
  app.post<{ Params: { id: string; callId: string } }>(
    '/api/claims/:id/cash-call/:callId/approve',
    { preHandler: requirePermission('claims:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ id: string; status: string; created_by: string | null }>(
          `select id, status, created_by from cash_call where id = $1 and claim_id = $2`,
          [req.params.callId, req.params.id],
        );
        if (!cur.rows[0]) { reply.code(404); return { error: 'Cash call not found' }; }
        if (cur.rows[0].status !== 'requested') {
          reply.code(409);
          return { error: `Cash call is ${cur.rows[0].status}; only a requested call can be approved` };
        }
        if (cur.rows[0].created_by && cur.rows[0].created_by === ctx.userId) {
          reply.code(403);
          return { error: 'Segregation of duties: the requester cannot approve their own cash call' };
        }
        const updated = await db.query<{ id: string; status: string }>(
          `update cash_call set status = 'approved', approved_by = $3, approved_at = now()
            where id = $1 and claim_id = $2 returning id, status`,
          [req.params.callId, req.params.id, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'approve', entityType: 'cash_call', entityId: req.params.callId,
          before: { status: 'requested' }, after: { status: 'approved' },
          actorLabel: req.auth?.displayName,
        });
        return updated.rows[0];
      });
    },
  );

  // Release payment: only an APPROVED call can be paid.
  app.post<{ Params: { id: string; callId: string } }>(
    '/api/claims/:id/cash-call/:callId/pay',
    { preHandler: requirePermission('claims:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const updated = await db.query<{ id: string; status: string }>(
          `update cash_call set status = 'paid', paid_at = now()
            where id = $1 and claim_id = $2 and status = 'approved' returning id, status`,
          [req.params.callId, req.params.id],
        );
        if (!updated.rows[0]) {
          const exists = await db.query<{ status: string }>(
            `select status from cash_call where id = $1 and claim_id = $2`,
            [req.params.callId, req.params.id],
          );
          if (!exists.rows[0]) { reply.code(404); return { error: 'Cash call not found' }; }
          reply.code(409);
          return { error: `Cash call is ${exists.rows[0].status}; it must be approved before payment` };
        }
        await writeAudit(db, ctx, {
          action: 'update',
          entityType: 'cash_call',
          entityId: req.params.callId,
          after: { status: 'paid' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.callId, status: 'paid' };
      });
    },
  );

  // Priority payment queue: open calls, simultaneous settlements first, then by age.
  app.get('/api/claims/cash-calls/queue', { preHandler: requirePermission('claims:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select cc.id, cc.claim_id as "claimId", cl.reference as "claimReference",
                cc.contract_id as "contractId", cc.amount_minor as "amountMinor", cc.currency,
                cc.status, cc.priority,
                to_char(cc.requested_date, 'YYYY-MM-DD') as "requestedDate",
                cc.approved_at as "approvedAt"
           from cash_call cc
           join claim cl on cl.id = cc.claim_id
          where cc.status in ('requested','approved')
          order by case cc.priority
                     when 'SIMULTANEOUS_SETTLEMENT' then 0
                     when 'URGENT' then 1
                     else 2
                   end,
                   cc.requested_date, cc.created_at`,
      );
      return { queue: rows.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) })) };
    });
  });

  // --- Reinstatement premium (§7.7 step 5) ---
  app.post<{ Params: { id: string } }>(
    '/api/claims/:id/reinstatement',
    { preHandler: requirePermission('claims:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = reinstatementSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid reinstatement request', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const claim = await loadClaim(db, req.params.id);
        if (!claim) {
          reply.code(404);
          return { error: 'Claim not found' };
        }
        const ccy = claim.currency;

        const layerRes = await db.query<{
          attachment_minor: number;
          limit_minor: number;
          reinstatements: number | null;
          reinstatement_rates: number[];
          currency: string;
        }>(
          `select attachment_minor, limit_minor, reinstatements, reinstatement_rates, currency
             from contract_layer where id = $1`,
          [b.layerId],
        );
        if (!layerRes.rows[0]) {
          reply.code(404);
          return { error: 'Layer not found' };
        }
        const lr = layerRes.rows[0];
        const layerCcy = lr.currency;
        const layer: Layer = {
          attachment: money(lr.attachment_minor, layerCcy),
          limit: money(lr.limit_minor, layerCcy),
          reinstatements: lr.reinstatements ?? Infinity,
          reinstatementRates: Array.isArray(lr.reinstatement_rates) ? lr.reinstatement_rates : [],
        };

        const result = reinstatementPremium({
          layer,
          annualPremium: fromMajor(b.annualPremium, layerCcy),
          recoveries: b.recoveries.map((r) => fromMajor(r, layerCcy)),
          timeFractions: b.timeFractions,
        });

        if (result.totalReinstatementPremium.amount > 0) {
          await db.query(
            `insert into financial_event (tenant_id, contract_id, claim_id, layer_id, event_type, direction, amount_minor, currency, narrative, created_by)
             values ($1,$2,$3,$4,'REINSTATEMENT_PREMIUM','DR',$5,$6,'Reinstatement premium',$7)`,
            [
              ctx.tenantId,
              claim.contract_id,
              claim.id,
              b.layerId,
              result.totalReinstatementPremium.amount,
              layerCcy,
              ctx.userId,
            ],
          );
        }

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'financial_event',
          entityId: claim.id,
          after: {
            claimId: claim.id,
            layerId: b.layerId,
            totalReinstatementPremiumMinor: result.totalReinstatementPremium.amount,
          },
          actorLabel: req.auth?.displayName,
        });

        return {
          claimId: claim.id,
          layerId: b.layerId,
          currency: layerCcy,
          charges: result.charges.map((c) => ({
            amountReinstatedMinor: c.amountReinstated.amount,
            rate: c.rate,
            timeFraction: c.timeFraction,
            premiumMinor: c.premium.amount,
          })),
          totalReinstatementPremiumMinor: result.totalReinstatementPremium.amount,
          limitReinstatedMinor: result.limitReinstated.amount,
        };
      });
    },
  );

  // --- Recovery (§7.7 step 6) ---
  app.post<{ Params: { id: string } }>(
    '/api/claims/:id/recovery',
    { preHandler: requirePermission('claims:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = recoverySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid recovery', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const claim = await loadClaim(db, req.params.id);
        if (!claim) {
          reply.code(404);
          return { error: 'Claim not found' };
        }
        const ccy = claim.currency;
        const amount = fromMajor(b.amount, ccy);

        const { rows } = await db.query<{ id: string }>(
          `insert into recovery (tenant_id, claim_id, recovery_contract_id, recovery_type, amount_minor, currency)
           values ($1,$2,$3,$4,$5,$6) returning id`,
          [ctx.tenantId, claim.id, b.recoveryContractId ?? null, b.recoveryType, amount.amount, ccy],
        );
        const recoveryId = rows[0]!.id;

        const updated = await db.query<{ recoveredMinor: number }>(
          `update claim set recovered_minor = recovered_minor + $2, updated_at = now()
            where id = $1 returning recovered_minor as "recoveredMinor"`,
          [claim.id, amount.amount],
        );

        // A recovery reduces the net loss - a debit on the reinsurer/loss account.
        await db.query(
          `insert into financial_event (tenant_id, contract_id, claim_id, event_type, direction, amount_minor, currency, narrative, created_by)
           values ($1,$2,$3,'RECOVERY','DR',$4,$5,'Recovery',$6)`,
          [ctx.tenantId, claim.contract_id, claim.id, amount.amount, ccy, ctx.userId],
        );

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'recovery',
          entityId: recoveryId,
          after: { claimId: claim.id, recoveryType: b.recoveryType, amountMinor: amount.amount },
          actorLabel: req.auth?.displayName,
        });

        return {
          id: recoveryId,
          claimId: claim.id,
          recoveryType: b.recoveryType,
          amountMinor: amount.amount,
          currency: ccy,
          recoveredMinor: updated.rows[0]!.recoveredMinor,
        };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/claims/:id/recoveries',
    { preHandler: requirePermission('claims:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, claim_id as "claimId", recovery_contract_id as "recoveryContractId",
                  recovery_type as "recoveryType", amount_minor as "amountMinor", currency,
                  status, collected_date as "collectedDate", created_at as "createdAt"
             from recovery where claim_id = $1 order by created_at`,
          [req.params.id],
        );
        return { recoveries: rows };
      });
    },
  );

  // --- Net (inuring) position (§7.7 step 6) ---
  app.get<{ Params: { id: string } }>(
    '/api/claims/:id/net-position',
    { preHandler: requirePermission('claims:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const claim = await loadClaim(db, req.params.id);
        if (!claim) {
          reply.code(404);
          return { error: 'Claim not found' };
        }
        const ccy = claim.currency;
        // Compute the net position through the tested domain engine: expected vs
        // received recoveries, a by-type breakdown and floored net incurred/paid.
        const recs = await db.query<{ recovery_type: string; amount_minor: number; status: string; collected_date: string | null }>(
          `select recovery_type, amount_minor, status, collected_date from recovery where claim_id = $1`,
          [claim.id],
        );
        const entries: RecoveryEntry[] = recs.rows.map((r) => ({
          type: r.recovery_type as RecoveryType,
          amount: money(Number(r.amount_minor), ccy),
          status:
            String(r.status).toUpperCase() === 'RECEIVED' ||
            String(r.status).toUpperCase() === 'COLLECTED' ||
            r.collected_date != null
              ? 'RECEIVED'
              : 'EXPECTED',
        }));
        const pos = recoveryPosition(
          money(Number(claim.gross_loss_minor), ccy),
          money(Number(claim.paid_minor), ccy),
          entries,
        );
        const byTypeMinor: Record<string, number> = {};
        for (const [k, v] of Object.entries(pos.byType)) byTypeMinor[k] = v.amount;
        return {
          claimId: claim.id,
          currency: ccy,
          grossLossMinor: claim.gross_loss_minor,
          paidMinor: claim.paid_minor,
          recoveredMinor: claim.recovered_minor,
          // Backward-compatible net (gross - all recorded recoveries).
          netMinor: claim.gross_loss_minor - claim.recovered_minor,
          // Domain-computed detail.
          receivedRecoveredMinor: pos.receivedRecovered.amount,
          expectedRecoveredMinor: pos.expectedRecovered.amount,
          netIncurredMinor: pos.netIncurred.amount,
          netPaidMinor: pos.netPaid.amount,
          outstandingMinor: pos.outstanding.amount,
          byTypeMinor,
        };
      });
    },
  );
}
