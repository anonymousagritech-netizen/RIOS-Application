/**
 * Treasury & investments (brief §13 - asset side). Pure valuation helpers for an
 * investment portfolio backing the reinsurer's reserves: accrued interest on
 * fixed-income holdings, unrealised P&L (market vs book), and a portfolio roll-up
 * with a book-value-weighted running yield. Money is integer minor units; rates
 * are fractions (0.045 = 4.5%). No I/O - unit-tested so valuations reconcile.
 */

export type InstrumentType = 'BOND' | 'BILL' | 'EQUITY' | 'CASH' | 'FUND';

export interface Holding {
  id?: string;
  name?: string;
  instrumentType: InstrumentType;
  currency: string;
  faceValueMinor: number;
  bookValueMinor: number;
  marketValueMinor: number;
  /** Annual coupon rate as a fraction (fixed income only). */
  couponRate?: number;
}

/**
 * Simple accrued interest on a fixed-income holding:
 *   face · coupon · (days / dayBasis), rounded to whole minor units.
 */
export function accruedInterest(faceValueMinor: number, couponRate: number, days: number, dayBasis = 365): number {
  if (days <= 0 || couponRate <= 0) return 0;
  return Math.round((faceValueMinor * couponRate * days) / dayBasis);
}

/** Unrealised gain (positive) or loss (negative): market − book. */
export function unrealisedPnl(marketValueMinor: number, bookValueMinor: number): number {
  return marketValueMinor - bookValueMinor;
}

export interface HoldingValuation {
  bookValueMinor: number;
  marketValueMinor: number;
  unrealisedMinor: number;
  accruedInterestMinor: number;
}

/** Value a single holding, optionally accruing interest over `days`. */
export function valueHolding(h: Holding, days = 0): HoldingValuation {
  return {
    bookValueMinor: h.bookValueMinor,
    marketValueMinor: h.marketValueMinor,
    unrealisedMinor: unrealisedPnl(h.marketValueMinor, h.bookValueMinor),
    accruedInterestMinor: h.couponRate ? accruedInterest(h.faceValueMinor, h.couponRate, days) : 0,
  };
}

export interface PortfolioSummary {
  count: number;
  bookValueMinor: number;
  marketValueMinor: number;
  unrealisedMinor: number;
  accruedInterestMinor: number;
  /** Book-value-weighted average coupon across income-bearing holdings (fraction). */
  bookYield: number;
}

/**
 * Roll a portfolio up. Same-currency only (cross-currency must be converted via
 * FX first); throws if mixed currencies are passed so a silent mis-add can't
 * happen. `days` accrues interest uniformly for the illustration.
 */
export function portfolioSummary(holdings: Holding[], days = 0): PortfolioSummary {
  const list = holdings ?? [];
  const currencies = new Set(list.map((h) => h.currency));
  if (currencies.size > 1) {
    throw new Error(`portfolioSummary requires a single currency, got: ${[...currencies].join(', ')}`);
  }
  let book = 0, market = 0, accrued = 0, weightedCoupon = 0, yieldBase = 0;
  for (const h of list) {
    book += h.bookValueMinor;
    market += h.marketValueMinor;
    accrued += h.couponRate ? accruedInterest(h.faceValueMinor, h.couponRate, days) : 0;
    if (h.couponRate) {
      weightedCoupon += h.couponRate * h.bookValueMinor;
      yieldBase += h.bookValueMinor;
    }
  }
  return {
    count: list.length,
    bookValueMinor: book,
    marketValueMinor: market,
    unrealisedMinor: market - book,
    accruedInterestMinor: accrued,
    bookYield: yieldBase > 0 ? weightedCoupon / yieldBase : 0,
  };
}

// ---------------------------------------------------------------------------
// Amortised cost / effective interest (IFRS 9) - premium/discount amortisation
// ---------------------------------------------------------------------------

function priceAtRate(rate: number, couponPerPeriodMinor: number, faceMinor: number, periods: number): number {
  let pv = 0;
  for (let t = 1; t <= periods; t++) {
    const cf = couponPerPeriodMinor + (t === periods ? faceMinor : 0);
    pv += cf / Math.pow(1 + rate, t);
  }
  return pv;
}

/**
 * Solve for the effective periodic interest rate (yield to maturity) that
 * discounts the coupon stream and redemption back to the purchase price, by
 * bisection. `couponPerPeriodMinor` is the cash coupon per period.
 */
export function effectivePeriodRate(priceMinor: number, faceMinor: number, couponPerPeriodMinor: number, periods: number): number {
  if (priceMinor <= 0 || periods <= 0) throw new RangeError('price and periods must be positive');
  let lo = -0.9999, hi = 1.0;
  // PV is monotonically decreasing in the rate, so bisect on the sign of (PV - price).
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (priceAtRate(mid, couponPerPeriodMinor, faceMinor, periods) > priceMinor) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface AmortInput {
  priceMinor: number;
  faceMinor: number;
  /** Annual coupon rate as a fraction (e.g. 0.05 = 5%). */
  couponRate: number;
  /** Number of coupon periods to maturity. */
  periods: number;
  /** Coupon frequency per year (1 = annual, 2 = semi-annual). */
  frequency?: number;
}

export interface AmortPeriod {
  period: number;
  openingMinor: number;
  interestIncomeMinor: number;
  couponMinor: number;
  amortisationMinor: number;
  closingMinor: number;
}

export interface AmortSchedule {
  effectivePeriodRate: number;
  effectiveAnnualYield: number;
  periods: AmortPeriod[];
}

/**
 * Effective-interest amortised-cost schedule for a fixed-income holding bought
 * at a premium or discount. Interest income = carrying x EIR; the difference
 * between income and the cash coupon amortises the premium/discount so the
 * carrying amount converges to par (face) at maturity (final period squared off).
 */
export function amortisedCostSchedule(input: AmortInput): AmortSchedule {
  const freq = input.frequency ?? 1;
  const couponPerPeriod = Math.round((input.faceMinor * input.couponRate) / freq);
  const r = effectivePeriodRate(input.priceMinor, input.faceMinor, couponPerPeriod, input.periods);
  const rows: AmortPeriod[] = [];
  let carrying = input.priceMinor;
  for (let t = 1; t <= input.periods; t++) {
    const opening = carrying;
    let interest = Math.round(opening * r);
    let amort = interest - couponPerPeriod;
    if (t === input.periods) {
      // Square off any rounding drift so the holding redeems exactly at par.
      amort = input.faceMinor - opening;
      interest = amort + couponPerPeriod;
    }
    carrying = opening + amort;
    rows.push({
      period: t,
      openingMinor: opening,
      interestIncomeMinor: interest,
      couponMinor: couponPerPeriod,
      amortisationMinor: amort,
      closingMinor: carrying,
    });
  }
  return { effectivePeriodRate: r, effectiveAnnualYield: Math.pow(1 + r, freq) - 1, periods: rows };
}
