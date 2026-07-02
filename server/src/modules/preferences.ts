/**
 * User preferences module: lightweight per-user key/value store for UI state
 * (e.g. saved filter settings per page). Values are arbitrary JSON.
 *
 * GET  /api/preferences/:key  — returns { value } for the current user+tenant
 * PUT  /api/preferences/:key  — upserts { value } for the current user+tenant
 *
 * The key is URL-encoded by the client; the route param arrives decoded.
 * No audit trail needed (UI state changes are not business mutations).
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

export async function preferencesModule(app: FastifyInstance): Promise<void> {
  // GET /api/preferences/:key — fetch a single preference value.
  // Returns { value: null } when the key has never been saved.
  app.get<{ Params: { key: string } }>(
    '/api/preferences/:key',
    { preHandler: requirePermission() },
    async (req, reply) => {
      const ctx = authContext(req);
      const key = req.params.key;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ pref_value: unknown }>(
          `select pref_value from user_preference
            where user_id = $1 and tenant_id = $2 and pref_key = $3`,
          [ctx.userId, ctx.tenantId, key],
        );
        if (!rows[0]) {
          reply.code(404);
          return { value: null };
        }
        return { value: rows[0].pref_value };
      });
    },
  );

  // PUT /api/preferences/:key — upsert a preference value.
  // Body: { value: <any JSON> }
  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/api/preferences/:key',
    { preHandler: requirePermission() },
    async (req) => {
      const ctx = authContext(req);
      const key = req.params.key;
      const value = req.body?.value ?? null;
      return runAs(ctx, async (db) => {
        await db.query(
          `insert into user_preference (user_id, tenant_id, pref_key, pref_value, updated_at)
           values ($1, $2, $3, $4, now())
           on conflict (user_id, tenant_id, pref_key)
           do update set pref_value = excluded.pref_value, updated_at = now()`,
          [ctx.userId, ctx.tenantId, key, JSON.stringify(value)],
        );
        return { ok: true };
      });
    },
  );
}
