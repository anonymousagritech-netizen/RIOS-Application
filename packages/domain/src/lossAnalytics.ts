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
