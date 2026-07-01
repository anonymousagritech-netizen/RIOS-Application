/**
 * Insight classification - pure, deterministic, framework-free.
 *
 * The AI-insights surfaces turn raw metrics into ranked, grounded observations.
 * This module holds the deterministic rules: mapping a value against thresholds
 * to a severity, and ranking insights so the most material surface first. No
 * LLM, no I/O - the same metrics always yield the same insights.
 */

export type Severity = 'POSITIVE' | 'INFO' | 'WATCH' | 'RISK';

const RANK: Record<Severity, number> = { RISK: 3, WATCH: 2, INFO: 1, POSITIVE: 0 };

/**
 * Classify a value where LOWER is better (loss ratio, utilisation, PML ratio).
 * <= good ⇒ POSITIVE, <= warn ⇒ INFO/WATCH boundary, > warn ⇒ RISK.
 */
export function severityLowerBetter(value: number, good: number, warn: number): Severity {
  if (value <= good) return 'POSITIVE';
  if (value <= warn) return 'WATCH';
  return 'RISK';
}

/** Classify a value where HIGHER is better (compliance %, hit ratio). */
export function severityHigherBetter(value: number, good: number, warn: number): Severity {
  if (value >= good) return 'POSITIVE';
  if (value >= warn) return 'WATCH';
  return 'RISK';
}

/** Severity from a simple count of problems (breaches, overdue, breaks). */
export function severityFromCount(count: number, warnAt = 1, riskAt = 5): Severity {
  if (count >= riskAt) return 'RISK';
  if (count >= warnAt) return 'WATCH';
  return 'POSITIVE';
}

export interface Insight {
  domain: string;
  severity: Severity;
  title: string;
  detail: string;
  recommendation?: string;
  metricLabel?: string;
  metricValue?: string;
}

/** Rank insights most-material first; stable within a severity. */
export function rankInsights(insights: Insight[]): Insight[] {
  return insights
    .map((ins, i) => ({ ins, i }))
    .sort((a, b) => RANK[b.ins.severity] - RANK[a.ins.severity] || a.i - b.i)
    .map((x) => x.ins);
}

/** Count insights by severity - a headline for a domain. */
export function insightSummary(insights: Insight[]): Record<Severity, number> {
  const out: Record<Severity, number> = { POSITIVE: 0, INFO: 0, WATCH: 0, RISK: 0 };
  for (const i of insights) out[i.severity] += 1;
  return out;
}
