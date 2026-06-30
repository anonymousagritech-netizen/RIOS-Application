/**
 * Money handling for RIOS.
 *
 * Brief §16.1 / §20 (Data integrity): "never floating-point for monetary values".
 *
 * Money is represented as an integer number of **minor units** (e.g. cents) plus
 * an ISO-4217 currency code. All arithmetic is integer arithmetic. Rates and
 * percentages are applied through a single, explicitly-rounded helper so that
 * every monetary result is reproducible and reconcilable.
 *
 * We deliberately keep this dependency-free and pure: the domain core must be
 * unit-testable without a database, a framework, or a clock (brief §4.4).
 */

/** Rounding strategy for converting a fractional minor-unit result to an integer. */
export type Rounding = 'half-up' | 'half-even' | 'down' | 'up';

/** Number of minor units in one major unit, by currency. Configurable per tenant in the real system (§10); these are sane ISO defaults. */
const DEFAULT_MINOR_UNITS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, ZAR: 2, SGD: 2, HKD: 2,
  JPY: 0, KRW: 0, CLP: 0,
  BHD: 3, KWD: 3, TND: 3,
};

export function minorUnitsFor(currency: string): number {
  const u = DEFAULT_MINOR_UNITS[currency.toUpperCase()];
  return u === undefined ? 2 : u;
}

export interface Money {
  /** Signed integer count of minor units. */
  readonly amount: number;
  /** ISO-4217 alphabetic code, upper-case. */
  readonly currency: string;
}

export class MoneyError extends Error {}

export function money(amount: number, currency: string): Money {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(`Money amount must be an integer count of minor units, got ${amount}`);
  }
  return { amount, currency: currency.toUpperCase() };
}

/** Construct Money from a major-unit decimal (e.g. 1234.56 USD). Rounds to the currency's minor units. */
export function fromMajor(major: number, currency: string, rounding: Rounding = 'half-up'): Money {
  const factor = Math.pow(10, minorUnitsFor(currency));
  return money(roundToInt(major * factor, rounding), currency);
}

export function toMajor(m: Money): number {
  return m.amount / Math.pow(10, minorUnitsFor(m.currency));
}

export const zero = (currency: string): Money => money(0, currency);

export const isZero = (m: Money): boolean => m.amount === 0;
export const isNegative = (m: Money): boolean => m.amount < 0;

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}. Cross-currency operations must go through FX.`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function sum(items: Money[], currency?: string): Money {
  if (items.length === 0) {
    if (!currency) throw new MoneyError('Cannot sum an empty list without a currency');
    return zero(currency);
  }
  return items.reduce((acc, m) => add(acc, m));
}

/** Compare: returns -1, 0, 1. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

export const max = (a: Money, b: Money): Money => (compare(a, b) >= 0 ? a : b);
export const min = (a: Money, b: Money): Money => (compare(a, b) <= 0 ? a : b);

/** Clamp a money value into [lo, hi]. */
export function clamp(m: Money, lo: Money, hi: Money): Money {
  return max(lo, min(m, hi));
}

function roundToInt(value: number, rounding: Rounding): number {
  switch (rounding) {
    case 'down':
      return Math.trunc(value);
    case 'up':
      return value >= 0 ? Math.ceil(value) : Math.floor(value);
    case 'half-even': {
      const floor = Math.floor(value);
      const diff = value - floor;
      if (diff < 0.5) return floor;
      if (diff > 0.5) return floor + 1;
      return floor % 2 === 0 ? floor : floor + 1;
    }
    case 'half-up':
    default:
      return Math.sign(value) * Math.round(Math.abs(value));
  }
}

/**
 * Multiply money by a unit-bearing factor (e.g. a rate of 0.025, a share of 0.30).
 * Performed on the integer minor units with a single, explicit rounding step.
 */
export function multiply(m: Money, factor: number, rounding: Rounding = 'half-up'): Money {
  if (!Number.isFinite(factor)) throw new MoneyError(`Factor must be finite, got ${factor}`);
  return money(roundToInt(m.amount * factor, rounding), m.currency);
}

/**
 * Apply a percentage (e.g. 12.5 means 12.5%). Convenience over multiply().
 */
export function percentOf(m: Money, percent: number, rounding: Rounding = 'half-up'): Money {
  return multiply(m, percent / 100, rounding);
}

/**
 * Allocate an amount across integer weights with no lost or invented minor units
 * (the classic "penny allocation" problem). The sum of the parts always equals
 * the original amount exactly - essential for reconciliation (§7.6).
 */
export function allocate(m: Money, weights: number[]): Money[] {
  if (weights.length === 0) throw new MoneyError('allocate requires at least one weight');
  if (weights.some((w) => w < 0)) throw new MoneyError('allocate weights must be non-negative');
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) throw new MoneyError('allocate weights must not all be zero');

  const parts: number[] = [];
  let allocated = 0;
  for (const w of weights) {
    const part = Math.trunc((m.amount * w) / total);
    parts.push(part);
    allocated += part;
  }
  // Distribute the remainder one minor unit at a time to the largest weights.
  let remainder = m.amount - allocated;
  const order = weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w - a.w)
    .map((x) => x.i);
  let idx = 0;
  const step = remainder >= 0 ? 1 : -1;
  while (remainder !== 0) {
    const target = order[idx % order.length]!;
    parts[target] = parts[target]! + step;
    remainder -= step;
    idx++;
  }
  return parts.map((p) => money(p, m.currency));
}

/** Human-readable formatting for logs/tests (not the i18n display layer). */
export function format(m: Money): string {
  return `${toMajor(m).toFixed(minorUnitsFor(m.currency))} ${m.currency}`;
}
