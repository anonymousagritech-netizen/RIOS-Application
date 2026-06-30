/**
 * Analytics & data warehouse (brief §13). A small star-schema query surface:
 * the caller picks a fact source plus dimensions and measures (both restricted
 * to a server-side whitelist - no arbitrary SQL), the module pulls the facts and
 * the pure `pivot` engine in @rios/domain aggregates them. A separate
 * catastrophe surface summarises real per-event losses and computes the standard
 * cat metrics (AAL / EP curve / PML) from an analyst-supplied Event Loss Table -
 * rates are explicit assumptions, never invented from the data.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  pivot,
  totals,
  averageAnnualLoss,
  exceedanceCurve,
  pmlProfile,
  movingAverage,
  linearRegression,
  linearTrendForecast,
  smoothedForecast,
  type Measure,
  type EltEvent,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/**
 * Each source declares a fixed SELECT (already aliased to camelCase flat keys),
 * the dimensions a caller may group by, and the measures they may aggregate.
 * Because dimensions/measures map to *known* keys on the fetched rows and the
 * pivot runs in JS, no caller input ever reaches SQL.
 */
const SOURCES: Record<string, {
  label: string;
  sql: string;
  dimensions: { key: string; label: string }[];
  measures: { field: string; label: string }[];
}> = {
  financial_event: {
    label: 'Financial events',
    sql: `select fe.event_type as "eventType", fe.direction, fe.currency,
                 to_char(fe.booked_at, 'YYYY-MM') as "bookedMonth",
                 c.line_of_business as "lob", c.contract_kind as "contractKind",
                 fe.amount_minor as "amountMinor"
            from financial_event fe
            join contract c on c.id = fe.contract_id`,
    dimensions: [
      { key: 'eventType', label: 'Event type' },
      { key: 'direction', label: 'Direction (DR/CR)' },
      { key: 'currency', label: 'Currency' },
      { key: 'bookedMonth', label: 'Booked month' },
      { key: 'lob', label: 'Line of business' },
      { key: 'contractKind', label: 'Contract kind' },
    ],
    measures: [{ field: 'amountMinor', label: 'Amount (minor)' }],
  },
  claim: {
    label: 'Claims',
    sql: `select cl.status, cl.currency,
                 c.line_of_business as "lob", c.contract_kind as "contractKind",
                 ce.event_code as "catEvent",
                 cl.gross_loss_minor as "grossLossMinor",
                 cl.outstanding_minor as "outstandingMinor",
                 cl.paid_minor as "paidMinor"
            from claim cl
            join contract c on c.id = cl.contract_id
            left join cat_event ce on ce.id = cl.cat_event_id
           where not cl.is_deleted`,
    dimensions: [
      { key: 'status', label: 'Status' },
      { key: 'currency', label: 'Currency' },
      { key: 'lob', label: 'Line of business' },
      { key: 'contractKind', label: 'Contract kind' },
      { key: 'catEvent', label: 'Catastrophe event' },
    ],
    measures: [
      { field: 'grossLossMinor', label: 'Gross loss (minor)' },
      { field: 'outstandingMinor', label: 'Outstanding (minor)' },
      { field: 'paidMinor', label: 'Paid (minor)' },
    ],
  },
};

/**
 * Validate a pivot request against the source whitelist and run it. Returns the
 * result or a typed error - shared by the ad-hoc pivot and saved reports.
 */
async function executePivot(
  db: Db, source: string, dimensions: string[], measures: Measure[],
): Promise<{ error: string; status: number } | { result: Record<string, unknown> }> {
  const src = SOURCES[source];
  if (!src) return { error: `Unknown source "${source}"`, status: 404 };
  const dimSet = new Set(src.dimensions.map((d) => d.key));
  const measSet = new Set(src.measures.map((m) => m.field));
  const badDim = dimensions.find((d) => !dimSet.has(d));
  if (badDim) return { error: `Dimension "${badDim}" is not available on ${source}`, status: 422 };
  const badMeasure = measures.find((m) => m.agg !== 'count' && (!m.field || !measSet.has(m.field)));
  if (badMeasure) return { error: `Measure field "${badMeasure.field}" is not available on ${source}`, status: 422 };
  const { rows } = await db.query(src.sql);
  return { result: { source, dimensions, cells: pivot(rows, dimensions, measures), totals: totals(rows, measures), factCount: rows.length } };
}

const reportSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  source: z.string().min(1),
  dimensions: z.array(z.string()).default([]),
  measures: z.array(z.object({
    field: z.string().optional(),
    agg: z.enum(['sum', 'count', 'avg', 'min', 'max']),
    as: z.string().optional(),
  })).min(1),
});

const dashboardSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  widgets: z.array(z.object({
    title: z.string().min(1),
    reportKey: z.string().min(1),
  })).min(1),
});

const pivotSchema = z.object({
  source: z.string(),
  dimensions: z.array(z.string()).default([]),
  measures: z.array(z.object({
    field: z.string().optional(),
    agg: z.enum(['sum', 'count', 'avg', 'min', 'max']),
    as: z.string().optional(),
  })).min(1),
});

const forecastSchema = z.object({
  series: z.array(z.number()).min(2),
  periods: z.number().int().positive().max(60).default(3),
  method: z.enum(['linear', 'smoothing']).default('linear'),
  alpha: z.number().min(0).max(1).default(0.5),
  maWindow: z.number().int().positive().max(24).optional(),
});

const eltSchema = z.object({
  elt: z.array(z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    rate: z.number().positive(),
    lossMinor: z.number().nonnegative(),
  })).min(1),
  returnPeriods: z.array(z.number().positive()).default([10, 25, 50, 100, 250]),
});

export async function analyticsModule(app: FastifyInstance): Promise<void> {
  // Metadata that drives the pivot builder UI.
  app.get('/api/analytics/sources', { preHandler: requirePermission('reporting:read') }, async () => {
    return {
      sources: Object.entries(SOURCES).map(([key, s]) => ({
        key, label: s.label, dimensions: s.dimensions, measures: s.measures,
      })),
    };
  });

  // Run a pivot: fetch the whitelisted facts and aggregate in the pure engine.
  app.post('/api/analytics/pivot', { preHandler: requirePermission('reporting:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = pivotSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid pivot request', details: parsed.error.flatten() };
    }
    return runAs(ctx, async (db) => {
      const out = await executePivot(db, parsed.data.source, parsed.data.dimensions, parsed.data.measures as Measure[]);
      if ('error' in out) { reply.code(out.status); return { error: out.error }; }
      return out.result;
    });
  });

  // Real per-catastrophe-event loss summary (no invented rates).
  app.get('/api/analytics/catastrophe/events', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select ce.id, ce.event_code as "eventCode", ce.name, ce.peril, ce.region,
                ce.event_date as "eventDate", ce.status,
                coalesce(count(cl.id),0)::int as "claimCount",
                coalesce(sum(cl.gross_loss_minor),0)::bigint as "grossLossMinor",
                coalesce(sum(cl.outstanding_minor),0)::bigint as "outstandingMinor",
                coalesce(sum(cl.paid_minor),0)::bigint as "paidMinor"
           from cat_event ce
           left join claim cl on cl.cat_event_id = ce.id and not cl.is_deleted
          group by ce.id
          order by "grossLossMinor" desc, ce.event_date desc nulls last`,
      );
      return { events: rows };
    });
  });

  // Compute cat metrics from a supplied Event Loss Table (explicit rate assumptions).
  app.post('/api/analytics/catastrophe/metrics', { preHandler: requirePermission('reporting:read') }, async (req, reply) => {
    const parsed = eltSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid ELT', details: parsed.error.flatten() };
    }
    const elt = parsed.data.elt as EltEvent[];
    return {
      averageAnnualLossMinor: averageAnnualLoss(elt),
      exceedanceCurve: exceedanceCurve(elt),
      pmlProfile: pmlProfile(elt, parsed.data.returnPeriods),
    };
  });

  // Forecast a metric series forward (linear trend or exponential smoothing).
  app.post('/api/analytics/forecast', { preHandler: requirePermission('reporting:read') }, async (req, reply) => {
    const parsed = forecastSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid forecast request', details: parsed.error.flatten() };
    }
    const { series, periods, method, alpha, maWindow } = parsed.data;
    const fit = linearRegression(series);
    const forecast = method === 'smoothing'
      ? Array.from({ length: periods }, (_, k) => ({ index: series.length + k, value: smoothedForecast(series, alpha) }))
      : linearTrendForecast(series, periods);
    return {
      method,
      fit,
      forecast,
      trailingAverage: maWindow ? movingAverage(series, maWindow) : undefined,
    };
  });

  // --- Report Designer: saved report definitions over the fact sources ---

  // List the latest version of every saved report.
  app.get('/api/analytics/reports', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select distinct on (key) key, version, status, body->>'name' as name, body
           from config_document where kind = 'report'
          order by key, version desc`,
      );
      return { reports: rows };
    });
  });

  // Save a report definition (validated against the source whitelist), published.
  app.post('/api/analytics/reports', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid report', details: parsed.error.flatten() };
    }
    const def = parsed.data;
    const src = SOURCES[def.source];
    if (!src) { reply.code(422); return { error: `Unknown source "${def.source}"` }; }
    return runAs(ctx, async (db) => {
      const next = await db.query<{ v: number }>(
        `select coalesce(max(version),0)+1 as v from config_document where kind = 'report' and key = $1`, [def.key],
      );
      await db.query(`update config_document set status='archived' where kind='report' and key=$1 and status='published'`, [def.key]);
      const { rows } = await db.query<{ id: string }>(
        `insert into config_document (tenant_id, kind, key, version, status, body, created_by)
         values ($1,'report',$2,$3,'published',$4,$5) returning id`,
        [ctx.tenantId, def.key, next.rows[0]!.v, JSON.stringify(def), ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'publish', entityType: 'config_document:report', entityId: rows[0]!.id,
        after: { key: def.key, version: next.rows[0]!.v }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, key: def.key, version: next.rows[0]!.v };
    });
  });

  // Run a saved report: load its definition and execute the pivot.
  app.post<{ Params: { key: string } }>(
    '/api/analytics/reports/:key/run',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ body: { source: string; dimensions: string[]; measures: Measure[] } }>(
          `select body from config_document where kind='report' and key=$1
            order by (status='published') desc, version desc limit 1`,
          [req.params.key],
        );
        if (!rows[0]) { reply.code(404); return { error: 'Report not found' }; }
        const def = rows[0].body;
        const out = await executePivot(db, def.source, def.dimensions ?? [], def.measures);
        if ('error' in out) { reply.code(out.status); return { error: out.error }; }
        return { key: req.params.key, ...out.result };
      });
    },
  );

  // --- Dashboard Designer: dashboards composed of saved-report widget tiles ---

  app.get('/api/analytics/dashboards', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select distinct on (key) key, version, body->>'name' as name, body
           from config_document where kind = 'dashboard' order by key, version desc`,
      );
      return { dashboards: rows };
    });
  });

  app.post('/api/analytics/dashboards', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = dashboardSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid dashboard', details: parsed.error.flatten() };
    }
    const def = parsed.data;
    return runAs(ctx, async (db) => {
      const next = await db.query<{ v: number }>(
        `select coalesce(max(version),0)+1 as v from config_document where kind = 'dashboard' and key = $1`, [def.key],
      );
      await db.query(`update config_document set status='archived' where kind='dashboard' and key=$1 and status='published'`, [def.key]);
      const { rows } = await db.query<{ id: string }>(
        `insert into config_document (tenant_id, kind, key, version, status, body, created_by)
         values ($1,'dashboard',$2,$3,'published',$4,$5) returning id`,
        [ctx.tenantId, def.key, next.rows[0]!.v, JSON.stringify(def), ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'publish', entityType: 'config_document:dashboard', entityId: rows[0]!.id,
        after: { key: def.key, version: next.rows[0]!.v }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, key: def.key, version: next.rows[0]!.v };
    });
  });

  // Render a dashboard: resolve each widget's report to a headline figure.
  app.post<{ Params: { key: string } }>(
    '/api/analytics/dashboards/:key/render',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const dash = await db.query<{ body: { name: string; widgets: { title: string; reportKey: string }[] } }>(
          `select body from config_document where kind='dashboard' and key=$1
            order by (status='published') desc, version desc limit 1`,
          [req.params.key],
        );
        if (!dash.rows[0]) { reply.code(404); return { error: 'Dashboard not found' }; }
        const widgets = [];
        for (const w of dash.rows[0].body.widgets ?? []) {
          const rep = await db.query<{ body: { source: string; dimensions: string[]; measures: Measure[] } }>(
            `select body from config_document where kind='report' and key=$1
              order by (status='published') desc, version desc limit 1`,
            [w.reportKey],
          );
          if (!rep.rows[0]) { widgets.push({ title: w.title, reportKey: w.reportKey, error: 'report not found' }); continue; }
          const def = rep.rows[0].body;
          const out = await executePivot(db, def.source, def.dimensions ?? [], def.measures);
          if ('error' in out) { widgets.push({ title: w.title, reportKey: w.reportKey, error: out.error }); continue; }
          const r = out.result as { totals: Record<string, number>; cells: unknown[]; factCount: number };
          widgets.push({ title: w.title, reportKey: w.reportKey, total: r.totals.total ?? 0, groups: r.cells.length, factCount: r.factCount });
        }
        return { key: req.params.key, name: dash.rows[0].body.name, widgets };
      });
    },
  );
}
