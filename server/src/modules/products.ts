/**
 * Product lifecycle management (brief §14 - insurance-product factory). Versioned
 * insurance products driven through the canonical lifecycle. Transitions are
 * validated by the pure @rios/domain interpreter (applyEvent over
 * PRODUCT_LIFECYCLE), re-checking the caller's permissions - so an illegal or
 * unauthorised transition is refused the same way the workflow designer enforces
 * it. product:read to view, product:write to author/transition; audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRODUCT_LIFECYCLE, applyEvent, availableTransitions } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const productSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  lineOfBusiness: z.string().optional(),
  definition: z.record(z.unknown()).default({}),
});

export async function productsModule(app: FastifyInstance): Promise<void> {
  // List products, annotating each with the lifecycle actions available from its state.
  app.get('/api/products', { preHandler: requirePermission('product:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, code, name, line_of_business as "lineOfBusiness", version, status, definition,
                updated_at as "updatedAt"
           from insurance_product order by code, version desc`,
      );
      const products = rows.map((p) => ({
        ...p,
        actions: availableTransitions(PRODUCT_LIFECYCLE, p.status).map((t) => ({ event: t.event, to: t.to, label: t.label })),
      }));
      return { products, lifecycle: PRODUCT_LIFECYCLE };
    });
  });

  app.post('/api/products', { preHandler: requirePermission('product:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid product', details: parsed.error.flatten() };
    }
    const p = parsed.data;
    return runAs(ctx, async (db) => {
      // New version = max existing + 1 for this code (starts in DRAFT).
      const v = await db.query<{ v: number }>(
        `select coalesce(max(version),0)+1 as v from insurance_product where code = $1`, [p.code],
      );
      const { rows } = await db.query<{ id: string }>(
        `insert into insurance_product (tenant_id, code, name, line_of_business, version, status, definition, created_by)
         values ($1,$2,$3,$4,$5,'DRAFT',$6,$7) returning id`,
        [ctx.tenantId, p.code, p.name, p.lineOfBusiness ?? null, v.rows[0]!.v, JSON.stringify(p.definition), ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'insurance_product', entityId: rows[0]!.id,
        after: { code: p.code, version: v.rows[0]!.v }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, version: v.rows[0]!.v, status: 'DRAFT' };
    });
  });

  // Drive a lifecycle transition, validated by the pure interpreter.
  app.post<{ Params: { id: string }; Body: { event: string } }>(
    '/api/products/:id/transition',
    { preHandler: requirePermission('product:read') }, // fine-grained perm is enforced by the transition itself
    async (req, reply) => {
      const ctx = authContext(req);
      const event = req.body?.event;
      const perms = req.auth?.permissions ?? [];
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(`select status from insurance_product where id = $1`, [req.params.id]);
        if (!cur.rows[0]) { reply.code(404); return { error: 'Product not found' }; }
        const result = applyEvent(PRODUCT_LIFECYCLE, cur.rows[0].status, String(event), perms);
        if (!result.ok) {
          reply.code(result.reason?.startsWith('Missing permission') ? 403 : 409);
          return { error: result.reason };
        }
        await db.query(`update insurance_product set status = $2, updated_at = now() where id = $1`, [req.params.id, result.state]);
        await writeAudit(db, ctx, {
          action: 'transition', entityType: 'insurance_product', entityId: req.params.id,
          before: { status: cur.rows[0].status }, after: { status: result.state, event },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: result.state };
      });
    },
  );
}
