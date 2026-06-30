/**
 * Procurement module (brief §9.14 - vendors, requisitions, purchase orders).
 * A requisition is raised, submitted, then turned into a purchase order whose
 * lines compute money via @rios/domain. Orders move through a validated
 * lifecycle (draft → issued → received → closed, plus cancellation).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { fromMajor } from '@rios/domain';
import { nextReference } from './parties.js';

const PO_TRANSITIONS: Record<string, string[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['received', 'cancelled'],
  received: ['closed'],
  closed: [],
  cancelled: [],
};

const createVendorSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  email: z.string().optional(),
  partyId: z.string().uuid().optional(),
});

const createRequisitionSchema = z.object({
  departmentId: z.string().uuid().optional(),
  description: z.string().min(1),
  currency: z.string().length(3).optional(),
  total: z.number().nonnegative().optional(),
});

const createOrderSchema = z.object({
  vendorId: z.string().uuid(),
  requisitionId: z.string().uuid().optional(),
  currency: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative(),
      }),
    )
    .min(1),
});

const transitionSchema = z.object({
  to: z.enum(['issued', 'received', 'closed', 'cancelled']),
});

export async function procurementModule(app: FastifyInstance): Promise<void> {
  // --- Vendors ---------------------------------------------------------------
  app.get('/api/procurement/vendors', { preHandler: requirePermission('procurement:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select v.id, v.code, v.name, v.category, v.email, v.party_id as "partyId", v.status
           from vendor v
          order by v.name`,
      );
      return { vendors: rows };
    });
  });

  app.post('/api/procurement/vendors', { preHandler: requirePermission('procurement:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid vendor', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into vendor (tenant_id, code, name, category, email, party_id)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, b.code, b.name, b.category ?? null, b.email ?? null, b.partyId ?? null],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'vendor',
        entityId: id,
        after: { code: b.code, name: b.name },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, code: b.code };
    });
  });

  // --- Requisitions ----------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>(
    '/api/procurement/requisitions',
    { preHandler: requirePermission('procurement:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select r.id, r.reference, r.department_id as "departmentId", r.requested_by as "requestedBy",
                  r.description, r.currency, r.total_minor as "totalMinor", r.status
             from purchase_requisition r
            where ($1::text is null or r.status = $1)
            order by r.created_at desc`,
          [req.query.status ?? null],
        );
        return { requisitions: rows };
      });
    },
  );

  app.post('/api/procurement/requisitions', { preHandler: requirePermission('procurement:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createRequisitionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid requisition', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const currency = b.currency ?? 'USD';
    const totalMinor = b.total !== undefined ? fromMajor(b.total, currency).amount : 0;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'requisition_reference', 'REQ');
      const { rows } = await db.query<{ id: string }>(
        `insert into purchase_requisition
           (tenant_id, reference, department_id, requested_by, description, currency, total_minor, status)
         values ($1,$2,$3,$4,$5,$6,$7,'draft') returning id`,
        [ctx.tenantId, ref, b.departmentId ?? null, ctx.userId, b.description, currency, totalMinor],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'purchase_requisition',
        entityId: id,
        after: { reference: ref, totalMinor, status: 'draft' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, reference: ref, status: 'draft' };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/procurement/requisitions/:id/submit',
    { preHandler: requirePermission('procurement:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(
          `select status from purchase_requisition where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Requisition not found' };
        }
        if (cur.rows[0].status !== 'draft') {
          reply.code(409);
          return { error: `Requisition is ${cur.rows[0].status}, not draft` };
        }
        await db.query(`update purchase_requisition set status = 'submitted' where id = $1`, [req.params.id]);
        await writeAudit(db, ctx, {
          action: 'submit',
          entityType: 'purchase_requisition',
          entityId: req.params.id,
          before: { status: 'draft' },
          after: { status: 'submitted' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'submitted' };
      });
    },
  );

  // --- Purchase orders -------------------------------------------------------
  app.get<{ Querystring: { status?: string; vendorId?: string } }>(
    '/api/procurement/orders',
    { preHandler: requirePermission('procurement:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select po.id, po.reference, po.vendor_id as "vendorId", po.requisition_id as "requisitionId",
                  po.currency, po.total_minor as "totalMinor", po.order_date as "orderDate", po.status,
                  v.name as "vendorName"
             from purchase_order po
             left join vendor v on v.id = po.vendor_id
            where ($1::text is null or po.status = $1)
              and ($2::uuid is null or po.vendor_id = $2)
            order by po.created_at desc`,
          [req.query.status ?? null, req.query.vendorId ?? null],
        );
        return { orders: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/procurement/orders/:id',
    { preHandler: requirePermission('procurement:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select po.id, po.reference, po.vendor_id as "vendorId", po.requisition_id as "requisitionId",
                  po.currency, po.total_minor as "totalMinor", po.order_date as "orderDate", po.status,
                  po.created_by as "createdBy", v.name as "vendorName"
             from purchase_order po
             left join vendor v on v.id = po.vendor_id
            where po.id = $1`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Purchase order not found' };
        }
        const lines = await db.query(
          `select id, line_no as "lineNo", description, quantity,
                  unit_price_minor as "unitPriceMinor", line_total_minor as "lineTotalMinor", currency
             from purchase_order_line where po_id = $1 order by line_no`,
          [req.params.id],
        );
        return { ...rows[0], lines: lines.rows };
      });
    },
  );

  app.post('/api/procurement/orders', { preHandler: requirePermission('procurement:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid purchase order', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const currency = b.currency ?? 'USD';
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'po_reference', 'PO');
      const { rows } = await db.query<{ id: string }>(
        `insert into purchase_order
           (tenant_id, reference, vendor_id, requisition_id, currency, total_minor, status, created_by)
         values ($1,$2,$3,$4,$5,0,'draft',$6) returning id`,
        [ctx.tenantId, ref, b.vendorId, b.requisitionId ?? null, currency, ctx.userId],
      );
      const id = rows[0]!.id;

      let totalMinor = 0;
      let lineNo = 1;
      for (const line of b.lines) {
        const unitPriceMinor = fromMajor(line.unitPrice, currency).amount;
        const lineTotalMinor = fromMajor(line.unitPrice * line.quantity, currency).amount;
        totalMinor += lineTotalMinor;
        await db.query(
          `insert into purchase_order_line
             (tenant_id, po_id, line_no, description, quantity, unit_price_minor, line_total_minor, currency)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [ctx.tenantId, id, lineNo, line.description, line.quantity, unitPriceMinor, lineTotalMinor, currency],
        );
        lineNo += 1;
      }
      await db.query(`update purchase_order set total_minor = $2 where id = $1`, [id, totalMinor]);

      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'purchase_order',
        entityId: id,
        after: { reference: ref, totalMinor, status: 'draft' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, reference: ref, totalMinor };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/procurement/orders/:id/transition',
    { preHandler: requirePermission('procurement:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = transitionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid transition', details: parsed.error.flatten() };
      }
      const to = parsed.data.to;
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(
          `select status from purchase_order where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Purchase order not found' };
        }
        const from = cur.rows[0].status;
        const allowed = PO_TRANSITIONS[from] ?? [];
        if (!allowed.includes(to)) {
          reply.code(409);
          return { error: `Illegal transition ${from} → ${to}. Allowed: ${allowed.join(', ') || 'none'}` };
        }
        await db.query(`update purchase_order set status = $2 where id = $1`, [req.params.id, to]);
        await writeAudit(db, ctx, {
          action: 'transition',
          entityType: 'purchase_order',
          entityId: req.params.id,
          before: { status: from },
          after: { status: to },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: to };
      });
    },
  );
}
