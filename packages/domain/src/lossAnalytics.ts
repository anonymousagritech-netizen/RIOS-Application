/**
 * Loss & claims analytics - pure, deterministic, framework-free.
 *
 * Turns a claims book into the metrics an underwriter and actuary watch: loss
 * ratio, frequency & severity, and a simple chain-ladder loss development /
 * ultimate projection from a paid (or incurred) triangle. Money is integer minor
 * units. No I/O; the server feeds it aggregates from the claim table.
 */

/** Incurred loss ÷ premium, as a percentage. */
export function lossRatioPct(incurredMinor: number, premiumMinor: number): number {
  if (premiumMinor <= 0) return 0;
  return round1((incurredMinor / premiumMinor) * 100);
}

export interface FrequencySeverity {
  frequency: number;          // claims per unit of exposure (e.g. per contract)
  severityMinor: number;      // average incurred per claim
  claimCount: number;
}

/** Claim frequency (per exposure) and average severity (per claim). */
export function frequencySeverity(claimCount: number, exposureCount: number, incurredMinor: number): FrequencySeverity {
  return {
    frequency: exposureCount > 0 ? round2(claimCount / exposureCount) : 0,
    severityMinor: claimCount > 0 ? Math.round(incurredMinor / claimCount) : 0,
    claimCount,
  };
}

/**
 * Volume-weighted age-to-age development factors from a cumulative triangle.
 * `triangle[i]` is origin period i's cumulative amounts by development age
 * (ragged: later origins have fewer observed ages). Returns one factor per age
 * step (age j → j+1). A factor of 1 means no further development.
 */
export function developmentFactors(triangle: number[][]): number[] {
  const maxAges = Math.max(0, ...triangle.map((r) => r.length));
  const factors: number[] = [];
  for (let j = 0; j < maxAges - 1; j++) {
    let num = 0, den = 0;
    for (const row of triangle) {
      // Only origins with an observed value at both age j and j+1 contribute.
      if (row.length > j + 1 && row[j]! > 0) { num += row[j + 1]!; den += row[j]!; }
    }
    factors.push(den > 0 ? round3(num / den) : 1);
  }
  return factors;
}

/**
 * Project each origin's ultimate by applying the tail of development factors to
 * its latest observed cumulative value. Returns per-origin ultimates and the
 * total, plus IBNR (ultimate − latest observed) for the book.
 */
export function projectUltimate(triangle: number[][], factors: number[]): {
  ultimates: number[]; totalUltimateMinor: number; latestMinor: number; ibnrMinor: number;
} {
  const ultimates: number[] = [];
  let latestTotal = 0;
  for (const row of triangle) {
    if (!row.length) { ultimates.push(0); continue; }
    const lastAge = row.length - 1;
    let value = row[lastAge]!;
    latestTotal += value;
    // Apply every factor from this origin's latest age onward.
    for (let j = lastAge; j < factors.length; j++) value *= factors[j]!;
    ultimates.push(Math.round(value));
  }
  const totalUltimate = ultimates.reduce((a, b) => a + b, 0);
  return { ultimates, totalUltimateMinor: totalUltimate, latestMinor: latestTotal, ibnrMinor: totalUltimate - latestTotal };
}

/**
 * Cumulative development factor to ultimate for each age: cdf[a] = product of
 * age-to-age factors from age a onward. cdf has length factors.length+1 and the
 * ultimate age has cdf = 1. The percent reported at age a is 1 / cdf[a].
 */
export function cumulativeDevelopmentFactors(factors: number[]): number[] {
  const cdf = new Array<number>(factors.length + 1).fill(1);
  for (let j = factors.length - 1; j >= 0; j--) cdf[j] = round3(cdf[j + 1]! * factors[j]!);
  return cdf;
}

/** Percent of ultimate reported at each age (1 / cdf), as a fraction 0..1. */
export function percentDeveloped(factors: number[]): number[] {
  return cumulativeDevelopmentFactors(factors).map((f) => (f > 0 ? round3(1 / f) : 1));
}

export interface ReserveResult {
  ultimates: number[];
  ibnrMinor: number[];
  totalUltimateMinor: number;
  totalIbnrMinor: number;
}

