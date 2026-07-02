/**
 * Claims module (brief §7.7, §28.4).
 * Registration, reserve movements (immutable history), and payment - each
 * movement keeps the claim's denormalised figures consistent and writes audit.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromMajor } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';
import { parsePaginationQuery, encodeCursor, decodeCursor } from '../lib/pagination.js';
import { toCsv, majorFromMinor } from '../csv.js';
import { notify } from './notifications.js';

const createClaimSchema = z.object({
  contractId: z.string().uuid(),
  description: z.string().optional(),
  lossDate: z.string().optional(),
  currency: z.string().length(3),
  grossLoss: z.number().nonnegative().default(0),
  // Catastrophe/occurrence coding: ties the FNOL to a market event so event-level
  // aggregation (hours clause, event limits) can roll claims up per occurrence.
  catEventId: z.string().uuid().optional(),
  // Metadata-driven adaptive-form data (Dynamic Form Engine); persisted verbatim.
  details: z.record(z.unknown()).optional(),
});

const reserveSchema = z.object({
  movementType: z.enum(['OPEN', 'INCREASE', 'DECREASE', 'PAYMENT', 'CLOSE']),
  outstandingDelta: z.number().default(0),
  paidDelta: z.number().default(0),
  reason: z.string().optional(),
});

export async function claimsModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; contractId?: string; limit?: string; cursor?: string } }>(
    '/api/claims',
    {
      preHandler: requirePermission('claims:read'),
      schema: {
        summary: 'List claims',
        tags: ['claims'],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Filter by claim status (OPEN, CLOSED, SETTLED, ...)' },
            contractId: { type: 'string', format: 'uuid', description: 'Filter by treaty/contract UUID' },
            limit: { type: 'string', description: 'Page size (default 25)' },
            cursor: { type: 'string', description: 'Keyset pagination cursor' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              claims: { type: 'array', items: { type: 'object' } },
              nextCursor: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    async (req) => {
      const ctx = authContext(req);
      const { limit, cursor } = parsePaginationQuery(req.query as Record<string, unknown>);
      const decoded = cursor ? decodeCursor(cursor) : null;
      return runAs(ctx, async (db) => {
        // Keyset on (cl.created_at DESC, cl.id DESC) for stable ordering.
        // Cursor uses created_at (timestamptz) as the primary sort key + id tiebreaker.
        const params: unknown[] = [req.query.status ?? null, req.query.contractId ?? null];
        let cursorClause = '';
        if (decoded) {
          params.push(decoded.createdAt, decoded.id);
          cursorClause = `AND (cl.created_at, cl.id) < ($3::timestamptz, $4::uuid)`;
        }
        const { rows } = await db.query<{ id: string; createdAt: string } & Record<string, unknown>>(
          `select cl.id, cl.reference, cl.contract_id as "contractId", cl.description,
                  cl.loss_date as "lossDate", cl.notified_date as "notifiedDate", cl.currency,
                  cl.gross_loss_minor as "grossLossMinor", cl.outstanding_minor as "outstandingMinor",
                  cl.paid_minor as "paidMinor", cl.recovered_minor as "recoveredMinor", cl.status,
                  c.name as "contractName",
                  cl.created_at::text as "createdAt"
             from claim cl join contract c on c.id = cl.contract_id
            where not cl.is_deleted
              and ($1::citext is null or cl.status = $1)
              and ($2::uuid is null or cl.contract_id = $2)
              ${cursorClause}
            order by cl.created_at desc, cl.id desc
            limit ${limit + 1}`,
          params,
        );
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        const last = rows[rows.length - 1];
        const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
        return { claims: rows, nextCursor };
      });
    },
  );

  // CSV export — same filters, streamed as a download.
  app.get<{ Querystring: { status?: string; contractId?: string } }>(
    '/api/claims/export.csv',
    { preHandler: requirePermission('claims:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          reference: string; description: string | null; lossDate: string | null;
          notifiedDate: string | null; currency: string;
          grossLossMinor: number; outstandingMinor: number; paidMinor: number;
          status: string; contractName: string | null;
        }>(
          `select cl.reference, cl.description, cl.loss_date as "lossDate",
                  cl.notified_date as "notifiedDate", cl.currency,
                  cl.gross_loss_minor as "grossLossMinor",
                  cl.outstanding_minor as "outstandingMinor",
                  cl.paid_minor as "paidMinor", cl.status,
                  c.name as "contractName"
             from claim cl join contract c on c.id = cl.contract_id
            where not cl.is_deleted
              and ($1::citext is null or cl.status = $1)
              and ($2::uuid is null or cl.contract_id = $2)
            order by cl.notified_date desc`,
          [req.query.status ?? null, req.query.contractId ?? null],
        );
        const csv = toCsv(
          ['Reference', 'Treaty', 'Description', 'Loss date', 'Notified date', 'Currency',
           'Gross (major)', 'Outstanding (major)', 'Paid (major)', 'Status'],
          rows.map((r) => [
            r.reference, r.contractName ?? '', r.description ?? '',
            r.lossDate ?? '', r.notifiedDate ?? '', r.currency,
            majorFromMinor(r.grossLossMinor), majorFromMinor(r.outstandingMinor),
            majorFromMinor(r.paidMinor), r.status,
          ]),
        );
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="claims.csv"');
        return csv;
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
                  cl.paid_minor as "paidMinor", cl.recovered_minor as "recoveredMinor", cl.status,
                  cl.details as "details"
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

  app.post('/api/claims', {
    preHandler: requirePermission('claims:write'),
    schema: {
      summary: 'Register a new claim (FNOL)',
      tags: ['claims'],
      body: {
        type: 'object',
        required: ['contractId', 'currency'],
        properties: {
          contractId: { type: 'string', format: 'uuid', description: 'Treaty/contract UUID' },
          description: { type: 'string', description: 'Loss description' },
          lossDate: { type: 'string', format: 'date', description: 'Date of loss' },
          currency: { type: 'string', minLength: 3, maxLength: 3, description: 'ISO 4217 currency code' },
          grossLoss: { type: 'number', minimum: 0, description: 'Initial gross loss estimate (major units)' },
          catEventId: { type: 'string', format: 'uuid', description: 'Catastrophe event UUID for aggregation' },
          details: { type: 'object', description: 'Metadata-driven adaptive form data' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            reference: { type: 'string' },
            status: { type: 'string' },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
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
        `insert into claim (tenant_id, reference, contract_id, description, loss_date, currency, gross_loss_minor, outstanding_minor, status, created_by, cat_event_id, details)
         values ($1,$2,$3,$4,$5,$6,$7,$7,'NOTIFIED',$8,$9,$10) returning id`,
        [ctx.tenantId, ref, b.contractId, b.description ?? null, b.lossDate ?? null, b.currency, gross.amount, ctx.userId, b.catEventId ?? null, JSON.stringify(b.details ?? {})],
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

        // Notify claims team when a case reserve is set for the first time (status RESERVED).
        if (newStatus === 'RESERVED') {
          await notify(db, ctx.tenantId, {
            userId: ctx.userId,
            title: 'Claim reserved',
            body: `A case reserve has been set on claim ${req.params.id}.${b.reason ? ` Reason: ${b.reason}` : ''}`,
            kind: 'CLAIM',
            severity: 'INFO',
            link: `/claims/${req.params.id}`,
            entityType: 'claim',
            entityId: req.params.id,
          });
        }

        return updated.rows[0];
      });
    },
  );

  // --- Catastrophe / occurrence events (market event coding for FNOL) --------
  app.get('/api/claims/cat-events', { preHandler: requirePermission('claims:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, event_code as "eventCode", name, peril, region,
                to_char(event_date, 'YYYY-MM-DD') as "eventDate", status
           from cat_event order by event_date desc nulls last, created_at desc`,
      );
      return { events: rows };
    });
  });

  const createCatEventSchema = z.object({
    eventCode: z.string().min(1),
    name: z.string().min(1),
    peril: z.string().optional(),
    region: z.string().optional(),
    eventDate: z.string().optional(),
  });

  app.post('/api/claims/cat-events', { preHandler: requirePermission('claims:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createCatEventSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid cat event', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into cat_event (tenant_id, event_code, name, peril, region, event_date)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, b.eventCode, b.name, b.peril ?? null, b.region ?? null, b.eventDate ?? null],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'cat_event', entityId: id,
        after: { eventCode: b.eventCode, name: b.name, peril: b.peril }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, eventCode: b.eventCode, name: b.name };
    });
  });
}
