/**
 * Performance management (brief §14). Employee review cycles with weighted goals.
 * The overall rating and band are computed by the pure @rios/domain engine
 * (weightedRating/ratingBand) on save, so the stored score always reconciles
 * with the goals. hr:read to view, hr:write to author; mutations audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { weightedRating, ratingBand, type Goal } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const goalSchema = z.object({
  title: z.string().optional(),
  weight: z.number().nonnegative(),
  score: z.number().min(0).max(5),
});

const reviewSchema = z.object({
  employeeId: z.string().uuid(),
  period: z.string().min(1),
  status: z.enum(['draft', 'in_review', 'finalised']).default('draft'),
  goals: z.array(goalSchema).default([]),
  summary: z.string().optional(),
});

export async function performanceModule(app: FastifyInstance): Promise<void> {
  app.get('/api/performance/reviews', { preHandler: requirePermission('hr:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select r.id, r.employee_id as "employeeId", r.period, r.status,
                r.overall_score as "overallScore", r.band, r.summary, r.goals,
                e.first_name || ' ' || e.last_name as "employeeName", e.position
           from performance_review r
           join employee e on e.id = r.employee_id
          order by r.period desc, e.last_name`,
      );
      return { reviews: rows };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/performance/reviews/:id',
    { preHandler: requirePermission('hr:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select r.id, r.employee_id as "employeeId", r.period, r.status,
                  r.overall_score as "overallScore", r.band, r.summary, r.goals,
                  e.first_name || ' ' || e.last_name as "employeeName", e.position
             from performance_review r join employee e on e.id = r.employee_id
            where r.id = $1`,
          [req.params.id],
        );
        if (!rows[0]) { reply.code(404); return { error: 'Review not found' }; }
        return rows[0];
      });
    },
  );

  app.post('/api/performance/reviews', { preHandler: requirePermission('hr:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid review', details: parsed.error.flatten() };
    }
    const r = parsed.data;
    const overall = weightedRating(r.goals as Goal[]);
    const band = ratingBand(overall);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into performance_review (tenant_id, employee_id, period, status, goals, overall_score, band, summary, reviewer_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (tenant_id, employee_id, period) do update set
           status = excluded.status, goals = excluded.goals, overall_score = excluded.overall_score,
           band = excluded.band, summary = excluded.summary, reviewer_id = excluded.reviewer_id,
           updated_at = now()
         returning id`,
        [ctx.tenantId, r.employeeId, r.period, r.status, JSON.stringify(r.goals), overall, band, r.summary ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'performance_review', entityId: rows[0]!.id,
        after: { employeeId: r.employeeId, period: r.period, overallScore: overall, band }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, overallScore: overall, band };
    });
  });
}
