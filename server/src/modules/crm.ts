/**
 * CRM module (brief §9.11 - relationship activity & sales pipeline).
 *
 * Activities are touch-points on a party (calls/emails/meetings/notes/tasks);
 * opportunities track the sales pipeline by stage with a probability-weighted
 * value. The pipeline view aggregates opportunities into the classic funnel.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { fromMajor } from '@rios/domain';

const createActivitySchema = z.object({
  partyId: z.string().uuid(),
  kind: z.enum(['call', 'email', 'meeting', 'note', 'task']),
  subject: z.string().min(1),
  body: z.string().optional(),
  dueDate: z.string().optional(),
});

const createOpportunitySchema = z.object({
  partyId: z.string().uuid(),
  name: z.string().min(1),
  stage: z.enum(['PROSPECT', 'QUALIFIED', 'QUOTED', 'BOUND', 'LOST']).default('PROSPECT'),
  amount: z.number(),
  currency: z.string().length(3),
  probability: z.number().min(0).max(100).optional(),
  expectedClose: z.string().optional(),
});

const updateOpportunitySchema = z.object({
  stage: z.enum(['PROSPECT', 'QUALIFIED', 'QUOTED', 'BOUND', 'LOST']).optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  probability: z.number().min(0).max(100).optional(),
});

export async function crmModule(app: FastifyInstance): Promise<void> {
  app.post('/api/crm/activities', { preHandler: requirePermission('crm:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createActivitySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid activity', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into crm_activity (tenant_id, party_id, kind, subject, body, due_date, owner_user_id)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, b.partyId, b.kind, b.subject, b.body ?? null, b.dueDate ?? null, ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'crm_activity',
        entityId: id,
        after: { partyId: b.partyId, kind: b.kind, subject: b.subject },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id };
    });
  });

  app.get<{ Querystring: { partyId?: string; completed?: string } }>(
    '/api/crm/activities',
    { preHandler: requirePermission('crm:read') },
    async (req) => {
      const ctx = authContext(req);
      const completed =
        req.query.completed === undefined ? null : req.query.completed === 'true';
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select a.id, a.party_id as "partyId", p.short_name as "partyName",
                  a.kind, a.subject, a.body, a.due_date as "dueDate", a.completed,
                  a.owner_user_id as "ownerUserId", a.created_at as "createdAt"
             from crm_activity a
             left join party p on p.id = a.party_id
            where ($1::uuid is null or a.party_id = $1)
              and ($2::boolean is null or a.completed = $2)
            order by a.created_at desc`,
          [req.query.partyId ?? null, completed],
        );
        return { activities: rows };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/crm/activities/:id/complete',
    { preHandler: requirePermission('crm:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `update crm_activity set completed = true where id = $1 returning id`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Activity not found' };
        }
        await writeAudit(db, ctx, {
          action: 'complete',
          entityType: 'crm_activity',
          entityId: req.params.id,
          after: { completed: true },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, completed: true };
      });
    },
  );

  app.post('/api/crm/opportunities', { preHandler: requirePermission('crm:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createOpportunitySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid opportunity', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const amountMinor = fromMajor(b.amount, b.currency).amount;
      const { rows } = await db.query<{ id: string }>(
        `insert into crm_opportunity
           (tenant_id, party_id, name, stage, amount_minor, currency, probability, expected_close, owner_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          ctx.tenantId, b.partyId, b.name, b.stage, amountMinor, b.currency,
          b.probability ?? 0, b.expectedClose ?? null, ctx.userId,
        ],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'crm_opportunity',
        entityId: id,
        after: { name: b.name, stage: b.stage, amountMinor, currency: b.currency },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id };
    });
  });

  app.get<{ Querystring: { stage?: string; status?: string } }>(
    '/api/crm/opportunities',
    { preHandler: requirePermission('crm:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select o.id, o.party_id as "partyId", p.short_name as "partyName",
                  o.name, o.stage, o.amount_minor as "amountMinor", o.currency,
                  o.probability, o.expected_close as "expectedClose", o.status,
                  o.created_at as "createdAt", o.updated_at as "updatedAt"
             from crm_opportunity o
             left join party p on p.id = o.party_id
            where ($1::citext is null or o.stage = $1)
              and ($2::text is null or o.status = $2)
            order by o.created_at desc`,
          [req.query.stage ?? null, req.query.status ?? null],
        );
        return { opportunities: rows };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/crm/opportunities/:id',
    { preHandler: requirePermission('crm:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = updateOpportunitySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid update', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (b.stage !== undefined) {
          params.push(b.stage);
          sets.push(`stage = $${params.length}`);
        }
        if (b.status !== undefined) {
          params.push(b.status);
          sets.push(`status = $${params.length}`);
        }
        if (b.probability !== undefined) {
          params.push(b.probability);
          sets.push(`probability = $${params.length}`);
        }
        sets.push('updated_at = now()');
        params.push(req.params.id);
        const { rows } = await db.query<{ id: string }>(
          `update crm_opportunity set ${sets.join(', ')} where id = $${params.length} returning id`,
          params,
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Opportunity not found' };
        }
        await writeAudit(db, ctx, {
          action: 'update',
          entityType: 'crm_opportunity',
          entityId: req.params.id,
          after: b,
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id };
      });
    },
  );

  // Sales-pipeline funnel: opportunities aggregated by stage with weighted value.
  app.get('/api/crm/pipeline', { preHandler: requirePermission('crm:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        stage: string;
        count: number;
        total_minor: number;
        weighted_minor: number;
      }>(
        `select o.stage,
                count(*)::int as count,
                coalesce(sum(o.amount_minor), 0)::bigint as total_minor,
                coalesce(round(sum(o.amount_minor * o.probability / 100.0)), 0)::bigint as weighted_minor
           from crm_opportunity o
          where o.status = 'open'
          group by o.stage
          order by o.stage`,
      );
      const pipeline = rows.map((r) => ({
        stage: r.stage,
        count: r.count,
        totalMinor: r.total_minor,
        weightedMinor: r.weighted_minor,
      }));
      const totalWeightedMinor = pipeline.reduce((acc, p) => acc + p.weightedMinor, 0);
      return { pipeline, totalWeightedMinor };
    });
  });
}
