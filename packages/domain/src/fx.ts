/**
 * Foreign-exchange conversion (brief §7.6, §16.1, §19).
 *
 * Original vs settlement currency with explicit rounding. Rates are passed in
 * (sourced from the exchange_rate reference table); the domain core never
 * fetches them. A conversion records the rate used so the result is reproducible
 * and auditable.
 */

import {
  Money, money, minorUnitsFor, fromMajor, toMajor, add, subtract, negate, zero,
  type Rounding,
} from './money.js';

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

// ---------------------------------------------------------------------------
// Period-end revaluation engine (brief §7.6, §16.1)
//
// Monetary assets/liabilities held in a foreign currency are re-translated to
// the reporting (base) currency at the closing rate. The change in base-currency
// carrying amount since initial recognition is an *unrealized* FX gain/loss;
// when the item is settled at the settlement rate it becomes *realized*. Both
// flow to the P&L, sign-corrected for whether the item is an asset or liability.
// ---------------------------------------------------------------------------

export type FxKind = 'asset' | 'liability';

/** An open foreign-currency monetary balance awaiting settlement/revaluation. */
export interface MonetaryItem {
  id: string;
  /** Carrying amount in its own (foreign) currency; always held as a positive magnitude. */
  amount: Money;
  /** Base per 1 unit of the foreign currency at initial recognition. */
  bookedRate: number;
  /** Asset (receivable) by default; liabilities move the P&L the opposite way. */
  kind?: FxKind;
}

export interface ItemRevaluation {
  id: string;
  currency: string;
  kind: FxKind;
  atBooked: Money;
  atCurrent: Money;
  /** atCurrent - atBooked: the change in base-currency carrying amount. */
  carryingDelta: Money;
  /** P&L effect, sign-corrected for asset vs liability. */
  gainLoss: Money;
}

export interface FxPosting {
  account: string;
  amount: Money;
  side: 'debit' | 'credit';
}

export interface PortfolioRevaluation {
  base: string;
  items: ItemRevaluation[];
  /** Net unrealized P&L across the whole portfolio, in base currency. */
  netGainLoss: Money;
  /** Base-currency exposure and P&L, bucketed by foreign currency. */
  byCurrency: Record<string, { exposure: Money; gainLoss: Money }>;
  /** Balanced GL postings (debits === credits) recognising the net movement. */
  postings: FxPosting[];
}

const FX_MONETARY_POSITION = 'FX_MONETARY_POSITION';
const FX_REVALUATION_GAIN = 'FX_REVALUATION_GAIN';
const FX_REVALUATION_LOSS = 'FX_REVALUATION_LOSS';

function signForKind(delta: Money, kind: FxKind): Money {
  return kind === 'liability' ? negate(delta) : delta;
}

/** Revalue a single monetary item to the closing rate (unrealized gain/loss). */
export function revalueItem(
  item: MonetaryItem,
  baseCurrency: string,
  currentRate: number,
  rounding: Rounding = 'half-up',
): ItemRevaluation {
  if (item.amount.amount < 0) {
    throw new RangeError(`MonetaryItem.amount must be a positive magnitude (use kind), got ${item.amount.amount}`);
  }
  const base = baseCurrency.toUpperCase();
  const kind = item.kind ?? 'asset';
  const atBooked = convert(item.amount, base, item.bookedRate, rounding).to;
  const atCurrent = convert(item.amount, base, currentRate, rounding).to;
  const carryingDelta = subtract(atCurrent, atBooked);
  return {
    id: item.id,
    currency: item.amount.currency,
    kind,
    atBooked,
    atCurrent,
    carryingDelta,
    gainLoss: signForKind(carryingDelta, kind),
  };
}

/**
 * Revalue a whole portfolio of monetary items at period-end. `ratesByCurrency`
 * maps each foreign currency to its closing rate (base per 1 unit of foreign).
 * Returns per-item detail, per-currency buckets, the net P&L, and a pair of
 * balanced GL postings recognising it.
 */
export function revaluePortfolio(
  items: MonetaryItem[],
  baseCurrency: string,
  ratesByCurrency: Record<string, number>,
  rounding: Rounding = 'half-up',
): PortfolioRevaluation {
  const base = baseCurrency.toUpperCase();
  const revalued: ItemRevaluation[] = [];
  const byCurrency: Record<string, { exposure: Money; gainLoss: Money }> = {};
  let net = zero(base);

  for (const item of items) {
    const cur = item.amount.currency.toUpperCase();
    const rate = cur === base ? 1 : ratesByCurrency[cur];
    if (rate === undefined) throw new RangeError(`No closing rate supplied for currency ${cur}`);
    const r = revalueItem(item, base, rate, rounding);
    revalued.push(r);
    net = add(net, r.gainLoss);
    const bucket = byCurrency[cur] ?? { exposure: zero(base), gainLoss: zero(base) };
    bucket.exposure = add(bucket.exposure, r.atCurrent);
    bucket.gainLoss = add(bucket.gainLoss, r.gainLoss);
    byCurrency[cur] = bucket;
  }

  const postings: FxPosting[] = [];
  if (net.amount > 0) {
    postings.push({ account: FX_MONETARY_POSITION, amount: net, side: 'debit' });
    postings.push({ account: FX_REVALUATION_GAIN, amount: net, side: 'credit' });
  } else if (net.amount < 0) {
    const mag = negate(net);
    postings.push({ account: FX_REVALUATION_LOSS, amount: mag, side: 'debit' });
    postings.push({ account: FX_MONETARY_POSITION, amount: mag, side: 'credit' });
  }

  return { base, items: revalued, netGainLoss: net, byCurrency, postings };
}

export interface Settlement {
  atBooked: Money;
  atSettlement: Money;
  /** Realized P&L in base currency (sign-corrected for asset vs liability). */
  realized: Money;
}

/** Settle a foreign item at the settlement rate, crystallising a realized FX gain/loss. */
export function settle(
  item: MonetaryItem,
  baseCurrency: string,
  settlementRate: number,
  rounding: Rounding = 'half-up',
): Settlement {
  const base = baseCurrency.toUpperCase();
  const kind = item.kind ?? 'asset';
  const atBooked = convert(item.amount, base, item.bookedRate, rounding).to;
  const atSettlement = convert(item.amount, base, settlementRate, rounding).to;
  return { atBooked, atSettlement, realized: signForKind(subtract(atSettlement, atBooked), kind) };
}

/** Net open FX exposure by currency, expressed in the foreign currency (asset - liability). */
export function netOpenExposure(items: MonetaryItem[]): Record<string, Money> {
  const out: Record<string, Money> = {};
  for (const item of items) {
    const cur = item.amount.currency.toUpperCase();
    const signed = (item.kind ?? 'asset') === 'liability' ? negate(item.amount) : item.amount;
    out[cur] = out[cur] ? add(out[cur], signed) : signed;
  }
  return out;
}
