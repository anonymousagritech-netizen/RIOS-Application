/**
 * Commutation and Loss Portfolio Transfer valuation (brief §7.4, §7.5).
 *
 * When outstanding liabilities are settled early (commutation) or transferred
 * (LPT/ADC), the consideration is the present value of the outstanding claims
 * plus a risk load, not the nominal reserve. These pure calculators value that
 * consideration and the economic gain/loss to each party. Time value uses a
 * single mean-term discount (amount / (1 + r)^t); the server sources the rate
 * and term, and books the resulting settlement through the accounting chain.
 */

import { Money, multiply, subtract, add, zero } from './money.js';

function discountFactor(rate: number, term: number): number {
  if (!(rate > -1)) throw new RangeError(`Discount rate must be > -100%, got ${rate}`);
  if (term < 0) throw new RangeError(`Mean term must be non-negative, got ${term}`);
  return 1 / Math.pow(1 + rate, term);
}

export interface CommutationInput {
  /** Nominal outstanding liabilities being commuted (case + IBNR). */
  outstanding: Money;
  discountRate: number;
  meanTermYears: number;
  /** Risk load as a percentage of the present value (e.g. 7.5 = 7.5%). */
  riskLoadPct: number;
  /** Cedent's carried reinsurance recoverable asset; defaults to nominal outstanding. */
  cedentCarriedRecoverable?: Money;
  /** Reinsurer's carried reserve for the liability; defaults to nominal outstanding. */
  reinsurerCarriedReserve?: Money;
}

export interface CommutationResult {
  pvOutstanding: Money;
  riskLoad: Money;
  /** Cash consideration to extinguish the liability = PV + risk load. */
  commutationPrice: Money;
  /** Cedent: price received minus the recoverable asset given up (negative = accepts a discount). */
  cedentGainLoss: Money;
  /** Reinsurer: carried reserve released minus price paid (positive = releases discount + risk). */
  reinsurerGainLoss: Money;
}

/** Value a commutation and the economic result to cedent and reinsurer. */
export function commute(input: CommutationInput): CommutationResult {
  const df = discountFactor(input.discountRate, input.meanTermYears);
  const pv = multiply(input.outstanding, df);
  const riskLoad = multiply(pv, input.riskLoadPct / 100);
  const price = add(pv, riskLoad);
  const cedentAsset = input.cedentCarriedRecoverable ?? input.outstanding;
  const reinsurerReserve = input.reinsurerCarriedReserve ?? input.outstanding;
  return {
    pvOutstanding: pv,
    riskLoad,
    commutationPrice: price,
    cedentGainLoss: subtract(price, cedentAsset),
    reinsurerGainLoss: subtract(reinsurerReserve, price),
  };
}

export interface LptInput {
  /** Nominal reserves being transferred to the assuming reinsurer. */
  reservesTransferred: Money;
  discountRate: number;
  meanTermYears: number;
  /** Risk margin as a percentage of the present value. */
  riskMarginPct: number;
  /** Optional expense/profit load as a percentage of the present value. */
  expenseLoadPct?: number;
}

export interface LptResult {
  pvReserves: Money;
  riskMargin: Money;
  expenseLoad: Money;
  /** Premium the ceding insurer pays the assuming reinsurer. */
  premium: Money;
  /** Ceding insurer's economic result: nominal reserve released minus premium paid. */
  cedingBenefit: Money;
}

/**
 * Loss Portfolio Transfer: the assuming reinsurer takes on the run-off in return
 * for a premium equal to the discounted reserves plus a risk margin and expense
 * load. The ceding insurer releases the nominal reserve; the difference is the
 * economic cost (or capital-relief benefit) of the transfer.
 */
export function lossPortfolioTransfer(input: LptInput): LptResult {
  const df = discountFactor(input.discountRate, input.meanTermYears);
  const pv = multiply(input.reservesTransferred, df);
  const riskMargin = multiply(pv, input.riskMarginPct / 100);
  const expenseLoad = input.expenseLoadPct ? multiply(pv, input.expenseLoadPct / 100) : zero(pv.currency);
  const premium = add(add(pv, riskMargin), expenseLoad);
  return {
    pvReserves: pv,
    riskMargin,
    expenseLoad,
    premium,
    cedingBenefit: subtract(input.reservesTransferred, premium),
  };
}
