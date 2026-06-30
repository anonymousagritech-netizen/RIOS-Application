/**
 * Foreign-exchange conversion (brief §7.6, §16.1, §19).
 *
 * Original vs settlement currency with explicit rounding. Rates are passed in
 * (sourced from the exchange_rate reference table); the domain core never
 * fetches them. A conversion records the rate used so the result is reproducible
 * and auditable.
 */

import { Money, money, minorUnitsFor, fromMajor, toMajor, type Rounding } from './money.js';

export interface FxConversion {
  from: Money;
  to: Money;
  rate: number;
  rateInverse: number;
}

/**
 * Convert `amount` into `toCurrency` at `rate` (units of toCurrency per 1 unit of
 * fromCurrency). Conversion is done on major units then re-quantised to the
 * target currency's minor units, so cross-precision pairs (e.g. USD↔JPY) are
 * handled correctly.
 */
export function convert(amount: Money, toCurrency: string, rate: number, rounding: Rounding = 'half-up'): FxConversion {
  if (!(rate > 0) || !Number.isFinite(rate)) throw new RangeError(`FX rate must be positive and finite, got ${rate}`);
  const target = toCurrency.toUpperCase();
  if (amount.currency === target) {
    return { from: amount, to: amount, rate: 1, rateInverse: 1 };
  }
  const majorIn = toMajor(amount);
  const majorOut = majorIn * rate;
  return {
    from: amount,
    to: fromMajor(majorOut, target, rounding),
    rate,
    rateInverse: 1 / rate,
  };
}

/** Revalue a foreign-currency balance at a new rate; returns the FX gain/loss in the base currency. */
export function revalue(
  originalAmount: Money,
  baseCurrency: string,
  bookedRate: number,
  currentRate: number,
  rounding: Rounding = 'half-up',
): { atBooked: Money; atCurrent: Money; gainLoss: Money } {
  const atBooked = convert(originalAmount, baseCurrency, bookedRate, rounding).to;
  const atCurrent = convert(originalAmount, baseCurrency, currentRate, rounding).to;
  return {
    atBooked,
    atCurrent,
    gainLoss: money(atCurrent.amount - atBooked.amount, baseCurrency),
  };
}

/** Triangulate a cross rate through a common currency (e.g. GBP→USD→EUR). */
export function crossRate(rateFromBase: number, rateToBase: number): number {
  if (!(rateToBase > 0)) throw new RangeError('rateToBase must be positive');
  return rateFromBase / rateToBase;
}

export const minorUnits = minorUnitsFor;
