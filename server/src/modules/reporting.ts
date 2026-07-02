/**
 * Reporting & BI module (brief §13 - governed report definitions, execution, export).
 *
 * SAFETY IS CRITICAL: report queries are assembled from a fixed allowlist of
 * sources, columns and filter operators. User input never reaches the SQL as an
 * identifier - sources/columns/ops are validated against the allowlist below, and
 * only the *values* of filters are bound as parameters ($1,$2,…). Because every
 * identifier originates from the constant allowlist (not the request), it is safe
 * to interpolate once validated. RLS scopes all rows to the active tenant.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { buildXlsx } from '../lib/xlsx.js';
import { buildPdf } from '../lib/pdf.js';

// ---------------------------------------------------------------------------
// Governed allowlist: the ONLY tables/columns a report may touch.
// ---------------------------------------------------------------------------
const SOURCES = {
  contracts: {
    table: 'contract',
    columns: ['id', 'reference', 'name', 'contract_kind', 'basis', 'line_of_business', 'direction', 'currency', 'status', 'period_start', 'period_end'],
  },
  claims: {
    table: 'claim',
    columns: ['id', 'reference', 'contract_id', 'currency', 'gross_loss_minor', 'outstanding_minor', 'paid_minor', 'status', 'loss_date', 'notified_date'],
  },
  financial_events: {
    table: 'financial_event',
    columns: ['id', 'contract_id', 'event_type', 'direction', 'amount_minor', 'currency', 'booked_at'],
  },
  statements: {
    table: 'statement_of_account',
    columns: ['id', 'reference', 'contract_id', 'currency', 'balance_minor', 'status'],
  },
  parties: {
    table: 'party',
    columns: ['id', 'reference', 'legal_name', 'short_name', 'kind', 'country', 'status'],
  },
} as const;

type SourceKey = keyof typeof SOURCES;

const FILTER_OPS = ['=', '!=', '>', '<', '>=', '<=', 'like'] as const;
type FilterOp = (typeof FILTER_OPS)[number];

const filterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(FILTER_OPS),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const reportShapeSchema = z.object({
  source: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  filters: z.array(filterSchema).optional(),
  grouping: z.array(z.string().min(1)).optional(),
});

const createDefinitionSchema = reportShapeSchema.extend({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});

interface ReportShape {
  source: string;
  columns: string[];
  filters?: { field: string; op: FilterOp; value: string | number | boolean | null }[];
  grouping?: string[];
}

interface ValidationError {
  error: string;
}

interface BuiltQuery {
  text: string;
  params: unknown[];
  source: SourceKey;
}

/**
 * Validate a report shape against the allowlist and build a parameterised SELECT.
 * Returns either a built query or a 400-worthy validation error. Identifiers are
 * taken only from SOURCES (never from the request), so interpolation is safe.
 */
function buildQuery(shape: ReportShape): BuiltQuery | ValidationError {
  const src = SOURCES[shape.source as SourceKey];
  if (!src) return { error: `Unknown source: ${shape.source}` };
  const allowed = new Set<string>(src.columns);

  for (const c of shape.columns) {
    if (!allowed.has(c)) return { error: `Unknown column for source ${shape.source}: ${c}` };
  }
  for (const g of shape.grouping ?? []) {
    if (!allowed.has(g)) return { error: `Unknown grouping column for source ${shape.source}: ${g}` };
  }
  for (const f of shape.filters ?? []) {
    if (!allowed.has(f.field)) return { error: `Unknown filter column for source ${shape.source}: ${f.field}` };
    if (!FILTER_OPS.includes(f.op)) return { error: `Unsupported filter op: ${f.op}` };
  }

  const selectCols = shape.columns.join(', ');
  const params: unknown[] = [];
  const where: string[] = [];
  for (const f of shape.filters ?? []) {
    params.push(f.value);
    where.push(`${f.field} ${f.op} $${params.length}`);
  }

  let text = `select ${selectCols} from ${src.table}`;
  if (where.length > 0) text += ` where ${where.join(' and ')}`;
  if ((shape.grouping ?? []).length > 0) text += ` group by ${shape.grouping!.join(', ')}`;
  text += ` limit 1000`;

  return { text, params, source: shape.source as SourceKey };
}

function isValidationError<T extends object>(r: T | ValidationError): r is ValidationError {
  return (r as ValidationError).error !== undefined;
}

// ---------------------------------------------------------------------------
// Semantic metric layer: a metric is a named business measure resolved through
// the SAME governed allowlist as reports. The stored "expression" never reaches
// SQL as text - it selects an allowlisted source + measure + aggregation, whose
// values are bound as parameters. Two kinds are supported:
//   aggregation: one agg over one source        -> a single numeric value
//   ratio:       numerator / denominator aggs    -> numerator.value / denom.value
// ---------------------------------------------------------------------------
const AGGS = ['sum', 'avg', 'count', 'min', 'max'] as const;
type Agg = (typeof AGGS)[number];

