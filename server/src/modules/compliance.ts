/**
 * Regulatory & Compliance command center (brief §18). A single compliance
 * surface stitched from cross-cutting evidence that already exists in the
 * platform: the hash-chained audit_log (audit dashboard + integrity check +
 * per-user activity), the approval_request log, the regulatory_return register
 * and report_schedule (a forward compliance calendar), and treaty_version (a
 * policy/document version history). Nothing here is a new source of truth - it
 * is the assurance view over the whole system.
 *
 * Read-only; gated on regulatory:read.
 */

import type { FastifyInstance } from 'fastify';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

const n = (v: unknown) => Number(v ?? 0);

async function gather(db: Db) {
  const q = <T extends Record<string, unknown>>(sql: string) => db.query<T>(sql).then((r) => r.rows);

  const totals = (await q<{ audit: number; audit30: number; approvals: number; approvals_pending: number; returns: number }>(
    `select (select count(*) from audit_log)::int audit,
            (select count(*) from audit_log where occurred_at > now() - interval '30 days')::int audit30,
            (select count(*) from approval_request)::int approvals,
            (select count(*) from approval_request where status = 'pending')::int approvals_pending,
            (select count(*) from regulatory_return)::int returns`))[0]
    ?? { audit: 0, audit30: 0, approvals: 0, approvals_pending: 0, returns: 0 };

  // Hash-chain integrity: every row's prev_hash must equal the prior row's hash.
  const chain = (await q<{ ok: boolean; broken: number; verified_pct: number }>(
    `select bool_and(prev_hash is null or prev_hash = prev_row) ok,
            count(*) filter (where prev_hash is not null and prev_hash <> prev_row)::int broken,
            round(100.0 * count(*) filter (where prev_hash is null or prev_hash = prev_row)
                  / greatest(count(*),1), 1)::float verified_pct
       from (select prev_hash, lag(row_hash) over (order by id) prev_row from audit_log) t`))[0]
    ?? { ok: true, broken: 0, verified_pct: 100 };

  const byAction = await q<{ key: string; n: number }>(
    `select action key, count(*)::int n from audit_log group by action order by n desc limit 10`);
  const byEntityType = await q<{ key: string; n: number }>(
    `select entity_type key, count(*)::int n from audit_log group by entity_type order by n desc limit 10`);
  const recent = await q<{ at: string; action: string; actor: string | null; entityType: string; entityId: string }>(
    `select to_char(occurred_at,'YYYY-MM-DD"T"HH24:MI:SSZ') at, action, actor_label as actor,
            entity_type as "entityType", entity_id as "entityId"
       from audit_log order by id desc limit 25`);

  const approvals = await q<{ id: string; action: string; entityType: string; status: string; requestedBy: string | null; decidedBy: string | null; decidedAt: string | null; note: string | null }>(
    `select ar.id, ar.action, ar.entity_type as "entityType", ar.status,
            ru.email as "requestedBy", du.email as "decidedBy",
            to_char(ar.decided_at,'YYYY-MM-DD') as "decidedAt", ar.decision_note as note
       from approval_request ar
       left join app_user ru on ru.id = ar.requested_by
       left join app_user du on du.id = ar.decided_by
      order by ar.created_at desc limit 30`);

  const activity = await q<{ actor: string | null; actorId: string | null; actions: number; lastAt: string }>(
    `select actor_label as actor, actor_user_id as "actorId", count(*)::int actions,
            to_char(max(occurred_at),'YYYY-MM-DD"T"HH24:MI:SSZ') as "lastAt"
       from audit_log group by actor_label, actor_user_id order by actions desc limit 15`);

  // Forward compliance calendar: regulatory returns + scheduled reports.
  const calendar = await q<{ type: string; title: string; due: string | null; status: string }>(
    `select 'RETURN' type, coalesce(reference, kind) title, period as due, status
       from regulatory_return
     union all
     select 'REPORT' type, name title, to_char(next_run_at,'YYYY-MM-DD') due,
            case when enabled then 'scheduled' else 'paused' end
       from report_schedule
      order by due nulls last limit 30`);

  const policyHistory = await q<{ ref: string; versionNo: number; note: string | null; at: string }>(
    `select c.reference ref, v.version_no as "versionNo", v.note,
            to_char(v.created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') at
       from treaty_version v join contract c on c.id = v.contract_id
      order by v.created_at desc limit 20`);

  return { totals, chain, byAction, byEntityType, recent, approvals, activity, calendar, policyHistory };
}

export async function complianceModule(app: FastifyInstance): Promise<void> {
  app.get('/api/compliance', { preHandler: requirePermission('regulatory:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const g = await gather(db);
      const calendarDue = g.calendar.filter((c) => c.status !== 'approved' && c.status !== 'filed').length;
      return {
        totals: {
          auditEntries: g.totals.audit,
          auditLast30d: g.totals.audit30,
          approvals: g.totals.approvals,
          approvalsPending: g.totals.approvals_pending,
          regReturns: g.totals.returns,
          calendarDue,
          chainOk: g.chain.ok !== false,
          chainBroken: n(g.chain.broken),
          chainVerifiedPct: n(g.chain.verified_pct),
        },
        audit: { byAction: g.byAction, byEntityType: g.byEntityType, recent: g.recent },
        approvals: g.approvals,
        activity: g.activity,
        calendar: g.calendar,
        policyHistory: g.policyHistory,
      };
    });
  });
}
