/**
 * Mobile portal (brief §9.11). A condensed home payload tuned for a small screen
 * (headline counts + a short recent-activity list) and a PWA web-app manifest.
 * The same auth/RLS apply; this is a projection, not a parallel store. The native
 * shell is out of scope — the responsive web client consumes these endpoints.
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

export async function mobileModule(app: FastifyInstance): Promise<void> {
  // Condensed home for a mobile surface.
  app.get('/api/mobile/home', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ treaties: number; open_claims: number; parties: number }>(
        `select
           (select count(*)::int from contract where not is_deleted) as treaties,
           (select count(*)::int from claim where not is_deleted and status not in ('CLOSED','SETTLED')) as open_claims,
           (select count(*)::int from party where not is_deleted) as parties`,
      );
      const recent = await db.query(
        `select 'claim' as type, reference as label, notified_date::text as "when"
           from claim where not is_deleted order by notified_date desc limit 5`,
      );
      const k = rows[0]!;
      return {
        tiles: [
          { label: 'Contracts', value: k.treaties },
          { label: 'Open claims', value: k.open_claims },
          { label: 'Counterparties', value: k.parties },
        ],
        recent: recent.rows,
      };
    });
  });

  // PWA manifest (public — the browser fetches it without a bearer token).
  app.get('/api/mobile/manifest', async (_req, reply) => {
    reply.header('content-type', 'application/manifest+json');
    return {
      name: 'RIOS', short_name: 'RIOS', display: 'standalone',
      background_color: '#0b0f1a', theme_color: '#0b0f1a', start_url: '/dashboard',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    };
  });
}
