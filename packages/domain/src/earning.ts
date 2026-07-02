/**
 * Premium earning patterns, UPR and DAC (brief §7.6, §9.8, §18.1; industry-gap
 * -analysis §2.2 item 6).
 *
 * Written premium is earned over the coverage period; the unearned remainder is
 * the Unearned Premium Reserve (UPR). Acquisition costs (ceding commission,
 * brokerage) are deferred (DAC) and amortised on the same pattern. Four
 * standard earning patterns are supported:
 *
 *  - `PRO_RATA`         daily pro-rata over the contract period (365ths-style)
 *  - `EIGHTHS`          quarterly 8ths: business is assumed written mid-quarter,
 *                       so cumulative earning at the end of quarter k (counted
 *                       from the calendar quarter containing inception) is
 *                       (2k−1)/8 - i.e. 1/8, 3/8, 5/8, 7/8, then fully earned.
 *  - `TWENTY_FOURTHS`   monthly 24ths: mid-month writing assumption, cumulative
 *                       (2k−1)/24 at the end of month k, fully earned after 13.
 *  - `RISK_ATTACHING`   risks-attaching treaty: premium covers underlying
 *                       policies attaching uniformly over the treaty period,
 *                       each earning pro-rata over one policy term. Earning
 *                       therefore runs over up to twice the treaty period
 *                       (24 months for an annual treaty) as a quadratic S-curve:
 *                       t²/2W² ramp up, 1−(2W−t)²/2W² ramp down (W = period days).
 *
 * Conventions:
 *  - Dates are plain YYYY-MM-DD strings; day maths uses the deterministic
 *    epoch-day conversion from aging.ts so the domain core stays clock-free.
 *    `asOf` is always an explicit parameter - never a wall clock.
 *  - A coverage day is earned at the **end** of that day: as-of the day before
 *    inception nothing is earned; as-of periodEnd the contract is fully earned.
 *  - EIGHTHS/TWENTY_FOURTHS are the classic *annual-policy* step approximations;
 *    for any actual term the expiry clamp guarantees full earning at periodEnd
 *    (no UPR can survive an expired contract).
 *  - Money stays integer minor units: the earned amount is produced by a single
 *    explicit rounding and the UPR/DAC is the exact integer complement, so
 *    earned + UPR === written to the minor unit (reconcilable, §7.6).
 */

import { Money, multiply, subtract, type Rounding } from './money.js';
import { epochDay } from './aging.js';

/** The supported earning patterns. Stored on the contract's term set as `earningPattern`. */
export const EARNING_PATTERNS = ['PRO_RATA', 'EIGHTHS', 'TWENTY_FOURTHS', 'RISK_ATTACHING'] as const;

export type EarningPattern = (typeof EARNING_PATTERNS)[number];

