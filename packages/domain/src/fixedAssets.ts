/**
 * Fixed-asset depreciation sub-ledger (brief §9.8).
 *
 * Build a depreciation schedule for an asset - straight-line or reducing-balance -
 * over its useful life, tracking net book value each year and never depreciating
 * below the residual value. Disposal crystallises a gain or loss vs the carrying
 * amount. Integer-exact minor units; the schedule sums back to (cost - residual).
 */

export type DepreciationMethod = 'STRAIGHT_LINE' | 'REDUCING_BALANCE';

export interface AssetInput {
  costMinor: number;
  residualMinor?: number;
  usefulLifeYears: number;
  method?: DepreciationMethod;
  /** Annual rate for REDUCING_BALANCE as a fraction (e.g. 0.25 = 25%). */
  decliningRate?: number;
}

export interface DepreciationPeriod {
  year: number;
  openingNbvMinor: number;
  depreciationMinor: number;
  closingNbvMinor: number;
  accumulatedMinor: number;
}

/**
 * Produce the year-by-year depreciation schedule. Straight-line spreads
 * (cost - residual) evenly with the final year absorbing rounding so the total
 * ties exactly; reducing-balance applies the rate to the opening NBV and floors
 * the final charge so closing NBV equals the residual.
 */
export function depreciationSchedule(input: AssetInput): DepreciationPeriod[] {
  const life = Math.max(1, Math.floor(input.usefulLifeYears));
  const residual = Math.max(0, input.residualMinor ?? 0);
  const method = input.method ?? 'STRAIGHT_LINE';
  const depreciable = Math.max(0, input.costMinor - residual);
  const rows: DepreciationPeriod[] = [];
  let nbv = input.costMinor;
  let accumulated = 0;

  if (method === 'STRAIGHT_LINE') {
    const base = Math.floor(depreciable / life);
    for (let y = 1; y <= life; y++) {
      // Final year takes the remainder so the schedule ties to `depreciable`.
      const charge = y < life ? base : depreciable - base * (life - 1);
      const opening = nbv;
      nbv -= charge;
      accumulated += charge;
      rows.push({ year: y, openingNbvMinor: opening, depreciationMinor: charge, closingNbvMinor: nbv, accumulatedMinor: accumulated });
    }
    return rows;
  }

  // REDUCING_BALANCE
  const rate = input.decliningRate ?? (life > 0 ? 1 - Math.pow(residual > 0 ? residual / input.costMinor : 0.1, 1 / life) : 0);
  for (let y = 1; y <= life; y++) {
    const opening = nbv;
    let charge = Math.round(opening * rate);
    // Never depreciate below residual; final year clears down to residual.
    if (opening - charge < residual || y === life) charge = opening - residual;
    charge = Math.max(0, charge);
    nbv -= charge;
    accumulated += charge;
    rows.push({ year: y, openingNbvMinor: opening, depreciationMinor: charge, closingNbvMinor: nbv, accumulatedMinor: accumulated });
  }
  return rows;
}

/** Net book value after `year` full years (0 = cost). */
export function netBookValue(input: AssetInput, year: number): number {
  if (year <= 0) return input.costMinor;
  const sched = depreciationSchedule(input);
  const idx = Math.min(year, sched.length) - 1;
  return sched[idx]!.closingNbvMinor;
}

export interface DisposalResult {
  nbvMinor: number;
  proceedsMinor: number;
  /** proceeds - carrying amount: positive is a gain, negative a loss on disposal. */
  gainLossMinor: number;
}

/** Gain or loss on disposing an asset at its carrying amount after `year` years. */
export function disposal(input: AssetInput, year: number, proceedsMinor: number): DisposalResult {
  const nbvMinor = netBookValue(input, year);
  return { nbvMinor, proceedsMinor, gainLossMinor: proceedsMinor - nbvMinor };
}
