/**
 * Cost & capacity management + performance analytics (brief §13). Cost records
 * with capacity utilisation (computed by the pure @rios/domain capacity engine),
 * and live operational throughput metrics over existing audited activity.
 * cost:read / cost:write for cost; ops:read for performance analytics.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { utilisation, utilisationBand, totalSpendMinor, type CostLine } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const costSchema = z.object({
  category: z.string().min(1),
  period: z.string().min(1),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).default('USD'),
  capacityProvisioned: z.number().nonnegative().nullable().optional(),
  capacityUsed: z.number().nonnegative().nullable().optional(),
  capacityUnit: z.string().nullable().optional(),
});

export async function costModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { period?: string } }>(
    '/api/cost/records',
    { preHandler: requirePermission('cost:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, category, period, amount_minor as "amountMinor", currency,
                  capacity_provisioned as "capacityProvisioned", capacity_used as "capacityUsed",
                  capacity_unit as "capacityUnit"
             from cost_record
            where ($1::text is null or period = $1)
            order by period desc, category`,
          [req.query.period ?? null],
        );
        // Annotate each line with capacity utilisation, and roll up the spend.
        const records = rows.map((r) => {
          const used = r.capacityUsed != null ? Number(r.capacityUsed) : null;
          const prov = r.capacityProvisioned != null ? Number(r.capacityProvisioned) : null;
          const util = utilisation(used, prov);
          return { ...r, utilisation: util, utilisationBand: prov ? utilisationBand(util) : null };
        });
        const totalSpend = totalSpendMinor(rows as CostLine[]);
        return { records, totalSpendMinor: totalSpend };
      });
    },
  );

  app.post('/api/cost/records', { preHandler: requirePermission('cost:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = costSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid cost record', details: parsed.error.flatten() }; }
    const c = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into cost_record (tenant_id, category, period, amount_minor, currency, capacity_provisioned, capacity_used, capacity_unit)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id, category, period) do update set
           amount_minor = excluded.amount_minor, currency = excluded.currency,
           capacity_provisioned = excluded.capacity_provisioned, capacity_used = excluded.capacity_used,
           capacity_unit = excluded.capacity_unit
         returning id`,
        [ctx.tenantId, c.category, c.period, c.amountMinor, c.currency, c.capacityProvisioned ?? null, c.capacityUsed ?? null, c.capacityUnit ?? null],
      );
      await writeAudit(db, ctx, { action: 'upsert', entityType: 'cost_record', entityId: rows[0]!.id, after: { category: c.category, period: c.period }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Performance analytics: live operational throughput over audited activity.
  app.get('/api/perf/throughput', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        audit_events: number; financial_events: number; claims: number; statements: number; contracts: number;
      }>(
        `select
           (select count(*)::int from audit_log) as audit_events,
           (select count(*)::int from financial_event) as financial_events,
           (select count(*)::int from claim where not is_deleted) as claims,
           (select count(*)::int from statement_of_account) as statements,
           (select count(*)::int from contract where not is_deleted) as contracts`,
      );
      const byDay = await db.query(
        `select to_char(occurred_at, 'YYYY-MM-DD') as day, count(*)::int as events
           from audit_log group by day order by day desc limit 14`,
      );
      const k = rows[0]!;
      return {
        totals: {
          auditEvents: k.audit_events,
          financialEvents: k.financial_events,
          claims: k.claims,
          statements: k.statements,
          contracts: k.contracts,
        },
        auditByDay: byDay.rows,
      };
    });
  });
}
