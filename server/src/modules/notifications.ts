/**
 * Notification centre extras (Operations / platform). The list + mark-read
 * endpoints live in the automation module (migration 0012); this adds the
 * unread-count and mark-all-read the notification bell needs, plus a `notify()`
 * helper other modules call to raise an in-app alert with a deep link.
 *
 * Count / read-all are auth-only (a user always sees their own notifications).
 */

import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

export interface NotifyInput {
  userId: string | null;                 // recipient (null = broadcast to no one specific)
  title: string;
  body?: string;
  kind?: 'SYSTEM' | 'REFERRAL' | 'SLA' | 'TASK' | 'CLAIM' | 'RENEWAL' | 'FINANCE';
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  link?: string;
  entityType?: string;
  entityId?: string;
}

/** Raise an in-app notification. Safe to call inside a request transaction. */
export async function notify(db: Db, tenantId: string, n: NotifyInput): Promise<void> {
  await db.query(
    `insert into notification (tenant_id, recipient_user_id, channel, subject, body, kind, severity, link, entity_type, entity_id)
     values ($1,$2,'in_app',$3,$4,$5,$6,$7,$8,$9)`,
    [tenantId, n.userId, n.title, n.body ?? null, n.kind ?? 'SYSTEM', n.severity ?? 'INFO', n.link ?? null, n.entityType ?? null, n.entityId ?? null],
  );
}

export async function notificationsModule(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications/unread-count', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ n: string }>(
        `select count(*)::int n from notification where recipient_user_id = $1 and not is_read`, [ctx.userId],
      );
      return { count: Number(rows[0]!.n) };
    });
  });

  app.post('/api/notifications/read-all', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rowCount } = await db.query(
        `update notification set is_read = true where recipient_user_id = $1 and not is_read`, [ctx.userId],
      );
      return { ok: true, marked: rowCount ?? 0 };
    });
  });
}
