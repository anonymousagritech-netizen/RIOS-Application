/**
 * Developer portal (brief §12). A catalog of the public API surface and
 * self-service API key issuance. Keys are shown once on creation; only a hash and
 * a short prefix are stored (the raw key is never retrievable afterwards), so a
 * leaked database cannot reveal usable keys. integration:read to view, admin:manage
 * to issue/revoke keys.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

// A curated catalog of the stable public API surface (grouped).
const API_CATALOG = [
  { group: 'Treaties', endpoints: ['GET /api/treaties', 'POST /api/treaties', 'POST /api/treaties/:id/bind'] },
  { group: 'Parties', endpoints: ['GET /api/parties', 'POST /api/parties'] },
  { group: 'Claims', endpoints: ['GET /api/claims', 'POST /api/claims'] },
  { group: 'Accounting', endpoints: ['GET /api/statements', 'POST /api/accounting/post'] },
  { group: 'Analytics', endpoints: ['POST /api/analytics/pivot', 'POST /api/analytics/reports/:key/run'] },
  { group: 'Integration', endpoints: ['POST /api/messaging/send', 'POST /api/events/publish', 'GET /api/connectors'] },
];

const keySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).default([]),
});

export async function devPortalModule(app: FastifyInstance): Promise<void> {
  app.get('/api/devportal/catalog', { preHandler: requirePermission('integration:read') }, async () => {
    return { catalog: API_CATALOG };
  });

  app.get('/api/devportal/keys', { preHandler: requirePermission('integration:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, prefix, scopes, created_at as "createdAt", revoked_at as "revokedAt"
           from api_key order by created_at desc`,
      );
      return { keys: rows };
    });
  });

  // Issue a key — returns the raw key ONCE; only its hash + prefix are stored.
  app.post('/api/devportal/keys', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = keySchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid key request', details: parsed.error.flatten() }; }
    const raw = `rios_${crypto.randomBytes(24).toString('base64url')}`;
    const prefix = raw.slice(0, 12);
    const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into api_key (tenant_id, name, prefix, key_hash, scopes, created_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, parsed.data.name, prefix, keyHash, parsed.data.scopes, ctx.userId],
      );
      await writeAudit(db, ctx, { action: 'issue', entityType: 'api_key', entityId: rows[0]!.id, after: { name: parsed.data.name, prefix }, actorLabel: req.auth?.displayName });
      reply.code(201);
      // The raw key is returned exactly once.
      return { id: rows[0]!.id, name: parsed.data.name, key: raw, prefix };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/devportal/keys/:id/revoke',
    { preHandler: requirePermission('admin:manage') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(`update api_key set revoked_at = now() where id = $1 and revoked_at is null`, [req.params.id]);
        if (!rowCount) { reply.code(404); return { error: 'Active key not found' }; }
        await writeAudit(db, ctx, { action: 'revoke', entityType: 'api_key', entityId: req.params.id, actorLabel: req.auth?.displayName });
        return { id: req.params.id, revoked: true };
      });
    },
  );
}
