/**
 * API / app marketplace (brief §26, §17). A catalog of installable apps and API
 * products with per-tenant install state. (The brief marks the marketplace as a
 * later-phase item; this delivers a working catalog + install lifecycle.)
 * integration:read to browse, integration:write to install/uninstall; audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

export async function marketplaceModule(app: FastifyInstance): Promise<void> {
  // Catalog with the current tenant's install status joined in.
  app.get('/api/marketplace/listings', { preHandler: requirePermission('integration:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select l.id, l.key, l.name, l.category, l.publisher, l.description, l.version,
                (i.id is not null) as installed, coalesce(i.enabled, false) as enabled,
                i.installed_at as "installedAt"
           from marketplace_listing l
           left join marketplace_install i on i.listing_key = l.key
          order by l.category, l.name`,
      );
      return { listings: rows };
    });
  });

  app.post('/api/marketplace/installs', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = z.object({ listingKey: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'listingKey is required' }; }
    return runAs(ctx, async (db) => {
      const exists = await db.query(`select 1 from marketplace_listing where key = $1`, [parsed.data.listingKey]);
      if (!exists.rows[0]) { reply.code(404); return { error: 'Listing not found' }; }
      const { rows } = await db.query<{ id: string }>(
        `insert into marketplace_install (tenant_id, listing_key, enabled, installed_by)
         values ($1,$2,true,$3)
         on conflict (tenant_id, listing_key) do update set enabled = true
         returning id`,
        [ctx.tenantId, parsed.data.listingKey, ctx.userId],
      );
      await writeAudit(db, ctx, { action: 'install', entityType: 'marketplace_install', entityId: rows[0]!.id, after: { listingKey: parsed.data.listingKey }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id, installed: true };
    });
  });

  app.post<{ Params: { key: string } }>('/api/marketplace/installs/:key/uninstall', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rowCount } = await db.query(`delete from marketplace_install where listing_key = $1`, [req.params.key]);
      if (!rowCount) { reply.code(404); return { error: 'Not installed' }; }
      await writeAudit(db, ctx, { action: 'uninstall', entityType: 'marketplace_install', after: { listingKey: req.params.key }, actorLabel: req.auth?.displayName });
      return { key: req.params.key, installed: false };
    });
  });
}
