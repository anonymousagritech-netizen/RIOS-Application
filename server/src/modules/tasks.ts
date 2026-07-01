/**
 * Task management & SLA monitoring (Operations). Assignable work items with a
 * priority, due date (SLA) and an optional link to the business entity they
 * concern. Other modules raise tasks (referrals, renewals, reviews) so nothing
 * is dropped; this console tracks them to done. SLA logic is in @rios/domain.
 *
 * Reads gate on ops:read, writes on ops:write. SLA "now" is the server clock
 * (the domain stays clockless).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { taskSla, taskSummary, type TaskStatus } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

interface TaskRow {
  id: string; title: string; description: string | null; kind: string; priority: string; status: string;
  assignee: string | null; assigneeName: string | null; due_at: string | null;
  entity_type: string | null; entity_id: string | null; entity_label: string | null;
  created_at: string; completed_at: string | null;
}

const shape = (r: TaskRow, now: number) => ({
  id: r.id, title: r.title, description: r.description, kind: r.kind, priority: r.priority, status: r.status,
  assignee: r.assignee, assigneeName: r.assigneeName, dueAt: r.due_at,
  entityType: r.entity_type, entityId: r.entity_id, entityLabel: r.entity_label,
  createdAt: r.created_at, completedAt: r.completed_at,
  sla: taskSla(r.status as TaskStatus, r.due_at ? new Date(r.due_at).getTime() : null, now),
});

export async function tasksModule(app: FastifyInstance): Promise<void> {
  // ---- List (filter by status / assignee=me) -------------------------------
  app.get<{ Querystring: { status?: string; assignee?: string } }>('/api/tasks', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    const { status, assignee } = req.query;
    const mine = assignee === 'me';
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<TaskRow>(
        `select t.id, t.title, t.description, t.kind, t.priority, t.status, t.assignee,
                u.display_name as "assigneeName", t.due_at, t.entity_type, t.entity_id, t.entity_label,
                t.created_at, t.completed_at
           from task t left join app_user u on u.id = t.assignee
          where ($1::text is null or t.status = $1)
            and ($2::uuid is null or t.assignee = $2)
          order by (t.status in ('DONE','CANCELLED')),
                   case t.priority when 'URGENT' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end,
                   t.due_at asc nulls last, t.created_at desc`,
        [status ?? null, mine ? ctx.userId : null],
      );
      const now = Date.now();
      return { tasks: rows.map((r) => shape(r, now)) };
    });
  });

  // ---- Summary (KPIs) ------------------------------------------------------
  app.get('/api/tasks/summary', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ status: TaskStatus; due_at: string | null; priority: string }>(
        `select status, due_at, priority from task`,
      );
      const now = Date.now();
      return taskSummary(rows.map((r) => ({ status: r.status, dueAtMs: r.due_at ? new Date(r.due_at).getTime() : null, priority: r.priority })), now);
    });
  });

  // ---- Create --------------------------------------------------------------
  const createSchema = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(['GENERAL', 'REFERRAL', 'REVIEW', 'RENEWAL', 'CLAIM', 'PLACEMENT', 'COMPLIANCE']).default('GENERAL'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    assignee: z.string().uuid().optional(),
    dueAt: z.string().optional(),
    entityType: z.string().optional(), entityId: z.string().uuid().optional(), entityLabel: z.string().optional(),
  });
  app.post('/api/tasks', { preHandler: requirePermission('ops:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid task', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into task (tenant_id, title, description, kind, priority, assignee, due_at, entity_type, entity_id, entity_label, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [ctx.tenantId, b.title, b.description ?? null, b.kind, b.priority, b.assignee ?? ctx.userId, b.dueAt ?? null, b.entityType ?? null, b.entityId ?? null, b.entityLabel ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, { action: 'task_create', entityType: 'task', entityId: rows[0]!.id, after: { title: b.title, kind: b.kind } });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // ---- Update status -------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/tasks/:id/status', { preHandler: requirePermission('ops:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const status = (req.body as { status?: string })?.status;
    if (!status || !['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'].includes(status)) {
      reply.code(400); return { error: 'Invalid status' };
    }
    const done = status === 'DONE' || status === 'CANCELLED';
    return runAs(ctx, async (db) => {
      const r = await db.query(
        `update task set status = $2, completed_at = case when $3 then now() else null end, updated_at = now()
          where id = $1 returning id`,
        [req.params.id, status, done],
      );
      if (!r.rows[0]) { reply.code(404); return { error: 'Task not found' }; }
      await writeAudit(db, ctx, { action: 'task_status', entityType: 'task', entityId: req.params.id, after: { status } });
      return { ok: true, status };
    });
  });
}
