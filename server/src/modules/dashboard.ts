/**
 * Dashboard summary module (brief §13.5 / §30).
 *
 * Returns real-time KPIs, status distributions, recent treaty activity, and
 * an audit-log activity feed so the dashboard can surface live portfolio health
 * without any static/placeholder data.
 *
 * All queries run inside runAs() so RLS enforces tenant isolation. Money is
 * always integer minor units (bigint in DB, Number on the wire).
 *
 * Read-only; gated on the default authenticated permission (requirePermission()).
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

interface KpiRow {
  treaties: number;
  active_treaties: number;
  parties: number;
  open_claims: number;
  // The pg type parser in db.ts converts bigint (OID 20) to Number at the boundary.
  gwp_minor: number;
  outstanding_minor: number;
  pending_statements: number;
  total_incurred_minor: number;
}

interface AuditActivityRow {
  // audit_log.id is bigint; the pg type parser converts it to number.
  id: number;
  occurred_at: string;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
}

export async function dashboardModule(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard/summary', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      // ---- Single-pass KPI query -------------------------------------------
      const { rows } = await db.query<KpiRow>(
        `select
           (select count(*)::int  from contract            where not is_deleted)                                         as treaties,
           (select count(*)::int  from contract            where not is_deleted and status in ('BOUND','ACTIVE'))        as active_treaties,
           (select count(*)::int  from party               where not is_deleted)                                         as parties,
           (select count(*)::int  from claim               where not is_deleted and status not in ('CLOSED','SETTLED'))  as open_claims,
           (select coalesce(sum(amount_minor),0)::bigint
              from financial_event
             where event_type in ('DEPOSIT_PREMIUM','INSTALMENT_PREMIUM','ADJUSTMENT_PREMIUM','MINIMUM_PREMIUM'))        as gwp_minor,
           (select coalesce(sum(outstanding_minor),0)::bigint from claim where not is_deleted)                           as outstanding_minor,
           (select count(*)::int  from statement_of_account where status = 'OPEN')                                       as pending_statements,
           (select coalesce(sum(gross_loss_minor),0)::bigint from claim where not is_deleted)                            as total_incurred_minor`,
      );

      // ---- Recent treaties (sidebar table) ----------------------------------
      const recent = await db.query<{ reference: string; name: string; status: string; currency: string }>(
        `select reference, name, status, currency
           from contract
          where not is_deleted
          order by created_at desc
          limit 5`,
      );

      // ---- Treaties by status (donut chart) ---------------------------------
      const byStatus = await db.query<{ status: string; n: number }>(
        `select status, count(*)::int as n
           from contract
          where not is_deleted
          group by status
          order by n desc`,
      );

      // ---- Recent activity feed (last 10 audit_log entries) ----------------
      const activity = await db.query<AuditActivityRow>(
        `select id, occurred_at, actor_label, action, entity_type, entity_id
           from audit_log
          order by id desc
          limit 10`,
      );

      // ---- Derived KPIs ----------------------------------------------------
      const row = rows[0]!;
      const gwpMinor = row.gwp_minor;
      const totalIncurredMinor = row.total_incurred_minor;
      // Claims ratio: incurred losses / written premium × 100, one decimal place.
      const claimsRatioPercent =
        gwpMinor > 0 ? Math.round((totalIncurredMinor / gwpMinor) * 1000) / 10 : 0;

      return {
        kpis: {
          treaties: row.treaties,
          activeTreaties: row.active_treaties,
          parties: row.parties,
          openClaims: row.open_claims,
          gwpMinor,
          outstandingMinor: row.outstanding_minor,
          currency: 'USD',
          pendingStatementsCount: row.pending_statements,
          claimsRatioPercent,
        },
        recentTreaties: recent.rows,
        treatiesByStatus: byStatus.rows,
        recentActivity: activity.rows.map((r) => ({
          id: String(r.id),
          type: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id ?? null,
          actor: r.actor_label ?? null,
          at: r.occurred_at,
        })),
      };
    });
  });
}