interface AggSpec {
  source: string;
  measure: string; // a column, or '*' for count
  agg: Agg;
  filters?: { field: string; op: FilterOp; value: string | number | boolean | null }[];
  asOfField?: string; // optional date column; when asOf is passed, adds `<= asOf`
}

const aggSpecSchema = z.object({
  source: z.string().min(1),
  measure: z.string().min(1),
  agg: z.enum(AGGS),
  filters: z.array(filterSchema).optional(),
  asOfField: z.string().min(1).optional(),
});

const expressionSchema = z.union([
  aggSpecSchema.extend({ kind: z.literal('aggregation').optional() }),
  z.object({ kind: z.literal('ratio'), numerator: aggSpecSchema, denominator: aggSpecSchema }),
]);
type MetricExpression = z.infer<typeof expressionSchema>;

interface BuiltAgg {
  text: string;
  params: unknown[];
}

/** Build a governed single-value aggregation query (identifiers from the allowlist only). */
function buildAggregation(spec: AggSpec, asOf?: string | null): BuiltAgg | ValidationError {
  const src = SOURCES[spec.source as SourceKey];
  if (!src) return { error: `Unknown source: ${spec.source}` };
  if (!AGGS.includes(spec.agg)) return { error: `Unsupported aggregation: ${spec.agg}` };
  const allowed = new Set<string>(src.columns);

  let measureSql: string;
  if (spec.agg === 'count') {
    if (!spec.measure || spec.measure === '*') measureSql = '*';
    else if (allowed.has(spec.measure)) measureSql = spec.measure;
    else return { error: `Unknown measure for source ${spec.source}: ${spec.measure}` };
  } else {
    if (!allowed.has(spec.measure)) return { error: `Unknown measure for source ${spec.source}: ${spec.measure}` };
    measureSql = spec.measure;
  }

  const params: unknown[] = [];
  const where: string[] = [];
  for (const f of spec.filters ?? []) {
    if (!allowed.has(f.field)) return { error: `Unknown filter column for source ${spec.source}: ${f.field}` };
    if (!FILTER_OPS.includes(f.op)) return { error: `Unsupported filter op: ${f.op}` };
    params.push(f.value);
    where.push(`${f.field} ${f.op} $${params.length}`);
  }
  if (asOf && spec.asOfField) {
    if (!allowed.has(spec.asOfField)) return { error: `Unknown asOf column for source ${spec.source}: ${spec.asOfField}` };
    params.push(asOf);
    where.push(`${spec.asOfField} <= $${params.length}`);
  }

  const measureExpr = spec.agg === 'count' ? `count(${measureSql})` : `coalesce(${spec.agg}(${measureSql}), 0)`;
  let text = `select ${measureExpr} as value from ${src.table}`;
  if (where.length > 0) text += ` where ${where.join(' and ')}`;
  return { text, params };
}

/** Validate that a metric expression builds cleanly (catches bad source/measure at write time). */
function validateExpression(expr: MetricExpression): ValidationError | null {
  const specs: AggSpec[] = expr.kind === 'ratio' ? [expr.numerator, expr.denominator] : [expr as AggSpec];
  for (const s of specs) {
    const built = buildAggregation(s);
    if (isValidationError(built)) return built;
  }
  return null;
}

/** Resolve a metric expression to a numeric value against live data. */
async function resolveMetric(
  db: Db,
  expr: MetricExpression,
  asOf?: string | null,
): Promise<{ value: number | null } | ValidationError> {
  const one = async (spec: AggSpec): Promise<number | ValidationError> => {
    const built = buildAggregation(spec, asOf);
    if (isValidationError(built)) return built;
    const { rows } = await db.query<{ value: string | number }>(built.text, built.params);
    return Number(rows[0]?.value ?? 0);
  };
  if (expr.kind === 'ratio') {
    const num = await one(expr.numerator);
    if (typeof num !== 'number') return num;
    const den = await one(expr.denominator);
    if (typeof den !== 'number') return den;
    return { value: den === 0 ? null : num / den };
  }
  const value = await one(expr as AggSpec);
  if (typeof value !== 'number') return value;
  return { value };
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const quote = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [headers.map(quote).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => quote(row[h])).join(','));
  }
  return lines.join('\n');
}

