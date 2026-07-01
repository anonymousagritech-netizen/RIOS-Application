/**
 * Workflow Engine console (brief §11). An operational view over the workflow
 * infrastructure that already exists (workflow_instance, workflow_task,
 * approval_request, sla_target): live instances by state, tasks scored for SLA
 * and escalation (@rios/domain/escalation), the approval matrix / pipeline, SLA
 * targets, and the current escalation queue. This unifies the pieces the
 * designer and automation modules produce into one control tower.
 *
 * Read-only; gated on workflow:read. Times are epoch ms into the domain engine.
 */

import type { FastifyInstance } from 'fastify';
import { slaState, slaBook, type SlaResult } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

async function gather(db: Db, nowMs: number) {
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params).then((r) => r.rows);

  const instancesByState = await q<{ key: string; n: number }>(
    `select current_state key, count(*)::int n from workflow_instance group by current_state order by n desc`);
  const instancesByStatus = await q<{ key: string; n: number }>(
    `select status key, count(*)::int n from workflow_instance group by status order by n desc`);

  const tasks = await q<{ id: string; name: string; status: string; assigneeRole: string | null; instanceState: string | null; workflowKey: string | null; dueMs: string | null; completedMs: string | null }>(
    `select t.id, t.name, t.status, t.assignee_role as "assigneeRole",
            wi.current_state as "instanceState", wi.workflow_key as "workflowKey",
            (extract(epoch from t.due_at) * 1000)::bigint as "dueMs",
            (extract(epoch from t.completed_at) * 1000)::bigint as "completedMs"
       from workflow_task t left join workflow_instance wi on wi.id = t.instance_id
      order by t.due_at nulls last limit 200`);

  const approvals = await q<{ id: string; action: string; entityType: string; status: string; requestedBy: string | null; decidedBy: string | null; createdMs: string }>(
    `select ar.id, ar.action, ar.entity_type as "entityType", ar.status,
            ru.email as "requestedBy", du.email as "decidedBy",
            (extract(epoch from ar.created_at) * 1000)::bigint as "createdMs"
       from approval_request ar
       left join app_user ru on ru.id = ar.requested_by
       left join app_user du on du.id = ar.decided_by
      order by ar.created_at desc limit 50`);
  const approvalsByStatus = await q<{ key: string; n: number }>(
    `select status key, count(*)::int n from approval_request group by status order by n desc`);
  const approvalsByAction = await q<{ key: string; n: number }>(
    `select action key, count(*)::int n from approval_request group by action order by n desc limit 8`);

  const slaTargets = await q<{ id: string; service: string; metric: string; targetValue: string; unit: string }>(
    `select id, service, metric, target_value as "targetValue", unit from sla_target order by service, metric limit 40`);

  return { instancesByState, instancesByStatus, tasks, approvals, approvalsByStatus, approvalsByAction, slaTargets, nowMs };
}

export async function workflowEngineModule(app: FastifyInstance): Promise<void> {
  app.get('/api/workflow-engine', { preHandler: requirePermission('workflow:read') }, async (req) => {
    const ctx = authContext(req);
    const nowMs = Date.now();
    return runAs(ctx, async (db) => {
      const g = await gather(db, nowMs);

      const isDone = (s: string) => ['DONE', 'COMPLETED', 'CLOSED', 'CANCELLED'].includes(s?.toUpperCase());
      const scoredTasks = g.tasks.map((t) => {
        const due = t.dueMs != null ? Number(t.dueMs) : null;
        const completed = t.completedMs != null ? Number(t.completedMs) : isDone(t.status) ? nowMs : null;
        const sla = slaState({ dueAt: due, now: nowMs, completedAt: completed });
        return {
          id: t.id, name: t.name, status: t.status, assigneeRole: t.assigneeRole,
          workflowKey: t.workflowKey, instanceState: t.instanceState,
          dueAt: due != null ? new Date(due).toISOString() : null,
          slaState: sla.state, escalationTier: sla.escalationTier, breached: sla.breached,
          overdueHours: sla.overdueMs ? Math.round(sla.overdueMs / 3_600_000) : 0,
        };
      });
      const book = slaBook(scoredTasks.map((t): SlaResult => ({
        state: t.slaState, overdueMs: t.overdueHours * 3_600_000, remainingMs: 0,
        escalationTier: t.escalationTier, breached: t.breached,
      })));

      // Escalation queue: breached / open tasks, worst first.
      const escalations = scoredTasks
        .filter((t) => t.breached || t.slaState === 'DUE_SOON' || t.slaState === 'AT_RISK')
        .sort((a, b) => b.escalationTier - a.escalationTier || b.overdueHours - a.overdueHours)
        .slice(0, 25);

      const openApprovals = g.approvals.filter((a) => a.status === 'pending').length;

      return {
        totals: {
          instances: g.instancesByState.reduce((s, i) => s + i.n, 0),
          openTasks: scoredTasks.filter((t) => t.slaState !== 'DONE' && t.slaState !== 'NO_DUE').length,
          breachedTasks: book.breached,
          slaCompliancePct: book.compliancePct,
          escalations: book.escalations,
          pendingApprovals: openApprovals,
          slaTargets: g.slaTargets.length,
        },
        instancesByState: g.instancesByState,
        instancesByStatus: g.instancesByStatus,
        slaBook: book,
        tasks: scoredTasks.slice(0, 60),
        escalations,
        approvals: g.approvals,
        approvalsByStatus: g.approvalsByStatus,
        approvalsByAction: g.approvalsByAction,
        slaTargets: g.slaTargets,
      };
    });
  });
}
