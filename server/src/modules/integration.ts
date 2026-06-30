/**
 * Integration module (brief §17 - webhooks + data import/export).
 *
 * Webhook emission is outbox-style: emitting an event enqueues a pending
 * `webhook_delivery` per matching active subscription; an out-of-band worker
 * delivers them. This module never calls external URLs itself (§9.3).
 *
 * Export/import is constrained to an explicit entity → table/column allowlist so
 * no user-supplied identifier is ever interpolated into SQL - only fixed,
 * code-defined column lists reach the query text.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

interface EntityDef {
  table: string;
  columns: string[];
  required?: string[];
}

const ENTITIES: Record<string, EntityDef> = {
  parties: {
    table: 'party',
    columns: ['id', 'reference', 'legal_name', 'short_name', 'kind', 'country', 'status'],
    required: ['legalName'],
  },
  contracts: {
    table: 'contract',
    columns: ['id', 'reference', 'name', 'contract_kind', 'basis', 'currency', 'status'],
  },
  claims: {
    table: 'claim',
    columns: ['id', 'reference', 'contract_id', 'currency', 'gross_loss_minor', 'status'],
  },
};

const createWebhookSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.string()),
  secret: z.string().optional(),
});

const emitSchema = z.object({
  eventType: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});

const importSchema = z.object({
  entity: z.string().min(1),
  rows: z.array(z.record(z.unknown())),
});

export async function integrationModule(app: FastifyInstance): Promise<void> {
  app.post('/api/integration/webhooks', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid subscription', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into webhook_subscription (tenant_id, url, secret, event_types, is_active, created_by)
         values ($1,$2,$3,$4::jsonb,true,$5) returning id`,
        [ctx.tenantId, b.url, b.secret ?? null, JSON.stringify(b.eventTypes), ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'webhook_subscription',
        entityId: id,
        after: { url: b.url, eventTypes: b.eventTypes },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id };
    });
  });

  app.get('/api/integration/webhooks', { preHandler: requirePermission('integration:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, url, event_types as "eventTypes", is_active as "isActive",
                created_at as "createdAt"
           from webhook_subscription
          where is_active
          order by created_at desc`,
      );
      return { subscriptions: rows };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/integration/webhooks/:id/disable',
    { preHandler: requirePermission('integration:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `update webhook_subscription set is_active = false where id = $1 returning id`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Subscription not found' };
        }
        await writeAudit(db, ctx, {
          action: 'disable',
          entityType: 'webhook_subscription',
          entityId: req.params.id,
          after: { isActive: false },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, isActive: false };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/integration/webhooks/:id/deliveries',
    { preHandler: requirePermission('integration:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, subscription_id as "subscriptionId", event_type as "eventType",
                  payload, status, attempts, response_code as "responseCode",
                  delivered_at as "deliveredAt", created_at as "createdAt"
             from webhook_delivery
            where subscription_id = $1
            order by created_at desc`,
          [req.params.id],
        );
        return { deliveries: rows };
      });
    },
  );

  // Outbox enqueue: fan an event out to a pending delivery per matching subscription.
  app.post('/api/integration/webhooks/emit', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = emitSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid event', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const subs = await db.query<{ id: string }>(
        `select id from webhook_subscription
          where is_active and event_types @> to_jsonb($1::text)`,
        [b.eventType],
      );
      const payloadJson = JSON.stringify(b.payload ?? {});
      for (const sub of subs.rows) {
        await db.query(
          `insert into webhook_delivery (tenant_id, subscription_id, event_type, payload, status)
           values ($1,$2,$3,$4::jsonb,'pending')`,
          [ctx.tenantId, sub.id, b.eventType, payloadJson],
        );
      }
      await writeAudit(db, ctx, {
        action: 'emit',
        entityType: 'webhook_delivery',
        after: { eventType: b.eventType, enqueued: subs.rows.length },
        actorLabel: req.auth?.displayName,
      });
      return { enqueued: subs.rows.length };
    });
  });

  app.get<{ Querystring: { entity?: string; format?: string } }>(
    '/api/integration/export',
    { preHandler: requirePermission('integration:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const entityKey = req.query.entity ?? '';
      const def = ENTITIES[entityKey];
      if (!def) {
        reply.code(400);
        return { error: `Unknown entity. Allowed: ${Object.keys(ENTITIES).join(', ')}` };
      }
      const format = req.query.format === 'csv' ? 'csv' : 'json';
      return runAs(ctx, async (db) => {
        // Columns come solely from the code-defined allowlist - never user input.
        const cols = def.columns.join(', ');
        const { rows } = await db.query(
          `select ${cols} from ${def.table} limit 5000`,
        );
        if (format === 'csv') {
          reply.header('content-type', 'text/csv');
          const header = def.columns.join(',');
          const body = rows
            .map((r) => def.columns.map((c) => csvCell((r as Record<string, unknown>)[c])).join(','))
            .join('\n');
          return rows.length > 0 ? `${header}\n${body}` : `${header}`;
        }
        return { entity: entityKey, rows };
      });
    },
  );

  app.post('/api/integration/import', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid import', details: parsed.error.flatten() };
    }
    const { entity, rows } = parsed.data;
    const def = ENTITIES[entity];
    if (!def) {
      reply.code(400);
      return { error: `Unknown entity. Allowed: ${Object.keys(ENTITIES).join(', ')}` };
    }
    const required = def.required ?? [];

    const valid: { index: number; row: Record<string, unknown> }[] = [];
    const rejected: { index: number; errors: string[] }[] = [];
    rows.forEach((row, index) => {
      const errors: string[] = [];
      for (const field of required) {
        const v = row[field];
        if (v === undefined || v === null || v === '') {
          errors.push(`Missing required field: ${field}`);
        }
      }
      if (errors.length > 0) rejected.push({ index, errors });
      else valid.push({ index, row });
    });

    return runAs(ctx, async (db) => {
      const ids: string[] = [];
      if (entity === 'parties') {
        for (const { row } of valid) {
          const id = await insertParty(db, ctx.tenantId, row);
          ids.push(id);
        }
        if (ids.length > 0) {
          await writeAudit(db, ctx, {
            action: 'import',
            entityType: 'party',
            after: { entity, accepted: ids.length, ids },
            actorLabel: req.auth?.displayName,
          });
        }
      }
      return { accepted: valid.length, rejected, ...(entity === 'parties' ? { ids } : {}) };
    });
  });
}

async function insertParty(db: Db, tenantId: string, row: Record<string, unknown>): Promise<string> {
  const legalName = String(row.legalName);
  const shortName = row.shortName != null ? String(row.shortName) : null;
  const kind = row.kind != null ? String(row.kind) : 'organisation';
  const country = row.country != null ? String(row.country) : null;
  const { rows } = await db.query<{ id: string }>(
    `insert into party (tenant_id, legal_name, short_name, kind, country)
     values ($1,$2,$3,$4,$5) returning id`,
    [tenantId, legalName, shortName, kind, country],
  );
  return rows[0]!.id;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}
