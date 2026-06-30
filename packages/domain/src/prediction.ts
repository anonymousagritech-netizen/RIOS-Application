/**
 * AI prediction & insights (brief §13). Pure, explainable predictive helpers —
 * loss ratio, a heuristic renewal-likelihood score, and its band. These are
 * transparent deterministic models (no black box); an optional LLM layer can
 * narrate them, but the numbers come from here and are unit-tested.
 */

/** clamp to [0, 1]. */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Loss ratio = incurred / premium (fraction). 0 when no premium. */
export function lossRatio(incurredMinor: number, premiumMinor: number): number {
  if (premiumMinor <= 0) return 0;
  return incurredMinor / premiumMinor;
}

export interface RenewalFeatures {
  lossRatio: number;
  yearsOnBook: number;
  openClaims: number;
}

/**
 * Heuristic renewal likelihood in [0, 1]:
 *   0.6 + 0.05·min(years,5) − 0.4·lossRatio − 0.05·openClaims
 * Transparent and monotonic: tenure helps, losses and open claims hurt.
 */
export function renewalLikelihood(f: RenewalFeatures): number {
  const raw = 0.6 + 0.05 * Math.min(f.yearsOnBook ?? 0, 5) - 0.4 * (f.lossRatio ?? 0) - 0.05 * (f.openClaims ?? 0);
  return Math.round(clamp01(raw) * 100) / 100;
}

export type InsightBand = 'unlikely' | 'at-risk' | 'likely';

/** Band a likelihood score: <0.3 unlikely, <0.6 at-risk, else likely. */
export function insightBand(score: number): InsightBand {
  if (score < 0.3) return 'unlikely';
  if (score < 0.6) return 'at-risk';
  return 'likely';
}
