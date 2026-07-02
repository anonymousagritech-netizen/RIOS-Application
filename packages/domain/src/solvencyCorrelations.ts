/**
 * Solvency II standard-formula correlation matrices (Pillar 1 SCR aggregation).
 *
 * These are the correlation coefficients used to aggregate the top-level SCR risk
 * modules into the Basic SCR (BSCR) under the standard formula, as published in
 * Commission Delegated Regulation (EU) 2015/35, Annex IV (BSCR correlation
 * matrix). They are tenant-independent regulatory *constants*, so they belong in
 * the pure domain layer rather than per-tenant reference data.
 *
 * IMPORTANT — honesty note (brief §4.4): these coefficients are provided so the
 * SCR aggregation is computable and transparent, and reflect the published
 * standard-formula values to the best of our knowledge. This module is NOT a
 * certified regulatory artefact: verify the matrix against the current Delegated
 * Regulation before relying on the output for an official QRT / regulatory
 * filing. The aggregation math itself is the tested `aggregateScr` in solvency2.
 */

import { aggregateScr } from './solvency2.js';

/** The five top-level BSCR risk modules aggregated by the standard-formula matrix. */
export const SII_BSCR_MODULES = ['market', 'default', 'life', 'health', 'nonLife'] as const;

export type SiiBscrModule = (typeof SII_BSCR_MODULES)[number];

/**
 * The published Solvency II BSCR correlation matrix (Delegated Reg. (EU) 2015/35
 * Annex IV), ordered per `SII_BSCR_MODULES`. Symmetric with a unit diagonal.
 *
 *              market default life  health nonLife
 *   market      1     0.25   0.25   0.25   0.25
 *   default     0.25  1      0.25   0.25   0.5
 *   life        0.25  0.25   1      0.25   0
 *   health      0.25  0.25   0.25   1      0
 *   nonLife     0.25  0.5    0      0      1
 */
export const SII_BSCR_CORRELATION: readonly (readonly number[])[] = [
  [1, 0.25, 0.25, 0.25, 0.25],
  [0.25, 1, 0.25, 0.25, 0.5],
  [0.25, 0.25, 1, 0.25, 0],
  [0.25, 0.25, 0.25, 1, 0],
  [0.25, 0.5, 0, 0, 1],
] as const;

/** A labelled description of the shipped matrix for API disclosure. */
export const SII_BSCR_CORRELATION_SOURCE =
  'Solvency II standard-formula BSCR correlation matrix (Commission Delegated ' +
  'Regulation (EU) 2015/35, Annex IV). Provided for transparent computation, not ' +
  'certified for regulatory filing — verify against the current regulation.';

export interface StandardFormulaBscrInput {
  /** Standalone capital charge for each named risk module (minor units or a consistent unit). */
  charges: Partial<Record<SiiBscrModule, number>>;
  /**
   * Intangible-asset risk capital. Under the standard formula it aggregates with
   * the diversified BSCR at zero correlation (i.e. adds in quadrature). Optional.
   */
  intangibleAssetRisk?: number;
}

export interface StandardFormulaBscrResult {
  /** Charge per module in the fixed `SII_BSCR_MODULES` order (missing ⇒ 0). */
  moduleCharges: number[];
  /** Diversified capital across the five modules using the standard matrix. */
  diversifiedBscr: number;
  intangibleAssetRisk: number;
  /** BSCR = √(diversifiedBscr² + intangible²). */
  bscr: number;
}

/**
 * Aggregate the standard-formula BSCR from named module charges using the
 * published correlation matrix, reusing the tested `aggregateScr`
 * (√(Σ_i Σ_j corr_ij · SCR_i · SCR_j)). Intangible-asset risk is added at zero
 * correlation (in quadrature), per the standard formula.
 */
export function aggregateStandardFormulaBscr(input: StandardFormulaBscrInput): StandardFormulaBscrResult {
  const moduleCharges = SII_BSCR_MODULES.map((m) => input.charges[m] ?? 0);
  const matrix = SII_BSCR_CORRELATION.map((row) => [...row]);
  const diversifiedBscr = aggregateScr(moduleCharges, matrix);
  const intangibleAssetRisk = input.intangibleAssetRisk ?? 0;
  const bscr = Math.sqrt(diversifiedBscr * diversifiedBscr + intangibleAssetRisk * intangibleAssetRisk);
  return { moduleCharges, diversifiedBscr, intangibleAssetRisk, bscr };
}
