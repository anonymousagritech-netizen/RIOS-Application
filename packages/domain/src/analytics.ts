/**
 * Analytics: a pure pivot/cube aggregation engine (brief §13 - analytics &
 * data warehouse). The server pulls fact rows (financial events, claims,
 * exposure) and this engine groups and aggregates them by chosen dimensions
 * and measures. No I/O - deterministic and unit-testable, so a pivot total can
 * be reconciled against the underlying facts.
 */

import { resolvePath, type Context } from './rules.js';

export type Aggregation = 'sum' | 'count' | 'avg' | 'min' | 'max';

export interface Measure {
  /** Dot-path to the numeric field to aggregate (ignored for 'count'). */
  field?: string;
  agg: Aggregation;
  /** Output key for the measure; defaults to `${agg}_${field}` or 'count'. */
  as?: string;
}

export interface PivotCell {
  /** The dimension values that define this group. */
  key: Record<string, unknown>;
  /** The computed measures. */
  values: Record<string, number>;
  /** Number of fact rows in the group. */
  count: number;
}

function measureKey(m: Measure): string {
  return m.as ?? (m.agg === 'count' ? 'count' : `${m.agg}_${m.field ?? 'value'}`);
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function aggregate(values: number[], agg: Aggregation, count: number): number {
  switch (agg) {
    case 'count': return count;
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case 'min': return values.length ? Math.min(...values) : 0;
    case 'max': return values.length ? Math.max(...values) : 0;
  }
}

/**
 * Group `rows` by the `dimensions` (dot-paths) and compute each `measure`.
 * Returns one cell per distinct dimension tuple, sorted by the first measure
 * descending (then by key) so the heaviest contributors surface first.
 */
export function pivot<T extends Context>(rows: T[], dimensions: string[], measures: Measure[]): PivotCell[] {
  const groups = new Map<string, { key: Record<string, unknown>; rows: T[] }>();

  for (const row of rows ?? []) {
    const key: Record<string, unknown> = {};
    for (const d of dimensions) key[d] = resolvePath(row, d) ?? null;
    const gk = JSON.stringify(dimensions.map((d) => key[d]));
    let g = groups.get(gk);
    if (!g) { g = { key, rows: [] }; groups.set(gk, g); }
    g.rows.push(row);
  }

  const cells: PivotCell[] = [];
  for (const g of groups.values()) {
    const values: Record<string, number> = {};
    for (const m of measures) {
      const nums = m.agg === 'count'
        ? []
        : g.rows.map((r) => num(resolvePath(r, m.field ?? ''))).filter((v): v is number => v !== null);
      values[measureKey(m)] = aggregate(nums, m.agg, g.rows.length);
    }
    cells.push({ key: g.key, values, count: g.rows.length });
  }

  const firstMeasure = measures[0] ? measureKey(measures[0]) : null;
  cells.sort((a, b) => {
    if (firstMeasure) {
      const d = (b.values[firstMeasure] ?? 0) - (a.values[firstMeasure] ?? 0);
      if (d !== 0) return d;
    }
    return JSON.stringify(a.key).localeCompare(JSON.stringify(b.key));
  });
  return cells;
}

/** A grand-total row across all facts for the same measures (no grouping). */
export function totals<T extends Context>(rows: T[], measures: Measure[]): Record<string, number> {
  const cell = pivot(rows, [], measures)[0];
  return cell?.values ?? Object.fromEntries(measures.map((m) => [measureKey(m), 0]));
}