/**
 * Bornhuetter-Ferguson: blend actual reported with an a-priori expected ultimate.
 *   ultimate_i = latest_i + aPriori_i x (1 - 1/cdf_at_latest_age)
 * Only the *unreported* portion of the a-priori is added, so early, volatile
 * origins lean on the plan while mature origins lean on experience.
 */
export function bornhuetterFerguson(triangle: number[][], factors: number[], aPrioriUltimates: number[]): ReserveResult {
  const cdf = cumulativeDevelopmentFactors(factors);
  const ultimates: number[] = [];
  const ibnr: number[] = [];
  triangle.forEach((row, i) => {
    if (!row.length) { ultimates.push(0); ibnr.push(0); return; }
    const a = row.length - 1;
    const latest = row[a]!;
    const unreported = 1 - 1 / (cdf[a] ?? 1);
    const emergence = (aPrioriUltimates[i] ?? 0) * unreported;
    ultimates.push(Math.round(latest + emergence));
    ibnr.push(Math.round(emergence));
  });
  const totalUltimate = ultimates.reduce((a, b) => a + b, 0);
  const totalIbnr = ibnr.reduce((a, b) => a + b, 0);
  return { ultimates, ibnrMinor: ibnr, totalUltimateMinor: totalUltimate, totalIbnrMinor: totalIbnr };
}

/**
 * Benktander (Gunnar-Benktander) credibility reserve: one BF iteration using the
 * first-pass BF ultimate as the new a-priori. It sits between chain-ladder and
 * BF and has lower mean-squared error than either in many cases.
 */
export function benktander(triangle: number[][], factors: number[], aPrioriUltimates: number[]): ReserveResult {
  const first = bornhuetterFerguson(triangle, factors, aPrioriUltimates);
  return bornhuetterFerguson(triangle, factors, first.ultimates);
}

export interface ReserveComparison {
  chainLadder: number;
  bornhuetterFerguson: number;
  benktander: number;
  expectedLoss: number;
}

/**
 * Compare total ultimate under the four common methods for a book: chain-ladder,
 * BF, Benktander and the pure expected-loss (a-priori) method - so a reserving
 * actuary can see the spread and pick a booked estimate.
 */
export function reserveComparison(triangle: number[][], factors: number[], aPrioriUltimates: number[]): ReserveComparison {
  const cl = projectUltimate(triangle, factors).totalUltimateMinor;
  const bf = bornhuetterFerguson(triangle, factors, aPrioriUltimates).totalUltimateMinor;
  const gb = benktander(triangle, factors, aPrioriUltimates).totalUltimateMinor;
  const el = aPrioriUltimates.reduce((a, b) => a + Math.round(b), 0);
  return { chainLadder: cl, bornhuetterFerguson: bf, benktander: gb, expectedLoss: el };
}

export interface TechnicalAccount {
  premiumMinor: number;
  commissionMinor: number;
  claimsMinor: number;
  expensesMinor: number;
  lossRatioPct: number;
  commissionRatioPct: number;
  expenseRatioPct: number;
  combinedRatioPct: number;
  technicalResultMinor: number;   // premium − commission − claims − expenses
}

/** A book / cedent / line technical account: the ratios and the bottom line. */
export function technicalAccount(input: { premiumMinor: number; commissionMinor: number; claimsMinor: number; expensesMinor?: number }): TechnicalAccount {
  const premium = Math.max(0, input.premiumMinor);
  const expenses = Math.max(0, input.expensesMinor ?? 0);
  const lr = premium > 0 ? (input.claimsMinor / premium) * 100 : 0;
  const cr = premium > 0 ? (input.commissionMinor / premium) * 100 : 0;
  const er = premium > 0 ? (expenses / premium) * 100 : 0;
  return {
    premiumMinor: premium,
    commissionMinor: input.commissionMinor,
    claimsMinor: input.claimsMinor,
    expensesMinor: expenses,
    lossRatioPct: round1(lr),
    commissionRatioPct: round1(cr),
    expenseRatioPct: round1(er),
    combinedRatioPct: round1(lr + cr + er),
    technicalResultMinor: premium - input.commissionMinor - input.claimsMinor - expenses,
  };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
