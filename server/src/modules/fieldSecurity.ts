/**
 * Field-level security (brief §14 - RLS/FLS). Manages column-masking policies and
 * enforces them: the `/api/fls/parties/:id` read returns a party with sensitive
 * fields masked per the caller's permissions (a working demonstration that the
 * pure @rios/domain applyMasking engine is wired to a real read, not just a
 * config screen). Policies are viewable to any authenticated user; authoring
 * needs fls:write. Masking decisions never trust the client - they use the
 * server-verified JWT permissions.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyMasking, maskedFieldsFor, type FieldPolicy, type FieldSecurityPolicy } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const securityPolicySchema = z.object({
  entity: z.string().min(1),
  field: z.string().min(1),
  maskStrategy: z.enum(['FULL', 'PARTIAL', 'HASH', 'REDACT']).default('FULL'),
  minPermission: z.string().min(1),
  active: z.boolean().default(true),
});

const policySchema = z.object({
  entityType: z.string().min(1),
  field: z.string().min(1),
  classification: z.string().default('PII'),
  requiredPermission: z.string().min(1),
  strategy: z.enum(['redact', 'partial', 'hash', 'none']).default('redact'),
  active: z.boolean().default(true),
});

/** Load the active field policies for an entity type. */
async function policiesFor(db: Db, entityType: string): Promise<FieldPolicy[]> {
  const { rows } = await db.query(
    `select field, required_permission as "requiredPermission", strategy
       from field_policy where entity_type = $1 and active`,
    [entityType],
  );
  return rows as FieldPolicy[];
}

export async function fieldSecurityModule(app: FastifyInstance): Promise<void> {
  app.get('/api/fls/policies', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, entity_type as "entityType", field, classification,
                required_permission as "requiredPermission", strategy, active
           from field_policy order by entity_type, field`,
      );
      return { policies: rows };
    });
  });

  app.post('/api/fls/policies', { preHandler: requirePermission('fls:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid policy', details: parsed.error.flatten() };
    }
    const p = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into field_policy (tenant_id, entity_type, field, classification, required_permission, strategy, active)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, entity_type, field) do update set
           classification = excluded.classification, required_permission = excluded.required_permission,
           strategy = excluded.strategy, active = excluded.active
         returning id`,
        [ctx.tenantId, p.entityType, p.field, p.classification, p.requiredPermission, p.strategy, p.active],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'field_policy', entityId: rows[0]!.id,
        after: { entityType: p.entityType, field: p.field, strategy: p.strategy }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // A party read with field-level security applied - masking enforced server-side
  // from the caller's verified permissions.
  app.get<{ Params: { id: string } }>(
    '/api/fls/parties/:id',
    { preHandler: requirePermission('party:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const perms = req.auth?.permissions ?? [];
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, reference, legal_name as "legalName", short_name as "shortName",
                  kind, country, identifiers
             from party where id = $1 and not is_deleted`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Party not found' };
        }
        const policies = await policiesFor(db, 'party');
        const { record, maskedFields } = applyMasking(rows[0] as Record<string, unknown>, policies, perms);
        return { party: record, maskedFields };
      });
    },
  );

  // ── Enforced field-security policy store (0071) ────────────────────────────
  // The active masking config applied to real reads (e.g. GET /api/parties/:id).
  // Distinct from the legacy /api/fls demonstration path above.

  app.get('/api/field-security/policies', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, entity, field, mask_strategy as "maskStrategy",
                min_permission as "minPermission", active,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') as "createdAt"
           from field_security_policy order by entity, field`,
      );
      return { policies: rows };
    });
  });

  app.post('/api/field-security/policies', { preHandler: requirePermission('fls:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = securityPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid policy', details: parsed.error.flatten() };
    }
    const p = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into field_security_policy (tenant_id, entity, field, mask_strategy, min_permission, active)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, entity, field) do update set
           mask_strategy = excluded.mask_strategy, min_permission = excluded.min_permission,
           active = excluded.active
         returning id`,
        [ctx.tenantId, p.entity, p.field, p.maskStrategy, p.minPermission, p.active],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'field_security_policy', entityId: rows[0]!.id,
        after: { entity: p.entity, field: p.field, maskStrategy: p.maskStrategy, minPermission: p.minPermission, active: p.active },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/field-security/policies/:id/deactivate',
    { preHandler: requirePermission('fls:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `update field_security_policy set active = false where id = $1 returning id`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Policy not found' };
        }
        await writeAudit(db, ctx, {
          action: 'deactivate', entityType: 'field_security_policy', entityId: rows[0].id,
          after: { active: false }, actorLabel: req.auth?.displayName,
        });
        return { id: rows[0].id, active: false };
      });
    },
  );

  // What the current caller would see masked for an entity, given their JWT
  // permissions - a self-service "why is this hidden?" view. Never trusts the client.
  app.get<{ Querystring: { entity?: string } }>(
    '/api/field-security/effective',
    { preHandler: requirePermission() },
    async (req, reply) => {
      const entity = req.query.entity;
      if (!entity) {
        reply.code(400);
        return { error: 'entity query parameter is required' };
      }
      const ctx = authContext(req);
      const perms = req.auth?.permissions ?? [];
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select entity, field, mask_strategy as "maskStrategy", min_permission as "minPermission", active
             from field_security_policy where entity = $1 and active`,
          [entity],
        );
        const masked = maskedFieldsFor(entity, rows as FieldSecurityPolicy[], perms);
        return { entity, maskedFields: masked };
      });
    },
  );
}
