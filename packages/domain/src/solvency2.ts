/**
 * Solvency II - SCR standard-formula skeleton (brief §18.2, Pillar 1).
 *
 * Implements the non-life underwriting-risk sub-module (premium & reserve risk)
 * and the variance-covariance aggregation used to combine risk modules into the
 * Basic SCR, plus MCR corridor logic. This is a transparent, testable skeleton -
 * the full standard formula (all sub-modules, the official correlation matrices,
 * catastrophe scenarios, and the loss-absorbing capacity adjustments) is
 * designed-for, not delivered (see docs/open-questions.md).
 *
 * Capital figures are kept as plain numbers in a single reporting currency at
 * this layer (the inputs are already aggregated, discounted volumes).
 */

// ---------------------------------------------------------------------------
// Non-life premium & reserve risk (volume × factor)
// ---------------------------------------------------------------------------

export interface NonLifeRiskInput {
  /** Net premium volume (forward-looking, per the standard formula). */
  premiumVolume: number;
  /** Net best-estimate reserve volume. */
  reserveVolume: number;
  /** Combined standard deviation for premium & reserve risk (sigma). */
  sigma: number;
}

/**
 * Capital requirement for non-life premium & reserve risk:
 *   V = premiumVolume + reserveVolume
 *   SCR = 3 × sigma × V   (the standard-formula "ρ(σ)·V" with the 3·σ approximation
 *                          to the 99.5% VaR of a lognormal).
 */
export function nonLifePremiumReserveRisk(input: NonLifeRiskInput): { volume: number; scr: number } {
  if (input.sigma < 0) throw new RangeError('sigma must be non-negative');
  const volume = input.premiumVolume + input.reserveVolume;
  return { volume, scr: 3 * input.sigma * volume };
}

// ---------------------------------------------------------------------------
// Variance-covariance aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate module SCRs with a correlation matrix:
 *   SCR = sqrt( Σ_i Σ_j Corr(i,j) · SCR_i · SCR_j ).
 * `corr` must be square and symmetric with the same dimension as `scrs`.
 */
export function aggregateScr(scrs: number[], corr: number[][]): number {
  const n = scrs.length;
  if (corr.length !== n || corr.some((row) => row.length !== n)) {
    throw new RangeError('Correlation matrix must be square and match the number of modules');
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      total += (corr[i]![j] ?? 0) * scrs[i]! * scrs[j]!;
    }
  }
  return Math.sqrt(Math.max(0, total));
}

// ---------------------------------------------------------------------------
// Basic SCR / SCR / MCR
// ---------------------------------------------------------------------------

export interface ScrInput {
  /** SCRs for each risk module (e.g. [market, underwriting, counterparty]). */
  moduleScrs: number[];
  /** Correlation matrix between the modules. */
  correlation: number[][];
  /** Operational-risk capital (added after aggregation). */
  operationalRisk: number;
  /** Loss-absorbing capacity adjustment (deferred tax / technical provisions), negative reduces SCR. */
  adjustment?: number;
}

export interface ScrResult {
  basicScr: number;
  operationalRisk: number;
  adjustment: number;
  scr: number;
}

export function solvencyCapitalRequirement(input: ScrInput): ScrResult {
  const basicScr = aggregateScr(input.moduleScrs, input.correlation);
  const adjustment = input.adjustment ?? 0;
  const scr = Math.max(0, basicScr + input.operationalRisk + adjustment);
  return { basicScr, operationalRisk: input.operationalRisk, adjustment, scr };
}

export interface McrInput {
  scr: number;
  /** Linear MCR from the formula (volume-based). */
  linearMcr: number;
  /** Absolute floor (AMCR) for the (re)insurer. */
  absoluteFloor: number;
}

/**
 * MCR is the linear MCR bounded to a corridor of [25%, 45%] of SCR, then floored
 * by the absolute minimum capital requirement (Solvency II Art. 248–253).
 */
