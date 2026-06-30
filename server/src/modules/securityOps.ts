/**
 * Security operations & resilience (brief §14.4, §15.5, §19):
 *  - SOC dashboard + SIEM export over the immutable audit_log,
 *  - Backup / DR run catalog,
 *  - i18n locale-message store and resolved bundles.
 * SOC reads existing audit rows; backup records logical run markers (a real
 * deployment drives snapshots from the DB/infra layer); i18n bundles are resolved
 * by the pure @rios/domain engine. ops:read/write for SOC+backup; config:* for i18n.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveBundle, direction } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

// Audit entity types considered security-relevant for the SOC feed.
const SECURITY_ENTITIES = [
  'mfa_credential', 'identity_provider', 'user_identity', 'api_key', 'legal_hold',
  'field_policy', 'role', 'permission', 'kms_key', 'retention_policy',
];

export async function securityOpsModule(app: FastifyInstance): Promise<void> {
  // --- SOC dashboard: security-relevant audit activity ---
  app.get('/api/soc/events', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, occurred_at as "occurredAt", actor_label as "actor", action,
                entity_type as "entityType", entity_id as "entityId"
           from audit_log
          where entity_type = any($1::text[])
          order by occurred_at desc limit 100`,
        [SECURITY_ENTITIES],
      );
      const byAction = await db.query(
        `select action, count(*)::int as n from audit_log
          where entity_type = any($1::text[]) group by action order by n desc`,
        [SECURITY_ENTITIES],
      );
      return { events: rows, byAction: byAction.rows };
    });
  });

  // SIEM export: newline-delimited JSON of recent security events (forwardable).
  app.get('/api/soc/siem/export', { preHandler: requirePermission('ops:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select occurred_at, actor_label, action, entity_type, entity_id
           from audit_log where entity_type = any($1::text[])
          order by occurred_at desc limit 500`,
        [SECURITY_ENTITIES],
      );
      const ndjson = rows.map((r) => JSON.stringify({
        ts: r.occurred_at, actor: r.actor_label, action: r.action, entity: r.entity_type, id: r.entity_id, source: 'rios',
      })).join('\n');
      reply.header('content-type', 'application/x-ndjson');
      return ndjson;
    });
  });

  // --- Backup / DR catalog ---
  app.get('/api/backup/runs', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, kind, status, location, size_bytes as "sizeBytes", note,
                started_at as "startedAt", finished_at as "finishedAt"
           from backup_run order by started_at desc limit 50`,
      );
      return { runs: rows };
    });
  });

  app.post<{ Body: { kind?: string; note?: string } }>('/api/backup/runs', { preHandler: requirePermission('ops:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const kind = (req.body?.kind ?? 'snapshot');
    if (!['full', 'incremental', 'snapshot'].includes(kind)) { reply.code(400); return { error: 'Invalid kind' }; }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into backup_run (tenant_id, kind, status, location, note, finished_at, created_by)
         values ($1,$2,'completed',$3,$4, now(), $5) returning id`,
        [ctx.tenantId, kind, `s3://rios-backups/${ctx.tenantId}/${kind}`, req.body?.note ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, { action: 'backup', entityType: 'backup_run', entityId: rows[0]!.id, after: { kind }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id, kind, status: 'completed' };
    });
  });

  // --- i18n: locale messages & resolved bundles ---
  app.get('/api/i18n/locales', { preHandler: requirePermission('config:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ locale: string; n: number }>(
        `select locale, count(*)::int as n from locale_message group by locale order by locale`,
      );
      return { locales: rows.map((r) => ({ locale: r.locale, messages: r.n, direction: direction(r.locale) })) };
    });
  });

  // A resolved bundle for a locale, falling back to English.
  app.get<{ Querystring: { locale?: string } }>('/api/i18n/bundle', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    const locale = req.query.locale ?? 'en-US';
    return runAs(ctx, async (db) => {
      const load = async (loc: string) => {
        const { rows } = await db.query<{ key: string; message: string }>(`select key, message from locale_message where locale = $1`, [loc]);
        return Object.fromEntries(rows.map((r) => [r.key, r.message]));
      };
      const [target, fallback] = await Promise.all([load(locale), load('en-US')]);
      return { locale, direction: direction(locale), bundle: resolveBundle(target, fallback) };
    });
  });

  app.post('/api/i18n/messages', { preHandler: requirePermission('config:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = z.object({ locale: z.string().min(2), key: z.string().min(1), message: z.string() }).safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid message', details: parsed.error.flatten() }; }
    const m = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into locale_message (tenant_id, locale, key, message, updated_at)
         values ($1,$2,$3,$4, now())
         on conflict (tenant_id, locale, key) do update set message = excluded.message, updated_at = now()
         returning id`,
        [ctx.tenantId, m.locale, m.key, m.message],
      );
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });
}
