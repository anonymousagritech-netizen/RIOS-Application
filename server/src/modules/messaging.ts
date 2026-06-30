/**
 * Email & SMS engines (brief §3). A transactional message outbox: callers
 * enqueue a message, a delivery step hands it to a provider and records the
 * outcome. The mechanics (queue, status, audit) are real and tested; the dev
 * provider is in-process (it marks queued messages 'sent' and logs them) — wire
 * a real SMTP/SMS gateway in production (see docs/open-questions.md).
 * integration:read to view, integration:write to send/deliver.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const sendSchema = z.object({
  channel: z.enum(['email', 'sms']),
  to: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
});

export async function messagingModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; channel?: string } }>(
    '/api/messaging/outbox',
    { preHandler: requirePermission('integration:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, channel, to_addr as "to", subject, body, status, provider, error,
                  created_at as "createdAt", sent_at as "sentAt"
             from message_outbox
            where ($1::text is null or status = $1) and ($2::text is null or channel = $2)
            order by created_at desc limit 100`,
          [req.query.status ?? null, req.query.channel ?? null],
        );
        return { messages: rows };
      });
    },
  );

  // Enqueue a message (queued).
  app.post('/api/messaging/send', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid message', details: parsed.error.flatten() }; }
    const m = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into message_outbox (tenant_id, channel, to_addr, subject, body, status, created_by)
         values ($1,$2,$3,$4,$5,'queued',$6) returning id`,
        [ctx.tenantId, m.channel, m.to, m.subject ?? null, m.body, ctx.userId],
      );
      await writeAudit(db, ctx, { action: 'enqueue', entityType: 'message_outbox', entityId: rows[0]!.id, after: { channel: m.channel, to: m.to }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id, status: 'queued' };
    });
  });

  // Deliver the queue via the (dev) provider: mark queued messages sent.
  app.post('/api/messaging/deliver', { preHandler: requirePermission('integration:write') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `update message_outbox set status = 'sent', provider = 'dev-inproc', sent_at = now()
          where status = 'queued' returning id`,
      );
      return { delivered: rows.length };
    });
  });
}
