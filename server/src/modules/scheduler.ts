/**
 * Scheduler / job orchestration (brief §3). Manages interval-scheduled jobs and
 * their run history. Next-run / due decisions come from the pure @rios/domain
 * scheduler; this module persists state and records executions. "Run now"
 * records a job_run and advances the schedule (a real deployment would have a
 * worker poll /due and execute). ops:read to view, ops:write to manage; audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { advance, isDue, type Schedulable } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const jobSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  jobType: z.string().min(1),
  intervalMinutes: z.number().int().min(1),
  enabled: z.boolean().default(true),
});

interface JobRow {
  id: string; key: string; name: string; jobType: string; intervalMinutes: number;
  enabled: boolean; lastRunAt: string | null; nextRunAt: string | null;
}

function toSchedulable(j: JobRow): Schedulable {
  return {
    id: j.id,
    intervalMinutes: j.intervalMinutes,
    enabled: j.enabled,
    lastRunMs: j.lastRunAt ? Date.parse(j.lastRunAt) : null,
  };
}

export async function schedulerModule(app: FastifyInstance): Promise<void> {
  // List jobs, annotating each with whether it is currently due.
  app.get('/api/scheduler/jobs', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<JobRow>(
        `select id, key, name, job_type as "jobType", interval_minutes as "intervalMinutes",
                enabled, last_run_at as "lastRunAt", next_run_at as "nextRunAt"
           from scheduled_job order by enabled desc, key`,
      );
      const now = Date.now();
      const jobs = rows.map((j) => ({ ...j, due: isDue(toSchedulable(j), now) }));
      return { jobs, dueCount: jobs.filter((j) => j.due).length };
    });
  });

  app.post('/api/scheduler/jobs', { preHandler: requirePermission('ops:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = jobSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid job', details: parsed.error.flatten() };
    }
    const j = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into scheduled_job (tenant_id, key, name, job_type, interval_minutes, enabled, next_run_at, created_by)
         values ($1,$2,$3,$4,$5,$6, now(), $7)
         on conflict (tenant_id, key) do update set
           name = excluded.name, job_type = excluded.job_type,
           interval_minutes = excluded.interval_minutes, enabled = excluded.enabled
         returning id`,
        [ctx.tenantId, j.key, j.name, j.jobType, j.intervalMinutes, j.enabled, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'scheduled_job', entityId: rows[0]!.id,
        after: { key: j.key, intervalMinutes: j.intervalMinutes, enabled: j.enabled }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Enable / disable a job.
  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    '/api/scheduler/jobs/:id/toggle',
    { preHandler: requirePermission('ops:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const enabled = !!req.body?.enabled;
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(`update scheduled_job set enabled = $2 where id = $1`, [req.params.id, enabled]);
        if (!rowCount) { reply.code(404); return { error: 'Job not found' }; }
        await writeAudit(db, ctx, { action: enabled ? 'enable' : 'disable', entityType: 'scheduled_job', entityId: req.params.id, actorLabel: req.auth?.displayName });
        return { id: req.params.id, enabled };
      });
    },
  );

  // Run a job now: record a run and advance the schedule.
  app.post<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id/run',
    { preHandler: requirePermission('ops:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const job = await db.query<{ interval_minutes: number }>(
          `select interval_minutes from scheduled_job where id = $1`, [req.params.id],
        );
        if (!job.rows[0]) { reply.code(404); return { error: 'Job not found' }; }
        const ranAt = Date.now();
        const { nextRunMs } = advance(job.rows[0].interval_minutes, ranAt);
        const run = await db.query<{ id: string }>(
          `insert into job_run (tenant_id, job_id, status, finished_at, detail)
           values ($1,$2,'success', now(), 'Manual run') returning id`,
          [ctx.tenantId, req.params.id],
        );
        await db.query(
          `update scheduled_job set last_run_at = now(), next_run_at = to_timestamp($2 / 1000.0) where id = $1`,
          [req.params.id, nextRunMs],
        );
        await writeAudit(db, ctx, { action: 'run', entityType: 'scheduled_job', entityId: req.params.id, actorLabel: req.auth?.displayName });
        return { runId: run.rows[0]!.id, nextRunAt: new Date(nextRunMs).toISOString() };
      });
    },
  );

  // Run history for a job.
  app.get<{ Params: { id: string } }>(
    '/api/scheduler/jobs/:id/runs',
    { preHandler: requirePermission('ops:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, status, started_at as "startedAt", finished_at as "finishedAt", detail
             from job_run where job_id = $1 order by started_at desc limit 25`,
          [req.params.id],
        );
        return { runs: rows };
      });
    },
  );
}
