/**
 * Asset & license inventory (brief §9.14) + per-tenant feature entitlements (§9.1).
 *
 * Assets and software licenses are tracked per tenant; licenses surface computed
 * seat availability and an expiry warning. The entitlement engine toggles a
 * feature per tenant WITHOUT a deploy (§9.1, §10.3) — the upsert is the proof.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { fromMajor } from '@rios/domain';

const createAssetSchema = z.object({
  tag: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  assignedTo: z.string().uuid().optional(),
  purchaseDate: z.string().optional(),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});

const assignAssetSchema = z.object({
  employeeId: z.string().uuid(),
});

const createLicenseSchema = z.object({
  name: z.string().min(1),
  vendor: z.string().optional(),
  seatsTotal: z.number().int().nonnegative(),
  expiryDate: z.string().optional(),
  cost: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});

const upsertEntitlementSchema = z.object({
  isEnabled: z.boolean(),
  plan: z.string().optional(),
  limitValue: z.number().int().nonnegative().optional(),
});

export async function assetsModule(app: FastifyInstance): Promise<void> {
  // --- Assets ----------------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>(
    '/api/assets',
    { preHandler: requirePermission('asset:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select a.id, a.tag, a.name, a.category, a.assigned_to as "assignedTo",
                  a.purchase_date as "purchaseDate", a.value_minor as "valueMinor",
                  a.currency, a.status,
                  (e.first_name || ' ' || e.last_name) as "assigneeName"
             from asset a
             left join employee e on e.id = a.assigned_to
            where ($1::text is null or a.status = $1)
            order by a.created_at desc`,
          [req.query.status ?? null],
        );
        return { assets: rows };
      });
    },
  );

  app.post('/api/assets', { preHandler: requirePermission('asset:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid asset', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const valueMinor = b.value !== undefined ? fromMajor(b.value, b.currency ?? 'USD').amount : null;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into asset
           (tenant_id, tag, name, category, assigned_to, purchase_date, value_minor, currency)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [
          ctx.tenantId, b.tag, b.name, b.category ?? null, b.assignedTo ?? null,
          b.purchaseDate ?? null, valueMinor, b.currency ?? null,
        ],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'asset',
        entityId: id,
        after: { tag: b.tag, name: b.name },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, tag: b.tag };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/assets/:id/assign',
    { preHandler: requirePermission('asset:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = assignAssetSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid assignment', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `update asset set assigned_to = $2, status = 'in_use' where id = $1 returning id`,
          [req.params.id, b.employeeId],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Asset not found' };
        }
        await writeAudit(db, ctx, {
          action: 'assign',
          entityType: 'asset',
          entityId: req.params.id,
          after: { assignedTo: b.employeeId, status: 'in_use' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, assignedTo: b.employeeId, status: 'in_use' };
      });
    },
  );

  // --- Software licenses ------------------------------------------------------
  app.get('/api/licenses', { preHandler: requirePermission('asset:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, vendor, seats_total as "seatsTotal", seats_used as "seatsUsed",
                (seats_total - seats_used) as "seatsAvailable",
                expiry_date as "expiryDate", cost_minor as "costMinor", currency, status,
                (expiry_date is not null and expiry_date <= current_date + interval '60 days') as "expiringSoon"
           from software_license
          order by created_at desc`,
      );
      return { licenses: rows };
    });
  });

  app.post('/api/licenses', { preHandler: requirePermission('asset:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createLicenseSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid license', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const costMinor = b.cost !== undefined ? fromMajor(b.cost, b.currency ?? 'USD').amount : null;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into software_license
           (tenant_id, name, vendor, seats_total, expiry_date, cost_minor, currency)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, b.name, b.vendor ?? null, b.seatsTotal, b.expiryDate ?? null, costMinor, b.currency ?? null],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'software_license',
        entityId: id,
        after: { name: b.name, seatsTotal: b.seatsTotal },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, name: b.name };
    });
  });

  // --- Feature entitlements (the entitlement engine, §9.1) --------------------
  app.get('/api/entitlements', { preHandler: requirePermission('asset:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, feature_key as "featureKey", is_enabled as "isEnabled", plan,
                limit_value as "limitValue", created_at as "createdAt"
           from feature_entitlement
          order by feature_key`,
      );
      return { entitlements: rows };
    });
  });

  app.put<{ Params: { featureKey: string } }>(
    '/api/entitlements/:featureKey',
    { preHandler: requirePermission('asset:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = upsertEntitlementSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid entitlement', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `insert into feature_entitlement (tenant_id, feature_key, is_enabled, plan, limit_value)
           values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, feature_key) do update
             set is_enabled = excluded.is_enabled,
                 plan = excluded.plan,
                 limit_value = excluded.limit_value
           returning id, feature_key as "featureKey", is_enabled as "isEnabled", plan,
                     limit_value as "limitValue"`,
          [ctx.tenantId, req.params.featureKey, b.isEnabled, b.plan ?? null, b.limitValue ?? null],
        );
        await writeAudit(db, ctx, {
          action: 'upsert',
          entityType: 'feature_entitlement',
          entityId: rows[0]!.id as string,
          after: { featureKey: req.params.featureKey, isEnabled: b.isEnabled, plan: b.plan ?? null },
          actorLabel: req.auth?.displayName,
        });
        return rows[0];
      });
    },
  );
}

// Keep the Db type referenced for parity with sibling modules.
export type { Db };
