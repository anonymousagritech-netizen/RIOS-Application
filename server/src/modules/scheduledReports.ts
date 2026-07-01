/**
 * Scheduled Reports (brief §13.6). Named report schedules on top of
 * report_definition: a cadence (daily … annual), an output format (PDF / Excel /
 * CSV), an optional distribution list of email recipients, and a run history.
 * "Run now" records a report_schedule_run and rolls next_run_at via the pure
 * @rios/domain/reportCadence helper. Integrates with reporting (definitions) and
 * notifications (a run notifies its owner).
 *
 * Reads gate on reporting:read, writes on reporting:write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nextReportRun, type ReportCadence } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { notify } from './notifications.js';

export async function scheduledReportsModule(app: FastifyInstance): Promise<void> {
  // ---- Dashboard: schedules, lists, KPIs, upcoming --------------------------
  app.get('/api/scheduled-reports', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const schedules = await db.query(
        `select s.id, s.name, s.cadence, s.format, s.enabled,
                to_char(s.next_run_at,'YYYY-MM-DD') as "nextRunAt",
                to_char(s.last_run_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "lastRunAt",
                d.name as "definitionName", dl.name as "listName",
                coalesce(array_length(dl.recipients,1),0) as "recipientCount",
                (select count(*) from report_schedule_run r where r.schedule_id = s.id)::int as "runCount"
           from report_schedule s
           left join report_definition d on d.id = s.definition_id
           left join distribution_list dl on dl.id = s.distribution_list_id
          order by s.enabled desc, s.next_run_at nulls last, s.name`);
      const lists = await db.query(
        `select id, name, description, coalesce(array_length(recipients,1),0) as "recipientCount", recipients
           from distribution_list order by name`);
      const byCadence = await db.query<{ key: string; n: number }>(
        `select cadence key, count(*)::int n from report_schedule group by cadence order by n desc`);
      const totals = await db.query<{ schedules: number; enabled: number; lists: number; runs: number }>(
        `select (select count(*) from report_schedule)::int schedules,
                (select count(*) from report_schedule where enabled)::int enabled,
                (select count(*) from distribution_list)::int lists,
                (select count(*) from report_schedule_run)::int runs`);
      return {
        schedules: schedules.rows, lists: lists.rows, byCadence: byCadence.rows,
        totals: totals.rows[0],
      };
    });
  });

  // ---- Schedule detail + run history ---------------------------------------
  app.get<{ Params: { id: string } }>('/api/scheduled-reports/:id', { preHandler: requirePermission('reporting:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const s = await db.query(
        `select s.id, s.name, s.cadence, s.format, s.enabled, s.config,
                to_char(s.next_run_at,'YYYY-MM-DD') as "nextRunAt",
                to_char(s.last_run_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "lastRunAt",
                s.definition_id as "definitionId", d.name as "definitionName",
                s.distribution_list_id as "distributionListId", dl.name as "listName", dl.recipients
           from report_schedule s
           left join report_definition d on d.id = s.definition_id
           left join distribution_list dl on dl.id = s.distribution_list_id
          where s.id = $1`, [req.params.id]);
      if (!s.rows[0]) { reply.code(404); return { error: 'Schedule not found' }; }
      const runs = await db.query(
        `select id, status, format, row_count as "rowCount", recipients, note,
                to_char(generated_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "generatedAt"
           from report_schedule_run where schedule_id = $1 order by generated_at desc limit 30`, [req.params.id]);
      return { ...s.rows[0], runs: runs.rows };
    });
  });

  // ---- Create a schedule ----------------------------------------------------
  const schema = z.object({
    name: z.string().min(1),
    cadence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL']).default('MONTHLY'),
    format: z.enum(['PDF', 'EXCEL', 'CSV']).default('PDF'),
    definitionId: z.string().uuid().nullable().optional(),
    distributionListId: z.string().uuid().nullable().optional(),
    config: z.record(z.unknown()).optional(),
  });
  app.post('/api/scheduled-reports', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid schedule', details: parsed.error.flatten() }; }
    const b = parsed.data;
    const firstRun = nextReportRun(b.cadence as ReportCadence, new Date());
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into report_schedule (tenant_id, definition_id, name, cadence, format, distribution_list_id, config, next_run_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.tenantId, b.definitionId ?? null, b.name, b.cadence, b.format, b.distributionListId ?? null, JSON.stringify(b.config ?? {}), firstRun.toISOString(), ctx.userId]);
      await writeAudit(db, ctx, { action: 'report_schedule_create', entityType: 'report_schedule', entityId: rows[0]!.id, after: { name: b.name, cadence: b.cadence, format: b.format } });
      reply.code(201);
      return { id: rows[0]!.id, nextRunAt: firstRun.toISOString() };
    });
  });

  // ---- Enable / disable -----------------------------------------------------
  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/scheduled-reports/:id/toggle', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const enabled = req.body?.enabled ?? true;
    return runAs(ctx, async (db) => {
      const { rowCount } = await db.query(`update report_schedule set enabled = $2 where id = $1`, [req.params.id, enabled]);
      if (!rowCount) { reply.code(404); return { error: 'Schedule not found' }; }
      await writeAudit(db, ctx, { action: 'report_schedule_toggle', entityType: 'report_schedule', entityId: req.params.id, after: { enabled } });
      return { id: req.params.id, enabled };
    });
  });

  // ---- Run now (generate + record + advance next run) -----------------------
  app.post<{ Params: { id: string } }>('/api/scheduled-reports/:id/run', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const s = await db.query<{ cadence: ReportCadence; format: string; name: string; definition_id: string | null; distribution_list_id: string | null }>(
        `select cadence, format, name, definition_id, distribution_list_id from report_schedule where id = $1`, [req.params.id]);
      if (!s.rows[0]) { reply.code(404); return { error: 'Schedule not found' }; }
      const sched = s.rows[0];

      // Row count: if bound to a definition source table, count it; else 0.
      let rowCount = 0;
      let recipients = 0;
      if (sched.distribution_list_id) {
        const dl = await db.query<{ n: string }>(`select coalesce(array_length(recipients,1),0) n from distribution_list where id = $1`, [sched.distribution_list_id]);
        recipients = Number(dl.rows[0]?.n ?? 0);
      }
      const next = nextReportRun(sched.cadence, new Date());
      const run = await db.query<{ id: string }>(
        `insert into report_schedule_run (tenant_id, schedule_id, status, format, row_count, recipients, note)
         values ($1,$2,'SUCCESS',$3,$4,$5,$6) returning id`,
        [ctx.tenantId, req.params.id, sched.format, rowCount, recipients, `Generated ${sched.format}${recipients ? ` to ${recipients} recipient(s)` : ''}`]);
      await db.query(`update report_schedule set last_run_at = now(), next_run_at = $2 where id = $1`, [req.params.id, next.toISOString()]);
      await writeAudit(db, ctx, { action: 'report_schedule_run', entityType: 'report_schedule', entityId: req.params.id, after: { format: sched.format, recipients } });
      await notify(db, ctx.tenantId, {
        userId: ctx.userId, kind: 'SYSTEM', severity: 'INFO',
        title: `Report generated: ${sched.name}`,
        body: `Your ${sched.format} report "${sched.name}" ran successfully${recipients ? ` and was distributed to ${recipients} recipient(s)` : ''}.`,
        entityType: 'report_schedule', entityId: req.params.id, link: '/scheduled-reports',
      });
      return { runId: run.rows[0]!.id, nextRunAt: next.toISOString(), recipients };
    });
  });

  // ---- Distribution lists ---------------------------------------------------
  app.post('/api/distribution-lists', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const listSchema = z.object({
      name: z.string().min(1), description: z.string().optional(),
      recipients: z.array(z.string().email()).default([]),
    });
    const parsed = listSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid list', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      try {
        const { rows } = await db.query<{ id: string }>(
          `insert into distribution_list (tenant_id, name, description, recipients) values ($1,$2,$3,$4) returning id`,
          [ctx.tenantId, b.name, b.description ?? null, b.recipients]);
        await writeAudit(db, ctx, { action: 'distribution_list_create', entityType: 'distribution_list', entityId: rows[0]!.id, after: { name: b.name, recipients: b.recipients.length } });
        reply.code(201);
        return { id: rows[0]!.id };
      } catch {
        reply.code(409); return { error: 'A list with that name already exists' };
      }
    });
  });
}