/** Type guard for values arriving from config / term sets. */
export function isEarningPattern(value: unknown): value is EarningPattern {
  return typeof value === 'string' && (EARNING_PATTERNS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Calendar helpers (pure, string-based - no Date, no clock)
// ---------------------------------------------------------------------------

function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new RangeError(`Expected an ISO date (YYYY-MM-DD), got ${iso}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Zero-based month counter (year × 12 + month − 1). */
function monthIndex(iso: string): number {
  const p = parseIsoDate(iso);
  return p.y * 12 + (p.m - 1);
}

/** Zero-based calendar-quarter counter (year × 4 + quarter − 1). */
function quarterIndex(iso: string): number {
  const p = parseIsoDate(iso);
  return p.y * 4 + Math.floor((p.m - 1) / 3);
}

/** ISO date of the first day of the given month index. */
function firstDayOfMonthIndex(mi: number): string {
  const y = Math.floor(mi / 12);
  const m = (mi % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

function isLastDayOfMonth(iso: string): boolean {
  return epochDay(iso) === epochDay(firstDayOfMonthIndex(monthIndex(iso) + 1)) - 1;
}

function isLastDayOfQuarter(iso: string): boolean {
  return epochDay(iso) === epochDay(firstDayOfMonthIndex((quarterIndex(iso) + 1) * 3)) - 1;
}

/**
 * Whole calendar months completed as of the end of `asOf`, counting from the
 * calendar month containing `startIso` as month 1 (complete once its last day
 * has ended). Can be negative when asOf precedes the start month.
 */
function completedMonthsSince(startIso: string, asOf: string): number {
  return monthIndex(asOf) - monthIndex(startIso) + (isLastDayOfMonth(asOf) ? 1 : 0);
}

/** Whole calendar quarters completed as of the end of `asOf` (see completedMonthsSince). */
function completedQuartersSince(startIso: string, asOf: string): number {
  return quarterIndex(asOf) - quarterIndex(startIso) + (isLastDayOfQuarter(asOf) ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Earned fraction
// ---------------------------------------------------------------------------

/**
 * Fraction of the written premium earned as of the **end of** `asOf`, in [0, 1].
 *
 * Boundary behaviour, all patterns:
 *  - asOf before periodStart → 0
 *  - PRO_RATA / EIGHTHS / TWENTY_FOURTHS: asOf at/after periodEnd → 1
 *  - RISK_ATTACHING: fully earned only at periodEnd + one period length
 *    (underlying policies attaching on the last day still have a term to run).
 *
 * @param pattern     one of EARNING_PATTERNS
 * @param periodStart contract inception, YYYY-MM-DD (earning/attachment starts)
 * @param periodEnd   contract expiry, YYYY-MM-DD (inclusive)
 * @param asOf        valuation date, YYYY-MM-DD - always explicit (no clock)
 */
export function earnedFraction(
  pattern: EarningPattern,
  periodStart: string,
  periodEnd: string,
  asOf: string,
): number {
  const start = epochDay(periodStart);
  const end = epochDay(periodEnd);
  const at = epochDay(asOf);
  if (end < start) {
    throw new RangeError(`periodEnd (${periodEnd}) must not be before periodStart (${periodStart})`);
  }
  /** Coverage days, inclusive of both endpoints. */
  const termDays = end - start + 1;

  if (pattern === 'RISK_ATTACHING') {
    // Uniform attachment over W days; each attached policy earns pro-rata over
    // a term of W days => quadratic S-curve over [0, 2W] elapsed days.
    const w = termDays;
    const t = Math.min(Math.max(at - start + 1, 0), 2 * w);
    if (t <= 0) return 0;
    if (t >= 2 * w) return 1;
    return t <= w ? (t * t) / (2 * w * w) : 1 - ((2 * w - t) * (2 * w - t)) / (2 * w * w);
  }

  if (at < start) return 0;
  if (at >= end) return 1; // an expired contract carries no UPR

  switch (pattern) {
    case 'PRO_RATA':
      return (at - start + 1) / termDays;
    case 'EIGHTHS': {
      const k = completedQuartersSince(periodStart, asOf);
      return k <= 0 ? 0 : k >= 5 ? 1 : (2 * k - 1) / 8;
    }
    case 'TWENTY_FOURTHS': {
      const k = completedMonthsSince(periodStart, asOf);
      return k <= 0 ? 0 : k >= 13 ? 1 : (2 * k - 1) / 24;
    }
    default:
      throw new RangeError(`Unknown earning pattern: ${String(pattern)}`);
  }
}

// ---------------------------------------------------------------------------
// UPR / DAC
// ---------------------------------------------------------------------------

export interface UprResult {
  /** Earned fraction applied, in [0,1]. */
  fraction: number;
  /** Premium earned to date (single explicit rounding). */
  earnedPremium: Money;
  /** Unearned Premium Reserve = written − earned, integer-exact. */
  upr: Money;
}

/**
 * Split written premium into earned premium and UPR as of `asOf`.
 * Integer-exact: `earnedPremium + upr === writtenPremium` to the minor unit,
 * because the UPR is computed as the exact complement of the (once-rounded)
 * earned amount - no lost or invented minor units (§7.6 reconcilability).
 */
export function computeUPR(
  writtenPremium: Money,
  pattern: EarningPattern,
  periodStart: string,
  periodEnd: string,
  asOf: string,
  rounding: Rounding = 'half-up',
): UprResult {
  const fraction = earnedFraction(pattern, periodStart, periodEnd, asOf);
  const earnedPremium = multiply(writtenPremium, fraction, rounding);
  return { fraction, earnedPremium, upr: subtract(writtenPremium, earnedPremium) };
}

export interface DacResult {
  /** Earned fraction applied, in [0,1] (same pattern as the premium). */
  fraction: number;
  /** Acquisition cost amortised (expensed) to date. */
  amortised: Money;
  /** Deferred Acquisition Cost = cost − amortised, integer-exact. */
  dac: Money;
}

/**
 * Split an acquisition cost (ceding commission, brokerage, …) into the portion
 * amortised to date and the Deferred Acquisition Cost, amortising on the same
 * earning pattern as the premium it acquired (matching principle).
 * Integer-exact: `amortised + dac === acquisitionCost`.
 */
export function computeDAC(
  acquisitionCost: Money,
  pattern: EarningPattern,
  periodStart: string,
  periodEnd: string,
  asOf: string,
  rounding: Rounding = 'half-up',
): DacResult {
  const fraction = earnedFraction(pattern, periodStart, periodEnd, asOf);
  const amortised = multiply(acquisitionCost, fraction, rounding);
  return { fraction, amortised, dac: subtract(acquisitionCost, amortised) };
}
