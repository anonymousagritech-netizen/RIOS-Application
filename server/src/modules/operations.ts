/**
 * Operations / Observability module (brief §9.13).
 *
 * Surfaces real platform state rather than a synthetic metrics system: the
 * immutable-audit viewer (§14.3) reads audit_log, the event-delivery monitor
 * (§9.3) reads the outbox, and a Health & SLA dashboard manages sla_target and
 * rolls up RLS-scoped per-tenant counts.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { fromMajor } from '@rios/domain';

const createSlaSchema = z.object({
  service: z.string().min(1),
  metric: z.string().min(1),
  targetValue: z.number(),
  unit: z.string().optional(),
});

export async function operationsModule(app: FastifyInstance): Promise<void> {
  // --- Immutable-audit viewer (§14.3) ----------------------------------------
  app.get<{ Querystring: { entityType?: string; action?: string; limit?: string } }>(
    '/api/ops/audit',
    { preHandler: requirePermission('ops:read') },
    async (req) => {
      const ctx = authContext(req);
      const rawLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select occurred_at as "occurredAt", actor_label as "actorLabel", action,
                  entity_type as "entityType", entity_id as "entityId",
                  (row_hash is not null) as "tamperChainPresent"
             from audit_log
            where ($1::text is null or entity_type = $1)
              and ($2::text is null or action = $2)
            order by id desc
            limit $3`,
          [req.query.entityType ?? null, req.query.action ?? null, limit],
        );
        return { entries: rows };
      });
    },
  );

  // --- Event-delivery monitor (§9.3) -----------------------------------------
  app.get<{ Querystring: { status?: string } }>(
    '/api/ops/events',
    { preHandler: requirePermission('ops:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, topic, created_at as "createdAt", published_at as "publishedAt", attempts,
                  (case when published_at is not null then 'published' else 'pending' end) as status
             from outbox
            where ($1::text is null
                   or (case when published_at is not null then 'published' else 'pending' end) = $1)
            order by id desc`,
          [req.query.status ?? null],
        );
        return { events: rows };
      });
    },
  );

  // --- SLA targets ------------------------------------------------------------
  app.get('/api/ops/sla', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, service, metric, target_value as "targetValue", unit, created_at as "createdAt"
           from sla_target
          order by service, metric`,
      );
      return { slaTargets: rows };
    });
  });

  app.post('/api/ops/sla', { preHandler: requirePermission('ops:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createSlaSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid SLA target', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `insert into sla_target (tenant_id, service, metric, target_value, unit)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, service, metric) do update
           set target_value = excluded.target_value,
               unit = excluded.unit
         returning id, service, metric, target_value as "targetValue", unit`,
        [ctx.tenantId, b.service, b.metric, b.targetValue, b.unit ?? null],
      );
      await writeAudit(db, ctx, {
        action: 'upsert',
        entityType: 'sla_target',
        entityId: rows[0]!.id as string,
        after: { service: b.service, metric: b.metric, targetValue: b.targetValue },
        actorLabel: req.auth?.displayName,
      });
      return rows[0];
    });
  });

  // --- Health & SLA dashboard (§9.13) ----------------------------------------
  app.get('/api/ops/health', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        auditEvents: number;
        pendingEvents: number;
        openClaims: number;
        activeContracts: number;
        lastActivityAt: string | null;
        slaTargets: number;
      }>(
        `select
           (select count(*) from audit_log) as "auditEvents",
           (select count(*) from outbox where published_at is null) as "pendingEvents",
           (select count(*) from claim where status not in ('CLOSED','SETTLED') and not is_deleted) as "openClaims",
           (select count(*) from contract where status in ('BOUND','ACTIVE') and not is_deleted) as "activeContracts",
           (select max(occurred_at) from audit_log) as "lastActivityAt",
           (select count(*) from sla_target) as "slaTargets"`,
      );
      return rows[0];
    });
  });
}

// Keep fromMajor / Db referenced for parity with sibling modules.
void fromMajor;
export type { Db };