export function minimumCapitalRequirement(input: McrInput): number {
  const lower = 0.25 * input.scr;
  const upper = 0.45 * input.scr;
  const corridor = Math.min(upper, Math.max(lower, input.linearMcr));
  return Math.max(corridor, input.absoluteFloor);
}

/** Solvency ratio = eligible own funds / SCR (a key Pillar 3 disclosure). */
export function solvencyRatio(ownFunds: number, scr: number): number {
  if (scr <= 0) throw new RangeError('SCR must be positive to compute a solvency ratio');
  return ownFunds / scr;
}

// ---------------------------------------------------------------------------
// Risk margin (cost-of-capital method) - technical provisions (§18.2)
// ---------------------------------------------------------------------------

/**
 * Risk margin under the cost-of-capital method (Art. 77):
 *   RM = CoC · Σ_t SCR(t) / (1 + r_{t+1})^{t+1}
 * `projectedScr[t]` is the SCR at the end of future year t (t = 0 is the current
 * year). CoC defaults to the prescribed 6%; `rate` is a flat risk-free rate or a
 * per-year spot vector (last spot held for longer horizons).
 */
export function riskMargin(projectedScr: number[], costOfCapital = 0.06, rate: number | number[] = 0): number {
  if (projectedScr.some((s) => s < 0)) throw new RangeError('Projected SCRs must be non-negative');
  let pv = 0;
  projectedScr.forEach((scr, t) => {
    const r = Array.isArray(rate) ? rate[Math.min(t, rate.length - 1)]! : rate;
    if (!(r > -1)) throw new RangeError(`Discount rate must be > -100%, got ${r}`);
    pv += scr / Math.pow(1 + r, t + 1);
  });
  return costOfCapital * pv;
}

// ---------------------------------------------------------------------------
// Own-funds tiering & eligibility (Art. 82) - Pillar 1
// ---------------------------------------------------------------------------

export interface OwnFundsTiers {
  tier1: number;
  tier2: number;
  tier3: number;
}

export interface EligibleOwnFunds {
  eligibleForScr: number;
  eligibleForMcr: number;
  scrRatio: number;
  mcrRatio: number;
  /** Human-readable eligibility/coverage breaches (empty when compliant). */
  breaches: string[];
}

/**
 * Apply the Solvency II eligibility limits to classify own funds against the
 * SCR and MCR (Art. 82 / Delegated Reg. Art. 82):
 *   SCR - Tier 3 <= 15% of SCR; Tier 2 + Tier 3 <= 50% of SCR; Tier 1 must be >= 50% of SCR.
 *   MCR - Tier 3 ineligible; Tier 2 <= 20% of MCR; Tier 1 must be >= 80% of MCR.
 */
export function eligibleOwnFunds(tiers: OwnFundsTiers, scr: number, mcr: number): EligibleOwnFunds {
  if (scr <= 0 || mcr <= 0) throw new RangeError('SCR and MCR must be positive');
  const { tier1, tier2, tier3 } = tiers;
  const breaches: string[] = [];

  // Eligible for SCR
  const t3Scr = Math.min(tier3, 0.15 * scr);
  const lowerScr = Math.min(tier2 + t3Scr, 0.5 * scr);
  const eligibleForScr = tier1 + lowerScr;
  if (tier1 < 0.5 * scr) breaches.push('Tier 1 below 50% of SCR');
  if (eligibleForScr < scr) breaches.push('Eligible own funds do not cover the SCR');

  // Eligible for MCR (Tier 3 not admitted)
  const t2Mcr = Math.min(tier2, 0.2 * mcr);
  const eligibleForMcr = tier1 + t2Mcr;
  if (tier1 < 0.8 * mcr) breaches.push('Tier 1 below 80% of MCR');
  if (eligibleForMcr < mcr) breaches.push('Eligible own funds do not cover the MCR');

  return {
    eligibleForScr,
    eligibleForMcr,
    scrRatio: eligibleForScr / scr,
    mcrRatio: eligibleForMcr / mcr,
    breaches,
  };
}
