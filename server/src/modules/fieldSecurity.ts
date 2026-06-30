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
import { applyMasking, type FieldPolicy } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

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
}
