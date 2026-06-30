/**
 * Event bus / outbox (brief §3). The transactional-outbox pattern: domain events
 * are written to event_outbox (in the same transaction as the change that raised
 * them, in a full implementation), and a relay marks them published. The outbox
 * + relay are real and tested; the production sink (Kafka) is provider-configured
 * - the in-process relay here just flips status. integration:read / write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

const publishSchema = z.object({
  eventType: z.string().min(1),
  aggregateType: z.string().optional(),
  aggregateId: z.string().uuid().optional(),
  payload: z.record(z.unknown()).default({}),
});

export async function eventBusModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string } }>(
    '/api/events',
    { preHandler: requirePermission('integration:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, event_type as "eventType", aggregate_type as "aggregateType",
                  aggregate_id as "aggregateId", payload, status,
                  created_at as "createdAt", published_at as "publishedAt"
             from event_outbox
            where ($1::text is null or status = $1)
            order by created_at desc limit 100`,
          [req.query.status ?? null],
        );
        const pending = await db.query<{ n: number }>(`select count(*)::int as n from event_outbox where status = 'pending'`);
        return { events: rows, pending: pending.rows[0]!.n };
      });
    },
  );

  // Append a domain event to the outbox.
  app.post('/api/events/publish', { preHandler: requirePermission('integration:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid event', details: parsed.error.flatten() }; }
    const e = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into event_outbox (tenant_id, event_type, aggregate_type, aggregate_id, payload, status)
         values ($1,$2,$3,$4,$5,'pending') returning id`,
        [ctx.tenantId, e.eventType, e.aggregateType ?? null, e.aggregateId ?? null, JSON.stringify(e.payload)],
      );
      reply.code(201);
      return { id: rows[0]!.id, status: 'pending' };
    });
  });

  // Relay: publish all pending events (in-process sink). Returns the count.
  app.post('/api/events/relay', { preHandler: requirePermission('integration:write') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `update event_outbox set status = 'published', published_at = now()
          where status = 'pending' returning id`,
      );
      return { published: rows.length };
    });
  });
}
