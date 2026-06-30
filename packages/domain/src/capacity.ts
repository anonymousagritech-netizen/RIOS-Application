/**
 * Cost & capacity (brief §13 — cost & capacity management). Pure utilisation
 * maths over provisioned vs used capacity, and the band it falls in. No I/O —
 * the server loads cost records and asks this module for the derived figures.
 */

export type UtilisationBand = 'idle' | 'normal' | 'high' | 'over';

/** Used ÷ provisioned as a fraction in [0, ∞). Returns 0 when nothing is provisioned. */
export function utilisation(used: number | null | undefined, provisioned: number | null | undefined): number {
  if (!provisioned || provisioned <= 0) return 0;
  return Math.max(0, (used ?? 0) / provisioned);
}

/** Band a utilisation fraction: <0.4 idle, <0.85 normal, ≤1 high, >1 over-committed. */
export function utilisationBand(fraction: number): UtilisationBand {
  if (fraction > 1) return 'over';
  if (fraction >= 0.85) return 'high';
  if (fraction < 0.4) return 'idle';
  return 'normal';
}

export interface CostLine {
  category: string;
  amountMinor: number;
  capacityProvisioned?: number | null;
  capacityUsed?: number | null;
}

/** Total spend across lines (same currency assumed; convert via FX upstream). */
export function totalSpendMinor(lines: CostLine[]): number {
  return (lines ?? []).reduce((a, l) => a + l.amountMinor, 0);
}
