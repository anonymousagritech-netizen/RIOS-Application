/**
 * IFRS 17 — Premium Allocation Approach (PAA) measurement (brief §18.1).
 *
 * Implements the PAA mechanics most relevant to short-duration reinsurance:
 * the Liability for Remaining Coverage (LRC) roll-forward, the Liability for
 * Incurred Claims (LIC) as discounted fulfilment cash flows plus a risk
 * adjustment, and onerous-contract loss-component identification.
 *
 * This is an explainable, reconcilable skeleton (brief §4.4) — not a full
 * actuarial engine (GMM/VFA, CSM amortisation schedules, and discounting curves
 * are designed-for; see docs/open-questions.md). All amounts are minor units.
 */

import { Money, money, zero, add, subtract, multiply, max, isNegative } from './money.js';

// ---------------------------------------------------------------------------
// Liability for Remaining Coverage (PAA)
// ---------------------------------------------------------------------------

export interface PaaLrcInput {
  /** Premium received for the group of contracts. */
  premiumReceived: Money;
  /** Acquisition cash flows (deferred and amortised over coverage). */
  acquisitionCashFlows: Money;
  /** Fraction of the coverage period elapsed, in [0,1] (drives earning). */
  coverageElapsed: number;
}

export interface PaaLrcResult {
  /** Premium earned to date (revenue). */
  earnedPremium: Money;
  /** Acquisition cost amortised to date (expense). */
  amortisedAcquisition: Money;
  /** LRC carrying amount = unearned premium net of unamortised acquisition CF. */
  lrc: Money;
}

export function paaLrc(input: PaaLrcInput): PaaLrcResult {
  const t = Math.max(0, Math.min(1, input.coverageElapsed));
  const earnedPremium = multiply(input.premiumReceived, t);
  const amortisedAcquisition = multiply(input.acquisitionCashFlows, t);
  const unearned = subtract(input.premiumReceived, earnedPremium);
  const unamortisedAcq = subtract(input.acquisitionCashFlows, amortisedAcquisition);
  return {
    earnedPremium,
    amortisedAcquisition,
    lrc: subtract(unearned, unamortisedAcq),
  };
}

// ---------------------------------------------------------------------------
// Liability for Incurred Claims (fulfilment cash flows + risk adjustment)
// ---------------------------------------------------------------------------

export interface LicInput {
  /** Estimate of future claim payments (undiscounted). */
  expectedClaims: Money;
  /** Discount factor in (0,1] applied to expected claims (time value of money). */
  discountFactor: number;
  /** Risk adjustment for non-financial risk, as a fraction of discounted claims (e.g. 0.06). */
  riskAdjustmentPct: number;
}

export interface LicResult {
  discountedClaims: Money;
  riskAdjustment: Money;
  /** LIC = discounted fulfilment cash flows + risk adjustment. */
  lic: Money;
}

export function lic(input: LicInput): LicResult {
  const discountedClaims = multiply(input.expectedClaims, input.discountFactor);
  const riskAdjustment = multiply(discountedClaims, input.riskAdjustmentPct);
  return {
    discountedClaims,
    riskAdjustment,
    lic: add(discountedClaims, riskAdjustment),
  };
}

// ---------------------------------------------------------------------------
// Onerous-contract test (loss component)
// ---------------------------------------------------------------------------

export interface OnerousInput {
  /** Expected fulfilment cash outflows over the coverage period (claims + expenses). */
  fulfilmentCashFlows: Money;
  /** Premium net of acquisition cash flows allocated to remaining coverage. */
  lrcExcludingLossComponent: Money;
}

export interface OnerousResult {
  onerous: boolean;
  /** Loss component recognised immediately in P&L when the group is onerous. */
  lossComponent: Money;
}

/**
 * Under PAA a group is onerous when facts indicate fulfilment cash flows exceed
 * the LRC; the excess is booked immediately as a loss component (IFRS 17 §57–58).
 */
export function onerousTest(input: OnerousInput): OnerousResult {
  const excess = subtract(input.fulfilmentCashFlows, input.lrcExcludingLossComponent);
  if (isNegative(excess) || excess.amount === 0) {
    return { onerous: false, lossComponent: zero(input.fulfilmentCashFlows.currency) };
  }
  return { onerous: true, lossComponent: excess };
}

// ---------------------------------------------------------------------------
// Insurance contract liability summary
// ---------------------------------------------------------------------------

export interface InsuranceLiabilityInput {
  lrc: Money;
  lic: Money;
  lossComponent: Money;
}

/** Total insurance contract liability = LRC (incl. loss component) + LIC. */
export function insuranceContractLiability(input: InsuranceLiabilityInput): Money {
  return add(add(max(input.lrc, zero(input.lrc.currency)), input.lossComponent), input.lic);
}
