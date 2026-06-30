/**
 * Data retention & legal hold (brief §14). Manages retention policies (per
 * entity type) and legal holds, and evaluates a record's disposition via the
 * pure @rios/domain engine (retentionVerdict) — a hold always overrides a
 * policy. retention:read to view, retention:write to author; mutations audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { retentionVerdict, hasActiveHold, ageInDays, type LegalHold } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const policySchema = z.object({
  entityType: z.string().min(1),
  retentionDays: z.number().int().nonnegative(),
  action: z.enum(['archive', 'purge']).default('archive'),
  active: z.boolean().default(true),
  note: z.string().optional(),
});

const holdSchema = z.object({
  name: z.string().min(1),
  reason: z.string().optional(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
});

const evalSchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid().optional(),
  recordedAt: z.string(),
});

export async function retentionModule(app: FastifyInstance): Promise<void> {
  app.get('/api/retention/policies', { preHandler: requirePermission('retention:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, entity_type as "entityType", retention_days as "retentionDays",
                action, active, note
           from retention_policy order by entity_type`,
      );
      return { policies: rows };
    });
  });

  app.post('/api/retention/policies', { preHandler: requirePermission('retention:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid policy', details: parsed.error.flatten() };
    }
    const p = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into retention_policy (tenant_id, entity_type, retention_days, action, active, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, entity_type) do update set
           retention_days = excluded.retention_days, action = excluded.action,
           active = excluded.active, note = excluded.note
         returning id`,
        [ctx.tenantId, p.entityType, p.retentionDays, p.action, p.active, p.note ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'retention_policy', entityId: rows[0]!.id,
        after: { entityType: p.entityType, retentionDays: p.retentionDays }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  app.get('/api/retention/holds', { preHandler: requirePermission('retention:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, reason, entity_type as "entityType", entity_id as "entityId",
                active, placed_at as "placedAt", released_at as "releasedAt"
           from legal_hold order by active desc, placed_at desc`,
      );
      return { holds: rows };
    });
  });

  app.post('/api/retention/holds', { preHandler: requirePermission('retention:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = holdSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid legal hold', details: parsed.error.flatten() };
    }
    const h = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into legal_hold (tenant_id, name, reason, entity_type, entity_id, placed_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, h.name, h.reason ?? null, h.entityType ?? null, h.entityId ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'place_hold', entityType: 'legal_hold', entityId: rows[0]!.id,
        after: { name: h.name, entityType: h.entityType ?? null }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Release a hold (sets inactive + released_at).
  app.post<{ Params: { id: string } }>(
    '/api/retention/holds/:id/release',
    { preHandler: requirePermission('retention:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(
          `update legal_hold set active = false, released_at = now() where id = $1 and active`,
          [req.params.id],
        );
        if (!rowCount) {
          reply.code(404);
          return { error: 'Active hold not found' };
        }
        await writeAudit(db, ctx, {
          action: 'release_hold', entityType: 'legal_hold', entityId: req.params.id,
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, released: true };
      });
    },
  );

  // Evaluate a record's disposition against the policy + any active holds.
  app.post('/api/retention/evaluate', { preHandler: requirePermission('retention:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = evalSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid evaluation', details: parsed.error.flatten() };
    }
    const { entityType, entityId, recordedAt } = parsed.data;
    const recordedMs = Date.parse(recordedAt);
    if (Number.isNaN(recordedMs)) {
      reply.code(400);
      return { error: 'recordedAt must be a valid date' };
    }
    return runAs(ctx, async (db) => {
      const pol = await db.query<{ retention_days: number; action: string }>(
        `select retention_days, action from retention_policy where entity_type = $1 and active`,
        [entityType],
      );
      if (!pol.rows[0]) {
        return { entityType, hasPolicy: false, verdict: null };
      }
      const holdRows = await db.query<LegalHold>(
        `select entity_type as "entityType", entity_id as "entityId", active from legal_hold where active`,
      );
      const onHold = hasActiveHold(holdRows.rows, entityType, entityId);
      const ageDays = ageInDays(recordedMs, Date.now());
      const verdict = retentionVerdict(ageDays, pol.rows[0].retention_days, onHold);
      return { entityType, hasPolicy: true, action: pol.rows[0].action, verdict };
    });
  });
}
