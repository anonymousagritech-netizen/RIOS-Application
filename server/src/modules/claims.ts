/**
 * Claims module (brief §7.7, §28.4).
 * Registration, reserve movements (immutable history), and payment — each
 * movement keeps the claim's denormalised figures consistent and writes audit.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromMajor } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const createClaimSchema = z.object({
  contractId: z.string().uuid(),
  description: z.string().optional(),
  lossDate: z.string().optional(),
  currency: z.string().length(3),
  grossLoss: z.number().nonnegative().default(0),
});

const reserveSchema = z.object({
  movementType: z.enum(['OPEN', 'INCREASE', 'DECREASE', 'PAYMENT', 'CLOSE']),
  outstandingDelta: z.number().default(0),
  paidDelta: z.number().default(0),
  reason: z.string().optional(),
});

export async function claimsModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; contractId?: string } }>(
    '/api/claims',
    { preHandler: requirePermission('claims:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select cl.id, cl.reference, cl.contract_id as "contractId", cl.description,
                  cl.loss_date as "lossDate", cl.notified_date as "notifiedDate", cl.currency,
                  cl.gross_loss_minor as "grossLossMinor", cl.outstanding_minor as "outstandingMinor",
                  cl.paid_minor as "paidMinor", cl.recovered_minor as "recoveredMinor", cl.status,
                  c.name as "contractName"
             from claim cl join contract c on c.id = cl.contract_id
            where not cl.is_deleted
              and ($1::citext is null or cl.status = $1)
              and ($2::uuid is null or cl.contract_id = $2)
            order by cl.notified_date desc`,
          [req.query.status ?? null, req.query.contractId ?? null],
        );
        return { claims: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/claims/:id',
    { preHandler: requirePermission('claims:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select cl.id, cl.reference, cl.contract_id as "contractId", cl.description,
                  cl.loss_date as "lossDate", cl.notified_date as "notifiedDate", cl.currency,
                  cl.gross_loss_minor as "grossLossMinor", cl.outstanding_minor as "outstandingMinor",
                  cl.paid_minor as "paidMinor", cl.recovered_minor as "recoveredMinor", cl.status
             from claim cl where cl.id = $1 and not cl.is_deleted`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Claim not found' };
        }
        const movements = await db.query(
          `select id, movement_type as "movementType", outstanding_delta_minor as "outstandingDeltaMinor",
                  paid_delta_minor as "paidDeltaMinor", reason, effective_date as "effectiveDate"
             from reserve_movement where claim_id = $1 order by created_at`,
          [req.params.id],
        );
        return { ...rows[0], movements: movements.rows };
      });
    },
  );

  app.post('/api/claims', { preHandler: requirePermission('claims:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createClaimSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid claim', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const gross = fromMajor(b.grossLoss, b.currency);
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'claim_reference', 'CLM');
      const { rows } = await db.query<{ id: string }>(
        `insert into claim (tenant_id, reference, contract_id, description, loss_date, currency, gross_loss_minor, outstanding_minor, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$7,'NOTIFIED',$8) returning id`,
        [ctx.tenantId, ref, b.contractId, b.description ?? null, b.lossDate ?? null, b.currency, gross.amount, ctx.userId],
      );
      const id = rows[0]!.id;
      if (gross.amount > 0) {
        await db.query(
          `insert into reserve_movement (tenant_id, claim_id, movement_type, outstanding_delta_minor, currency, reason, created_by)
           values ($1,$2,'OPEN',$3,$4,'Initial case reserve',$5)`,
          [ctx.tenantId, id, gross.amount, b.currency, ctx.userId],
        );
      }
      await writeAudit(db, ctx, { action: 'create', entityType: 'claim', entityId: id, after: { reference: ref, grossLossMinor: gross.amount }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id, reference: ref, status: 'NOTIFIED' };
    });
  });

  // Add a reserve movement and keep the claim's running figures consistent.
  app.post<{ Params: { id: string } }>(
    '/api/claims/:id/reserve-movement',
    { preHandler: requirePermission('claims:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = reserveSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid movement', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ currency: string; status: string; outstanding_minor: number; paid_minor: number }>(
          `select currency, status, outstanding_minor, paid_minor from claim where id = $1 and not is_deleted`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Claim not found' };
        }
        const ccy = cur.rows[0].currency;
        const outDelta = fromMajor(b.outstandingDelta, ccy).amount;
        const paidDelta = fromMajor(b.paidDelta, ccy).amount;

        await db.query(
          `insert into reserve_movement (tenant_id, claim_id, movement_type, outstanding_delta_minor, paid_delta_minor, currency, reason, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [ctx.tenantId, req.params.id, b.movementType, outDelta, paidDelta, ccy, b.reason ?? null, ctx.userId],
        );

        // A payment also books a PAID_LOSS financial event (feeds the statement).
        if (paidDelta > 0) {
          await db.query(
            `insert into financial_event (tenant_id, contract_id, claim_id, event_type, direction, amount_minor, currency, narrative, created_by)
             select tenant_id, contract_id, id, 'PAID_LOSS', 'CR', $2, currency, 'Loss payment', $3 from claim where id = $1`,
            [req.params.id, paidDelta, ctx.userId],
          );
        }

        const newStatus = b.movementType === 'CLOSE' ? 'CLOSED' : b.movementType === 'PAYMENT' ? 'PART_PAID' : 'RESERVED';
        const updated = await db.query(
          `update claim
              set outstanding_minor = outstanding_minor + $2,
                  paid_minor = paid_minor + $3,
                  status = $4,
                  updated_at = now()
            where id = $1
            returning outstanding_minor as "outstandingMinor", paid_minor as "paidMinor", status`,
          [req.params.id, outDelta, paidDelta, newStatus],
        );
        await writeAudit(db, ctx, { action: 'update', entityType: 'claim', entityId: req.params.id, after: { movementType: b.movementType, outstandingDelta: outDelta, paidDelta }, actorLabel: req.auth?.displayName });
        return updated.rows[0];
      });
    },
  );
}
