/**
 * Automation module (brief §9.3, §14.1).
 *
 * The runtime side of the metadata-driven process platform: maker-checker
 * approvals, workflow instances/tasks, and the notification engine. Definitions
 * live in config_document; this module operates the instance/state tables and
 * raises in-app notifications on approval decisions.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createApprovalSchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid().optional(),
  action: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().optional(),
});

const createInstanceSchema = z.object({
  workflowKey: z.string().min(1),
  workflowVersion: z.number().int().optional(),
  entityType: z.string().min(1),
  entityId: z.string().uuid().optional(),
  currentState: z.string().min(1),
});

const createTaskSchema = z.object({
  name: z.string().min(1),
  assigneeRole: z.string().optional(),
  assigneeUserId: z.string().uuid().optional(),
  dueAt: z.string().optional(),
});

export async function automationModule(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Approvals (§14.1 maker-checker)
  // -------------------------------------------------------------------------

  app.post('/api/approvals', { preHandler: requirePermission('workflow:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createApprovalSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid approval request', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into approval_request
           (tenant_id, entity_type, entity_id, action, requested_by, payload, status)
         values ($1,$2,$3,$4,$5,$6,'pending') returning id`,
        [ctx.tenantId, b.entityType, b.entityId ?? null, b.action, ctx.userId, JSON.stringify(b.payload ?? {})],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'approval_request',
        entityId: id,
        after: { entityType: b.entityType, action: b.action, status: 'pending' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, status: 'pending' };
    });
  });

  app.get<{ Querystring: { status?: string } }>(
    '/api/approvals',
    { preHandler: requirePermission('workflow:read') },
    async (req) => {
      const ctx = authContext(req);
      const status = req.query.status ?? 'pending';
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, entity_type as "entityType", entity_id as "entityId", action,
                  requested_by as "requestedBy", payload, status, decided_by as "decidedBy",
                  decided_at as "decidedAt", decision_note as "decisionNote", created_at as "createdAt"
             from approval_request where status = $1 order by created_at desc`,
          [status],
        );
        return { approvals: rows };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/approvals/:id/decide',
    { preHandler: requirePermission('approval:decide') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = decideSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid decision', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const existing = await db.query<{ status: string; requested_by: string | null; entity_type: string; entity_id: string | null }>(
          `select status, requested_by, entity_type, entity_id from approval_request where id = $1`,
          [req.params.id],
        );
        const row = existing.rows[0];
        if (!row) {
          reply.code(404);
          return { error: 'Approval request not found' };
        }
        if (row.status !== 'pending') {
          reply.code(409);
          return { error: `Approval already ${row.status}` };
        }

        await db.query(
          `update approval_request
              set status = $1, decided_by = $2, decided_at = now(), decision_note = $3
            where id = $4`,
          [b.decision, ctx.userId, b.note ?? null, req.params.id],
        );

        // Notify the requester of the outcome (in-app).
        if (row.requested_by) {
          await db.query(
            `insert into notification
               (tenant_id, recipient_user_id, channel, subject, body, entity_type, entity_id, sent_at)
             values ($1,$2,'in_app',$3,$4,$5,$6,now())`,
            [
              ctx.tenantId,
              row.requested_by,
              `Approval ${b.decision}`,
              b.note ?? `Your approval request was ${b.decision}.`,
              row.entity_type,
              row.entity_id,
            ],
          );
        }

        await writeAudit(db, ctx, {
          action: 'decide',
          entityType: 'approval_request',
          entityId: req.params.id,
          before: { status: 'pending' },
          after: { status: b.decision },
          actorLabel: req.auth?.displayName,
        });

        return { id: req.params.id, status: b.decision };
      });
    },
  );

  // -------------------------------------------------------------------------
  // Workflow runtime (§9.3)
  // -------------------------------------------------------------------------

  app.post('/api/workflow/instances', { preHandler: requirePermission('workflow:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createInstanceSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid workflow instance', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into workflow_instance
           (tenant_id, workflow_key, workflow_version, entity_type, entity_id, current_state, status, started_by)
         values ($1,$2,$3,$4,$5,$6,'running',$7) returning id`,
        [ctx.tenantId, b.workflowKey, b.workflowVersion ?? 1, b.entityType, b.entityId ?? null, b.currentState, ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'workflow_instance',
        entityId: id,
        after: { workflowKey: b.workflowKey, entityType: b.entityType, currentState: b.currentState },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, status: 'running', currentState: b.currentState };
    });
  });

  app.get<{ Querystring: { entityType?: string; entityId?: string } }>(
    '/api/workflow/instances',
    { preHandler: requirePermission('workflow:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const instances = await db.query<{ id: string }>(
          `select id, workflow_key as "workflowKey", workflow_version as "workflowVersion",
                  entity_type as "entityType", entity_id as "entityId", current_state as "currentState",
                  status, started_by as "startedBy", started_at as "startedAt", completed_at as "completedAt"
             from workflow_instance
            where ($1::text is null or entity_type = $1)
              and ($2::uuid is null or entity_id = $2)
            order by started_at desc`,
          [req.query.entityType ?? null, req.query.entityId ?? null],
        );
        const tasks = await db.query<{ instance_id: string }>(
          `select id, instance_id, name, assignee_user_id as "assigneeUserId", assignee_role as "assigneeRole",
                  status, due_at as "dueAt", completed_at as "completedAt", created_at as "createdAt"
             from workflow_task order by created_at`,
        );
        const byInstance = new Map<string, unknown[]>();
        for (const t of tasks.rows) {
          const arr = byInstance.get(t.instance_id) ?? [];
          arr.push(t);
          byInstance.set(t.instance_id, arr);
        }
        return { instances: instances.rows.map((i) => ({ ...i, tasks: byInstance.get(i.id) ?? [] })) };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/workflow/instances/:id/tasks',
    { preHandler: requirePermission('workflow:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = createTaskSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid task', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const inst = await db.query<{ id: string }>(`select id from workflow_instance where id = $1`, [req.params.id]);
        if (!inst.rows[0]) {
          reply.code(404);
          return { error: 'Workflow instance not found' };
        }
        const { rows } = await db.query<{ id: string }>(
          `insert into workflow_task
             (tenant_id, instance_id, name, assignee_user_id, assignee_role, status, due_at)
           values ($1,$2,$3,$4,$5,'pending',$6) returning id`,
          [ctx.tenantId, req.params.id, b.name, b.assigneeUserId ?? null, b.assigneeRole ?? null, b.dueAt ?? null],
        );
        const id = rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'workflow_task',
          entityId: id,
          after: { instanceId: req.params.id, name: b.name, status: 'pending' },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { id, status: 'pending' };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/workflow/tasks/:id/complete',
    { preHandler: requirePermission('workflow:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const existing = await db.query<{ status: string }>(
          `select status from workflow_task where id = $1`,
          [req.params.id],
        );
        if (!existing.rows[0]) {
          reply.code(404);
          return { error: 'Workflow task not found' };
        }
        await db.query(
          `update workflow_task set status = 'done', completed_at = now() where id = $1`,
          [req.params.id],
        );
        await writeAudit(db, ctx, {
          action: 'complete',
          entityType: 'workflow_task',
          entityId: req.params.id,
          before: { status: existing.rows[0].status },
          after: { status: 'done' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'done' };
      });
    },
  );

  // -------------------------------------------------------------------------
  // Notifications (§9.3)
  // -------------------------------------------------------------------------

  app.get('/api/notifications', { preHandler: requirePermission('workflow:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, channel, subject, body, entity_type as "entityType", entity_id as "entityId",
                is_read as "isRead", sent_at as "sentAt", created_at as "createdAt"
           from notification where recipient_user_id = $1 order by created_at desc`,
        [ctx.userId],
      );
      return { notifications: rows };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/notifications/:id/read',
    { preHandler: requirePermission('workflow:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(
          `update notification set is_read = true where id = $1 and recipient_user_id = $2`,
          [req.params.id, ctx.userId],
        );
        if (!rowCount) {
          reply.code(404);
          return { error: 'Notification not found' };
        }
        return { id: req.params.id, isRead: true };
      });
    },
  );
}
