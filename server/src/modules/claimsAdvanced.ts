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
import { reinstatementPremium, fromMajor, money, type Layer } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const cashCallSchema = z.object({
  amount: z.number(),
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
          `insert into cash_call (tenant_id, claim_id, contract_id, amount_minor, currency, status, created_by)
           values ($1,$2,$3,$4,$5,'requested',$6) returning id, status`,
          [ctx.tenantId, claim.id, claim.contract_id, amount.amount, ccy, ctx.userId],
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
          after: { claimId: claim.id, amountMinor: amount.amount, status: 'requested' },
          actorLabel: req.auth?.displayName,
        });

        return {
          id: cashCallId,
          claimId: claim.id,
          contractId: claim.contract_id,
          amountMinor: amount.amount,
          currency: ccy,
          status: 'requested',
        };
      });
    },
  );

  app.post<{ Params: { id: string; callId: string } }>(
    '/api/claims/:id/cash-call/:callId/pay',
    { preHandler: requirePermission('claims:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const updated = await db.query<{ id: string; status: string }>(
          `update cash_call set status = 'paid' where id = $1 and claim_id = $2 returning id, status`,
          [req.params.callId, req.params.id],
        );
        if (!updated.rows[0]) {
          reply.code(404);
          return { error: 'Cash call not found' };
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
        return {
          claimId: claim.id,
          currency: claim.currency,
          grossLossMinor: claim.gross_loss_minor,
          paidMinor: claim.paid_minor,
          recoveredMinor: claim.recovered_minor,
          netMinor: claim.gross_loss_minor - claim.recovered_minor,
        };
      });
    },
  );
}
