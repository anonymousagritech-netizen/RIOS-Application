/**
 * Platform & org administration (brief §9.1): multi-company, branch/office, and
 * feature/license flags. Tenant-isolated via runAs; mutations audited.
 * platform:read to view, platform:write to manage.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const companySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  country: z.string().length(2).optional(),
  baseCurrency: z.string().length(3).optional(),
  parentId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'dormant', 'closed']).default('active'),
});

const officeSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  code: z.string().min(1),
  name: z.string().min(1),
  city: z.string().optional(),
  country: z.string().length(2).optional(),
  isHeadOffice: z.boolean().default(false),
  status: z.enum(['open', 'closed']).default('open'),
});

const flagSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(false),
  seatLimit: z.number().int().nonnegative().nullable().optional(),
  plan: z.string().nullable().optional(),
});

export async function platformModule(app: FastifyInstance): Promise<void> {
  // --- Companies ---
  app.get('/api/platform/companies', { preHandler: requirePermission('platform:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select c.id, c.code, c.name, c.country, c.base_currency as "baseCurrency",
                c.parent_id as "parentId", p.name as "parentName", c.status
           from company c left join company p on p.id = c.parent_id
          order by c.code`,
      );
      return { companies: rows };
    });
  });

  app.post('/api/platform/companies', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = companySchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid company', details: parsed.error.flatten() }; }
    const c = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into company (tenant_id, code, name, country, base_currency, parent_id, status)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, code) do update set
           name = excluded.name, country = excluded.country, base_currency = excluded.base_currency,
           parent_id = excluded.parent_id, status = excluded.status
         returning id`,
        [ctx.tenantId, c.code, c.name, c.country ?? null, c.baseCurrency ?? null, c.parentId ?? null, c.status],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'company', entityId: rows[0]!.id, after: { code: c.code }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // --- Offices ---
  app.get('/api/platform/offices', { preHandler: requirePermission('platform:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select o.id, o.code, o.name, o.city, o.country, o.is_head_office as "isHeadOffice",
                o.status, o.company_id as "companyId", c.name as "companyName"
           from office o left join company c on c.id = o.company_id
          order by o.code`,
      );
      return { offices: rows };
    });
  });

  app.post('/api/platform/offices', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = officeSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid office', details: parsed.error.flatten() }; }
    const o = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into office (tenant_id, company_id, code, name, city, country, is_head_office, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id, code) do update set
           company_id = excluded.company_id, name = excluded.name, city = excluded.city,
           country = excluded.country, is_head_office = excluded.is_head_office, status = excluded.status
         returning id`,
        [ctx.tenantId, o.companyId ?? null, o.code, o.name, o.city ?? null, o.country ?? null, o.isHeadOffice, o.status],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'office', entityId: rows[0]!.id, after: { code: o.code }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // --- Feature & license flags ---
  app.get('/api/platform/features', { preHandler: requirePermission('platform:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, key, name, enabled, seat_limit as "seatLimit", plan, updated_at as "updatedAt"
           from feature_flag order by key`,
      );
      return { features: rows };
    });
  });

  app.post('/api/platform/features', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = flagSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid feature flag', details: parsed.error.flatten() }; }
    const f = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into feature_flag (tenant_id, key, name, enabled, seat_limit, plan, updated_at)
         values ($1,$2,$3,$4,$5,$6, now())
         on conflict (tenant_id, key) do update set
           name = excluded.name, enabled = excluded.enabled, seat_limit = excluded.seat_limit,
           plan = excluded.plan, updated_at = now()
         returning id`,
        [ctx.tenantId, f.key, f.name, f.enabled, f.seatLimit ?? null, f.plan ?? null],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'feature_flag', entityId: rows[0]!.id, after: { key: f.key, enabled: f.enabled }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // A lightweight feature check any authenticated caller can use.
  app.get<{ Params: { key: string } }>('/api/platform/features/:key/enabled', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ enabled: boolean }>(`select enabled from feature_flag where key = $1`, [req.params.key]);
      return { key: req.params.key, enabled: rows[0]?.enabled ?? false };
    });
  });
}