export async function reportingModule(app: FastifyInstance): Promise<void> {
  // Create a governed report definition.
  app.post('/api/reports/definitions', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createDefinitionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid report definition', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const built = buildQuery(b);
    if (isValidationError(built)) {
      reply.code(400);
      return built;
    }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into report_definition
           (tenant_id, key, name, description, source, columns, filters, grouping, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          ctx.tenantId,
          b.key,
          b.name,
          b.description ?? null,
          b.source,
          JSON.stringify(b.columns),
          JSON.stringify(b.filters ?? []),
          JSON.stringify(b.grouping ?? []),
          ctx.userId,
        ],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'report_definition',
        entityId: id,
        after: { key: b.key, name: b.name, source: b.source },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, key: b.key };
    });
  });

  // List published definitions.
  app.get('/api/reports/definitions', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, key, name, description, source, columns, filters, grouping, status,
                created_at as "createdAt"
           from report_definition
          where status = 'published'
          order by created_at desc`,
      );
      return { definitions: rows };
    });
  });

  // A single definition.
  app.get<{ Params: { id: string } }>(
    '/api/reports/definitions/:id',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const def = await loadDefinition(db, req.params.id);
        if (!def) {
          reply.code(404);
          return { error: 'Definition not found' };
        }
        return def;
      });
    },
  );

  // Ad-hoc run - not persisted.
  app.post('/api/reports/run', { preHandler: requirePermission('reporting:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = reportShapeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid report request', details: parsed.error.flatten() };
    }
    const built = buildQuery(parsed.data as ReportShape);
    if (isValidationError(built)) {
      reply.code(400);
      return built;
    }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(built.text, built.params);
      return { rows, rowCount: rows.length, source: built.source };
    });
  });

  // Run a saved definition; merge optional params as additional filters; persist a run.
  app.post<{ Params: { id: string }; Body: { params?: { field: string; op: FilterOp; value: string | number | boolean | null }[] } }>(
    '/api/reports/definitions/:id/run',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const def = await loadDefinition(db, req.params.id);
        if (!def) {
          reply.code(404);
          return { error: 'Definition not found' };
        }
        const extraParams = req.body?.params;
        const parsedExtra = extraParams ? z.array(filterSchema).safeParse(extraParams) : null;
        if (parsedExtra && !parsedExtra.success) {
          reply.code(400);
          return { error: 'Invalid params', details: parsedExtra.error.flatten() };
        }
        const shape: ReportShape = {
          source: def.source,
          columns: def.columns,
          filters: [...(def.filters ?? []), ...(parsedExtra?.data ?? [])],
          grouping: def.grouping,
        };
        const built = buildQuery(shape);
        if (isValidationError(built)) {
          reply.code(400);
          return built;
        }
        const { rows } = await db.query<Record<string, unknown>>(built.text, built.params);

        const runRes = await db.query<{ id: string }>(
          `insert into report_run (tenant_id, definition_id, params, row_count, result, status, created_by)
           values ($1, $2, $3, $4, $5, 'complete', $6) returning id`,
          [
            ctx.tenantId,
            def.id,
            JSON.stringify({ params: parsedExtra?.data ?? [] }),
            rows.length,
            JSON.stringify(rows.slice(0, 200)),
            ctx.userId,
          ],
        );
        const runId = runRes.rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'run',
          entityType: 'report_run',
          entityId: runId,
          after: { definitionId: def.id, rowCount: rows.length },
          actorLabel: req.auth?.displayName,
        });
        return { runId, rows, rowCount: rows.length, source: built.source };
      });
    },
  );

  // Run history.
  app.get<{ Querystring: { definitionId?: string } }>(
    '/api/reports/runs',
    { preHandler: requirePermission('reporting:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, definition_id as "definitionId", params, row_count as "rowCount",
                  status, created_at as "createdAt"
             from report_run
            where ($1::uuid is null or definition_id = $1)
            order by created_at desc`,
          [req.query.definitionId ?? null],
        );
        return { runs: rows };
      });
    },
  );

  // Export a definition's results as CSV or JSON.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/reports/definitions/:id/export',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const def = await loadDefinition(db, req.params.id);
        if (!def) {
          reply.code(404);
          return { error: 'Definition not found' };
        }
        const built = buildQuery({
          source: def.source,
          columns: def.columns,
          filters: def.filters,
          grouping: def.grouping,
        });
        if (isValidationError(built)) {
          reply.code(400);
          return built;
        }
        const { rows } = await db.query<Record<string, unknown>>(built.text, built.params);

        const format = req.query.format === 'json' ? 'json' : 'csv';
        if (format === 'json') {
          reply.header('content-type', 'application/json');
          return { rows, rowCount: rows.length, source: built.source };
        }
        // CSV - always include a header row built from the definition columns even
        // when there are no rows, so consumers get a stable shape.
        const header = `${def.columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')}`;
        const body = rows.length > 0 ? toCsv(rows) : header;
        reply.header('content-type', 'text/csv');
        return body;
      });
    },
  );

  // Export a definition's results as a real binary .xlsx workbook.
  app.get<{ Params: { id: string } }>(
    '/api/reports/definitions/:id/export.xlsx',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const def = await loadDefinition(db, req.params.id);
        if (!def) {
          reply.code(404);
          return { error: 'Definition not found' };
        }
        const built = buildQuery({ source: def.source, columns: def.columns, filters: def.filters, grouping: def.grouping });
        if (isValidationError(built)) {
          reply.code(400);
          return built;
        }
        const { rows } = await db.query<Record<string, unknown>>(built.text, built.params);
        const xlsx = buildXlsx(def.columns, rows, def.name.slice(0, 31));
        reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        reply.header('content-disposition', `attachment; filename="${def.key}.xlsx"`);
        return reply.send(xlsx);
      });
    },
  );

  // Export a definition's results as a real binary .pdf (simple tabular text PDF).
  app.get<{ Params: { id: string } }>(
    '/api/reports/definitions/:id/export.pdf',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const def = await loadDefinition(db, req.params.id);
        if (!def) {
          reply.code(404);
          return { error: 'Definition not found' };
        }
        const built = buildQuery({ source: def.source, columns: def.columns, filters: def.filters, grouping: def.grouping });
        if (isValidationError(built)) {
          reply.code(400);
          return built;
        }
        const { rows } = await db.query<Record<string, unknown>>(built.text, built.params);
        const pdf = buildPdf({
          title: def.name,
          subtitle: `Source: ${def.source} - ${rows.length} row(s) - generated ${new Date().toISOString().slice(0, 10)}`,
          headers: def.columns,
          rows,
        });
        reply.header('content-type', 'application/pdf');
        reply.header('content-disposition', `attachment; filename="${def.key}.pdf"`);
        return reply.send(pdf);
      });
    },
  );

  // ---- Semantic metric layer -----------------------------------------------
  // List metrics visible to the tenant (its own + global defaults via RLS).
  app.get('/api/reports/metrics', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, key, name, description, source, expression, unit, format,
                (tenant_id is null) as "isGlobal",
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') as "createdAt"
           from metric_definition
          order by (tenant_id is null) desc, key`,
      );
      return { metrics: rows };
    });
  });

  // Define a (tenant-scoped) metric.
  const createMetricSchema = z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    source: z.string().min(1),
    expression: expressionSchema,
    unit: z.string().optional(),
    format: z.string().optional(),
  });
  app.post('/api/reports/metrics', { preHandler: requirePermission('reporting:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createMetricSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid metric definition', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    if (!SOURCES[b.source as SourceKey]) {
      reply.code(400);
      return { error: `Unknown source: ${b.source}` };
    }
    const exprError = validateExpression(b.expression);
    if (exprError) {
      reply.code(400);
      return exprError;
    }
    return runAs(ctx, async (db) => {
      try {
        const { rows } = await db.query<{ id: string }>(
          `insert into metric_definition (tenant_id, key, name, description, source, expression, unit, format, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            ctx.tenantId,
            b.key,
            b.name,
            b.description ?? null,
            b.source,
            JSON.stringify(b.expression),
            b.unit ?? null,
            b.format ?? null,
            ctx.userId,
          ],
        );
        const id = rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'metric_definition',
          entityId: id,
          after: { key: b.key, name: b.name, source: b.source },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { id, key: b.key };
      } catch {
        reply.code(409);
        return { error: 'A metric with that key already exists' };
      }
    });
  });

  // Resolve a metric to its current value (tenant metric overrides a global default).
  app.get<{ Params: { key: string }; Querystring: { asOf?: string } }>(
    '/api/reports/metrics/:key/value',
    { preHandler: requirePermission('reporting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const asOf = req.query.asOf ?? null;
      if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        reply.code(400);
        return { error: 'asOf must be YYYY-MM-DD' };
      }
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ key: string; name: string; expression: MetricExpression; unit: string | null; format: string | null }>(
          `select key, name, expression, unit, format
             from metric_definition
            where key = $1
            order by tenant_id nulls last
            limit 1`,
          [req.params.key],
        );
        const metric = rows[0];
        if (!metric) {
          reply.code(404);
          return { error: 'Metric not found' };
        }
        const resolved = await resolveMetric(db, metric.expression, asOf);
        if (isValidationError(resolved)) {
          reply.code(400);
          return resolved;
        }
        return {
          key: metric.key,
          name: metric.name,
          value: resolved.value,
          unit: metric.unit,
          format: metric.format,
          asOf: asOf,
        };
      });
    },
  );
}

interface DefinitionRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  source: string;
  columns: string[];
  filters: { field: string; op: FilterOp; value: string | number | boolean | null }[];
  grouping: string[];
  status: string;
}

async function loadDefinition(db: Db, id: string): Promise<DefinitionRow | null> {
  const { rows } = await db.query<DefinitionRow>(
    `select id, key, name, description, source, columns, filters, grouping, status
       from report_definition where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
