/**
 * Platform & org administration (brief §9.1): multi-company, branch/office, and
 * feature/license flags. Tenant-isolated via runAs; mutations audited.
 * platform:read to view, platform:write to manage.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/**
 * Resolved entitlement for a single key. `configured` is false when neither an
 * override nor the tenant's plan defines the key - callers MUST treat that as
 * "no restriction" so enforcement stays behaviour-preserving. `source` records
 * the winning layer: override > plan > (unset).
 */
export interface ResolvedEntitlement {
  key: string;
  kind: 'FLAG' | 'LIMIT' | null;
  configured: boolean;
  flag: boolean | null;
  limit: number | null;
  source: 'override' | 'plan' | null;
}

/**
 * Resolve one entitlement for a tenant with precedence override > plan > unset.
 * Reusable by other modules to gate features/limits. Must run inside runAs()
 * (RLS scopes plan/entitlement/override rows to the tenant + global plans).
 */
export async function resolveEntitlement(db: Db, key: string): Promise<ResolvedEntitlement> {
  const ov = await db.query<{ kind: 'FLAG' | 'LIMIT'; bool_value: boolean | null; limit_value: string | null }>(
    `select kind, bool_value, limit_value from tenant_entitlement_override where key = $1`,
    [key],
  );
  if (ov.rows[0]) {
    const r = ov.rows[0];
    return {
      key, kind: r.kind, configured: true, source: 'override',
      flag: r.bool_value, limit: r.limit_value === null ? null : Number(r.limit_value),
    };
  }
  const pl = await db.query<{ kind: 'FLAG' | 'LIMIT'; bool_value: boolean | null; limit_value: string | null }>(
    `select e.kind, e.bool_value, e.limit_value
       from tenant_plan tp
       join entitlement e on e.plan_id = tp.plan_id and e.key = $1
      limit 1`,
    [key],
  );
  if (pl.rows[0]) {
    const r = pl.rows[0];
    return {
      key, kind: r.kind, configured: true, source: 'plan',
      flag: r.bool_value, limit: r.limit_value === null ? null : Number(r.limit_value),
    };
  }
  return { key, kind: null, configured: false, flag: null, limit: null, source: null };
}

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
      // Entitlement enforcement: block only NEW companies past a configured
      // platform.maxCompanies limit. Unconfigured => no restriction (upserts of
      // an existing code are updates, never counted against the limit).
      const ent = await resolveEntitlement(db, 'platform.maxCompanies');
      if (ent.configured && ent.limit !== null) {
        const exists = await db.query(`select 1 from company where code = $1`, [c.code]);
        if (exists.rowCount === 0) {
          const { rows: cnt } = await db.query<{ n: string }>(`select count(*)::text as n from company`);
          if (Number(cnt[0]!.n) >= ent.limit) {
            reply.code(409);
            return { error: 'Entitlement limit reached', key: 'platform.maxCompanies', limit: ent.limit };
          }
        }
      }
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

  // =========================================================================
  // Entitlement engine (0073): plan catalog, typed entitlements, tenant->plan
  // assignment and per-tenant overrides. Resolution precedence is
  // override > plan > unset; unset means "no restriction".
  // =========================================================================
  const planSchema = z.object({ code: z.string().min(1), name: z.string().min(1) });
  const entitlementSchema = z.object({
    key: z.string().min(1),
    kind: z.enum(['FLAG', 'LIMIT']),
    boolValue: z.boolean().nullable().optional(),
    limitValue: z.number().int().nonnegative().nullable().optional(),
  });
  const assignSchema = z.object({ planId: z.string().uuid() });

  // List plans visible to the tenant (own + global catalog) with entitlements.
  app.get('/api/platform/plans', { preHandler: requirePermission('platform:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows: plans } = await db.query<{ id: string; code: string; name: string; isGlobal: boolean }>(
        `select id, code, name, tenant_id is null as "isGlobal" from plan order by code`,
      );
      const { rows: ents } = await db.query<{ planId: string; key: string; kind: string; boolValue: boolean | null; limitValue: string | null }>(
        `select plan_id as "planId", key, kind, bool_value as "boolValue", limit_value::text as "limitValue" from entitlement order by key`,
      );
      return {
        plans: plans.map((p) => ({
          ...p,
          entitlements: ents
            .filter((e) => e.planId === p.id)
            .map((e) => ({ ...e, limitValue: e.limitValue === null ? null : Number(e.limitValue) })),
        })),
      };
    });
  });

  // Create a tenant-scoped plan.
  app.post('/api/platform/plans', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid plan', details: parsed.error.flatten() }; }
    const p = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into plan (tenant_id, code, name) values ($1,$2,$3)
         on conflict (tenant_id, code) do update set name = excluded.name
         returning id`,
        [ctx.tenantId, p.code, p.name],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'plan', entityId: rows[0]!.id, after: { code: p.code }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Set (upsert) an entitlement on a plan the tenant owns.
  app.post<{ Params: { planId: string } }>('/api/platform/plans/:planId/entitlements', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = entitlementSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid entitlement', details: parsed.error.flatten() }; }
    const e = parsed.data;
    return runAs(ctx, async (db) => {
      const owns = await db.query(`select 1 from plan where id = $1 and tenant_id = $2`, [req.params.planId, ctx.tenantId]);
      if (owns.rowCount === 0) { reply.code(404); return { error: 'Plan not found' }; }
      const { rows } = await db.query<{ id: string }>(
        `insert into entitlement (plan_id, tenant_id, key, kind, bool_value, limit_value)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (plan_id, key) do update set
           kind = excluded.kind, bool_value = excluded.bool_value, limit_value = excluded.limit_value
         returning id`,
        [req.params.planId, ctx.tenantId, e.key, e.kind, e.boolValue ?? null, e.limitValue ?? null],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'entitlement', entityId: rows[0]!.id, after: { key: e.key, kind: e.kind }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Assign a plan (own or global) to the current tenant.
  app.post('/api/platform/tenant-plan', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid assignment', details: parsed.error.flatten() }; }
    return runAs(ctx, async (db) => {
      const seen = await db.query(`select 1 from plan where id = $1`, [parsed.data.planId]);
      if (seen.rowCount === 0) { reply.code(404); return { error: 'Plan not found' }; }
      await db.query(
        `insert into tenant_plan (tenant_id, plan_id) values ($1,$2)
         on conflict (tenant_id) do update set plan_id = excluded.plan_id, assigned_at = now()`,
        [ctx.tenantId, parsed.data.planId],
      );
      await writeAudit(db, ctx, { action: 'assign', entityType: 'tenant_plan', entityId: parsed.data.planId, after: { planId: parsed.data.planId }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { ok: true };
    });
  });

  // Set (upsert) a per-tenant override for a single entitlement.
  app.post('/api/platform/entitlement-overrides', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = entitlementSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid override', details: parsed.error.flatten() }; }
    const e = parsed.data;
    return runAs(ctx, async (db) => {
      await db.query(
        `insert into tenant_entitlement_override (tenant_id, key, kind, bool_value, limit_value)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, key) do update set
           kind = excluded.kind, bool_value = excluded.bool_value, limit_value = excluded.limit_value`,
        [ctx.tenantId, e.key, e.kind, e.boolValue ?? null, e.limitValue ?? null],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'entitlement_override', entityId: null, after: { key: e.key, kind: e.kind }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { ok: true };
    });
  });

  // Remove a per-tenant override (falls back to the plan/unset resolution).
  app.delete<{ Params: { key: string } }>('/api/platform/entitlement-overrides/:key', { preHandler: requirePermission('platform:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      await db.query(`delete from tenant_entitlement_override where key = $1`, [req.params.key]);
      await writeAudit(db, ctx, { action: 'delete', entityType: 'entitlement_override', entityId: null, after: { key: req.params.key }, actorLabel: req.auth?.displayName });
      reply.code(200);
      return { ok: true };
    });
  });

  // EFFECTIVE entitlements for the current tenant (override > plan), resolved.
  app.get('/api/features/entitlements', { preHandler: requirePermission('platform:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows: keys } = await db.query<{ key: string }>(
        `select e.key from tenant_plan tp join entitlement e on e.plan_id = tp.plan_id
         union
         select key from tenant_entitlement_override`,
      );
      const entitlements = [];
      for (const { key } of keys) entitlements.push(await resolveEntitlement(db, key));
      return { entitlements };
    });
  });

  // Resolve a single flag/limit for the current tenant.
  app.get<{ Querystring: { key?: string } }>('/api/features/check', { preHandler: requirePermission() }, async (req, reply) => {
    const key = req.query.key;
    if (!key) { reply.code(400); return { error: 'key query parameter is required' }; }
    const ctx = authContext(req);
    return runAs(ctx, async (db) => resolveEntitlement(db, key));
  });

  // =========================================================================
  // Dashboard designer (0077): no-code personal / shared dashboards composed of
  // KPI + chart tiles chosen from the LIVE /api/executive packs. Tiles are
  // opaque references (persona, kind, ref, size) resolved against live data on
  // the client, so no metric value is persisted or faked here. Personal layouts
  // belong to the caller; a shared (tenant-wide) layout needs platform:write.
  // =========================================================================
  const tileSchema = z.object({
    persona: z.string().min(1),
    kind: z.enum(['kpi', 'chart']),
    ref: z.string().min(1),
    size: z.enum(['sm', 'md', 'lg']).default('md'),
  });
  const layoutSchema = z.object({
    name: z.string().min(1).max(120),
    tiles: z.array(tileSchema).max(60),
    isDefault: z.boolean().default(false),
    shared: z.boolean().default(false),
  });
  const canShare = (req: { auth?: { permissions: string[] } }) =>
    !!req.auth && (req.auth.permissions.includes('platform:write') || req.auth.permissions.includes('admin:manage'));

  // List the caller's own layouts plus any tenant-wide shared ones.
  app.get('/api/dashboards/layouts', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, tiles, is_default as "isDefault",
                user_id is null as shared, coalesce(user_id = $1, false) as owned, created_at as "createdAt"
           from dashboard_layout
          where user_id = $1 or user_id is null
          order by is_default desc, user_id is null, created_at`,
        [ctx.userId],
      );
      return { layouts: rows };
    });
  });

  // Save (upsert by owner scope + name) a composed layout. Shared needs platform:write.
  app.post('/api/dashboards/layouts', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = layoutSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid layout', details: parsed.error.flatten() }; }
    const l = parsed.data;
    if (l.shared && !canShare(req)) { reply.code(403); return { error: 'Missing permission: platform:write' }; }
    const owner = l.shared ? null : ctx.userId;
    const tilesJson = JSON.stringify(l.tiles);
    return runAs(ctx, async (db) => {
      // Exactly one default per owner scope: clear siblings before setting.
      if (l.isDefault) {
        await db.query(
          `update dashboard_layout set is_default = false
            where tenant_id = $1 and user_id is not distinct from $2`,
          [ctx.tenantId, owner],
        );
      }
      const { rows } = await db.query<{ id: string }>(
        owner === null
          ? `insert into dashboard_layout (tenant_id, user_id, name, tiles, is_default)
             values ($1, null, $2, $3::jsonb, $4)
             on conflict (tenant_id, name) where user_id is null
             do update set tiles = excluded.tiles, is_default = excluded.is_default
             returning id`
          : `insert into dashboard_layout (tenant_id, user_id, name, tiles, is_default)
             values ($1, $2, $3, $4::jsonb, $5)
             on conflict (tenant_id, user_id, name) where user_id is not null
             do update set tiles = excluded.tiles, is_default = excluded.is_default
             returning id`,
        owner === null
          ? [ctx.tenantId, l.name, tilesJson, l.isDefault]
          : [ctx.tenantId, owner, l.name, tilesJson, l.isDefault],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'dashboard_layout', entityId: rows[0]!.id,
        after: { name: l.name, shared: l.shared, tiles: l.tiles.length, isDefault: l.isDefault },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Delete a layout: own personal ones freely; shared ones need platform:write.
  app.delete<{ Params: { id: string } }>('/api/dashboards/layouts/:id', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ user_id: string | null }>(
        `select user_id from dashboard_layout where id = $1`, [req.params.id],
      );
      if (!rows[0]) { reply.code(404); return { error: 'Layout not found' }; }
      if (rows[0].user_id === null && !canShare(req)) { reply.code(403); return { error: 'Missing permission: platform:write' }; }
      if (rows[0].user_id !== null && rows[0].user_id !== ctx.userId) { reply.code(403); return { error: 'Not your layout' }; }
      await db.query(`delete from dashboard_layout where id = $1`, [req.params.id]);
      await writeAudit(db, ctx, {
        action: 'delete', entityType: 'dashboard_layout', entityId: req.params.id,
        actorLabel: req.auth?.displayName,
      });
      reply.code(200);
      return { ok: true };
    });
  });
}
