/**
 * Connector framework (brief §12). A registry of typed integration connectors
 * (REST/SFTP/Kafka/webhook). Config is validated by the pure @rios/domain
 * engine and secrets are redacted on read. "Test connection" validates the
 * config shape (a real implementation would attempt a live handshake).
 * integration:read / integration:write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateConnectorConfig, redactConfig, type ConnectorKind } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const connectorSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['rest', 'sftp', 'kafka', 'webhook']),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export async function connectorsModule(app: FastifyInstance): Promise<void> {
  app.get('/api/connectors', { preHandler: requirePermission('integration:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, key, name, kind, config, enabled, last_status as "lastStatus"
           from connector order by key`,
      );
      // Never return secret config values in clear.
      return { connectors: rows.map((c) => ({ ...c, config: redactConfig(c.config as Record<string, unknown>) })) };
    });
  });

  app.post('/api/connectors', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = connectorSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid connector', details: parsed.error.flatten() }; }
    const c = parsed.data;
    const issues = validateConnectorConfig(c.kind as ConnectorKind, c.config);
    if (issues.length) { reply.code(422); return { error: 'Invalid connector config', issues }; }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into connector (tenant_id, key, name, kind, config, enabled)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, key) do update set
           name = excluded.name, kind = excluded.kind, config = excluded.config, enabled = excluded.enabled
         returning id`,
        [ctx.tenantId, c.key, c.name, c.kind, JSON.stringify(c.config), c.enabled],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'connector', entityId: rows[0]!.id, after: { key: c.key, kind: c.kind }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Test a connector: validate its stored config shape.
  app.post<{ Params: { id: string } }>(
    '/api/connectors/:id/test',
    { preHandler: requirePermission('integration:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ kind: ConnectorKind; config: Record<string, unknown> }>(
          `select kind, config from connector where id = $1`, [req.params.id],
        );
        if (!rows[0]) { reply.code(404); return { error: 'Connector not found' }; }
        const issues = validateConnectorConfig(rows[0].kind, rows[0].config);
        const status = issues.length ? 'invalid' : 'ok';
        await db.query(`update connector set last_status = $2 where id = $1`, [req.params.id, status]);
        return { status, issues };
      });
    },
  );
}
