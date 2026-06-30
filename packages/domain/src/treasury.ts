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
