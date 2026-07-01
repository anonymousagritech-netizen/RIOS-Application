/**
 * Capacity management - pure, deterministic, framework-free.
 *
 * A reinsurer allocates finite capacity (by peril, zone, line, counterparty) and
 * must know at all times what is available, consumed and remaining, where it is
 * running hot, and roughly where consumption is heading. This module computes
 * utilisation, rolls capacity lines into a book view, raises threshold alerts and
 * gives a simple straight-line forecast. Money is integer minor units. No I/O.
 */

export type CapacityStatus = 'OK' | 'WATCH' | 'WARN' | 'BREACH';

export interface CapacityLineInput {
  dimension: string;          // OVERALL / GEOGRAPHY / LINE_OF_BUSINESS / PERIL / BROKER / CEDENT
  dimKey: string;
  label?: string | null;
  availableMinor: number;
  consumedMinor: number;
  warnPct?: number;           // utilisation warn threshold (default 80)
}

export interface CapacityLineResult extends CapacityLineInput {
  remainingMinor: number;
  utilisationPct: number;
  status: CapacityStatus;
}

/** Utilisation, remaining and RAG status for one capacity line. */
export function capacityUtilisation(line: CapacityLineInput): CapacityLineResult {
  const avail = Math.max(0, line.availableMinor);
  const consumed = Math.max(0, line.consumedMinor);
  const remaining = avail - consumed;
  const util = avail > 0 ? (consumed / avail) * 100 : (consumed > 0 ? 100 : 0);
  const warn = line.warnPct ?? 80;
  const status: CapacityStatus =
    util >= 100 ? 'BREACH' : util >= warn ? 'WARN' : util >= warn - 15 ? 'WATCH' : 'OK';
  return { ...line, remainingMinor: remaining, utilisationPct: round1(util), status };
}

export interface CapacityBook {
  availableMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  utilisationPct: number;
  lines: CapacityLineResult[];
  breaches: number;
  warnings: number;
}

/** Roll a set of capacity lines into a book-level view (hottest first). */
export function capacityBook(lines: CapacityLineInput[]): CapacityBook {
  const results = lines.map(capacityUtilisation).sort((a, b) => b.utilisationPct - a.utilisationPct);
  const available = results.reduce((a, l) => a + Math.max(0, l.availableMinor), 0);
  const consumed = results.reduce((a, l) => a + Math.max(0, l.consumedMinor), 0);
  return {
    availableMinor: available,
    consumedMinor: consumed,
    remainingMinor: available - consumed,
    utilisationPct: available > 0 ? round1((consumed / available) * 100) : 0,
    lines: results,
    breaches: results.filter((l) => l.status === 'BREACH').length,
    warnings: results.filter((l) => l.status === 'WARN').length,
  };
}

export interface CapacityAlert {
  dimension: string; dimKey: string; label?: string | null;
  severity: 'high' | 'medium'; utilisationPct: number; message: string;
}

/** Alerts for lines at/over their warn threshold, breaches first. */
export function capacityAlerts(lines: CapacityLineInput[]): CapacityAlert[] {
  const alerts: CapacityAlert[] = [];
  for (const l of lines.map(capacityUtilisation)) {
    if (l.status === 'BREACH') alerts.push({ dimension: l.dimension, dimKey: l.dimKey, label: l.label, severity: 'high', utilisationPct: l.utilisationPct, message: `${l.label ?? l.dimKey} capacity exhausted (${l.utilisationPct}%)` });
    else if (l.status === 'WARN') alerts.push({ dimension: l.dimension, dimKey: l.dimKey, label: l.label, severity: 'medium', utilisationPct: l.utilisationPct, message: `${l.label ?? l.dimKey} nearing full (${l.utilisationPct}%)` });
  }
  return alerts.sort((a, b) => b.utilisationPct - a.utilisationPct);
}

/**
 * Straight-line forecast of consumption. Given the consumed values across
 * periods so far and the fraction of the year elapsed, project year-end
 * consumption and whether it will breach available capacity.
 */
export function capacityForecast(consumedMinor: number, availableMinor: number, fractionElapsed: number): {
  projectedConsumedMinor: number; projectedUtilisationPct: number; willBreach: boolean;
} {
  const frac = clamp(fractionElapsed, 0.01, 1);
  const projected = Math.round(consumedMinor / frac);
  const util = availableMinor > 0 ? (projected / availableMinor) * 100 : 0;
  return { projectedConsumedMinor: projected, projectedUtilisationPct: round1(util), willBreach: util >= 100 };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function round1(v: number): number { return Math.round(v * 10) / 10; }
