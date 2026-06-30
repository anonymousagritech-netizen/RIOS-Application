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

// ---------------------------------------------------------------------------
// General Measurement Model (GMM / BBA) — brief §18.1
// ---------------------------------------------------------------------------

export interface GmmInitialInput {
  /** PV of future cash inflows (premiums). */
  presentValueOfPremiums: Money;
  /** PV of future cash outflows (claims + expenses). */
  presentValueOfClaims: Money;
  /** Risk adjustment for non-financial risk. */
  riskAdjustment: Money;
}

export interface GmmInitialResult {
  /** Fulfilment cash flows = PV(outflows) − PV(inflows) + risk adjustment (a liability when positive). */
  fulfilmentCashFlows: Money;
  /** CSM = the unearned profit; positive only when the group is profitable at inception. */
  csm: Money;
  onerous: boolean;
  /** Loss component recognised immediately when the group is onerous. */
  lossComponent: Money;
}

/**
 * GMM initial measurement (IFRS 17 §32, §38, §47–48):
 *   FCF = PV(claims) − PV(premiums) + RA
 *   if FCF < 0 (net inflow expected) the group is profitable → CSM = −FCF, no loss
 *   if FCF ≥ 0 the group is onerous → CSM = 0, loss component = FCF
 */
export function gmmInitialMeasurement(input: GmmInitialInput): GmmInitialResult {
  const currency = input.presentValueOfPremiums.currency;
  const fulfilmentCashFlows = add(
    subtract(input.presentValueOfClaims, input.presentValueOfPremiums),
    input.riskAdjustment,
  );
  if (fulfilmentCashFlows.amount < 0) {
    return {
      fulfilmentCashFlows,
      csm: money(-fulfilmentCashFlows.amount, currency),
      onerous: false,
      lossComponent: zero(currency),
    };
  }
  return {
    fulfilmentCashFlows,
    csm: zero(currency),
    onerous: true,
    lossComponent: fulfilmentCashFlows,
  };
}

export interface CsmRollforwardInput {
  openingCsm: Money;
  /** Interest accretion rate for the period (locked-in discount rate), e.g. 0.03. */
  interestAccretionRate: number;
  /** CSM from new contracts added in the period. */
  newBusinessCsm?: Money;
  /** Changes in estimates of future cash flows that adjust the CSM (favourable negative outflow ⇒ +CSM). */
  changeInEstimates?: Money;
  /** Coverage units provided this period and total remaining (incl. this period) to derive the release. */
  coverageUnitsThisPeriod: number;
  coverageUnitsRemaining: number;
}

export interface CsmRollforwardResult {
  csmAfterInterest: Money;
  csmAfterNewBusiness: Money;
  csmAfterChanges: Money;
  /** Amount of CSM released to P&L this period (insurance revenue) on a coverage-unit basis. */
  released: Money;
  closingCsm: Money;
}

/**
 * CSM roll-forward (IFRS 17 §44):
 *   opening → + interest accretion → + new business → ± changes in estimates
 *   → − release (by coverage units) = closing.
 * The CSM cannot go negative; a change in estimates that would make it negative
 * is absorbed and the excess becomes a loss (handled by the caller via onerous test).
 */
export function csmRollforward(input: CsmRollforwardInput): CsmRollforwardResult {
  const currency = input.openingCsm.currency;
  const interest = multiply(input.openingCsm, input.interestAccretionRate);
  const csmAfterInterest = add(input.openingCsm, interest);
  const csmAfterNewBusiness = add(csmAfterInterest, input.newBusinessCsm ?? zero(currency));
  let csmAfterChanges = add(csmAfterNewBusiness, input.changeInEstimates ?? zero(currency));
  if (csmAfterChanges.amount < 0) csmAfterChanges = zero(currency);

  const fraction =
    input.coverageUnitsRemaining > 0
      ? Math.min(1, input.coverageUnitsThisPeriod / input.coverageUnitsRemaining)
      : 0;
  const released = multiply(csmAfterChanges, fraction);
  return {
    csmAfterInterest,
    csmAfterNewBusiness,
    csmAfterChanges,
    released,
    closingCsm: subtract(csmAfterChanges, released),
  };
}

// ---------------------------------------------------------------------------
// Variable Fee Approach (VFA) — brief §18.1
// ---------------------------------------------------------------------------

export interface VfaRollforwardInput extends CsmRollforwardInput {
  /**
   * Change in the entity's share of the fair value of underlying items (the
   * variable fee). Under VFA this adjusts the CSM rather than going to P&L.
   */
  changeInVariableFee: Money;
}

/**
 * VFA CSM roll-forward (IFRS 17 §45): like GMM but the change in the entity's
 * share of underlying items also adjusts the CSM before the release.
 */
export function vfaCsmRollforward(input: VfaRollforwardInput): CsmRollforwardResult {
  const base = csmRollforward({
    ...input,
    changeInEstimates: add(input.changeInEstimates ?? zero(input.openingCsm.currency), input.changeInVariableFee),
  });
  return base;
}
