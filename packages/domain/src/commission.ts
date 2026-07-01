/**
 * Reinsurance commission calculations - brief §7.2 (proportional commission stack).
 *
 * Pure, deterministic, currency-consistent functions covering the commission
 * vocabulary that sits on top of a proportional cession:
 *
 *   - flat ceding commission
 *   - sliding-scale commission (loss-ratio bands or a linear slide)
 *   - profit commission with deficit carry-forward
 *   - overriding commission (broker override on ceded premium)
 *   - brokerage
 *
 * Money is integer minor units throughout (brief §16.1 / §20); all monetary
 * arithmetic goes through the `@rios/domain` money helpers - never raw floats on
 * money. Rates are plain numbers.
 *
 * **Rate convention:** rates in this module are **decimal fractions** in [0,1]
 * (e.g. `0.25` = 25%), consistent with cession shares in `proportional.ts`. The
 * one exception is `flatCedingCommission`, whose `ratePpm` argument is expressed
 * in **parts-per-million** (e.g. `250_000` ppm = 25%) so that integer-precise
 * rates can be passed without binary-float drift; it is documented inline.
 *
 * Like the rest of the domain core this file is dependency-free and clock-free so
 * it is unit-testable without a database, framework, or clock (brief §4.4).
 */

import { Money, money, multiply, subtract, zero } from './money.js';

// ---------------------------------------------------------------------------
// Flat ceding commission
// ---------------------------------------------------------------------------

/**
 * Flat ceding commission: a single fixed rate applied to the (ceded) premium.
 *
 * The rate is expressed in **parts-per-million** (ppm): `250_000` = 25%. ppm is
 * used here so the caller can specify integer-precise rates (e.g. 27.5% = 275_000
 * ppm) without relying on binary-float percentages; the conversion to the money
 * multiplier is a single `/ 1_000_000` and the result is rounded once by
 * `multiply`.
 *
 * @param premiumMinor ceded (or subject) premium as Money in minor units
 * @param ratePpm commission rate in parts-per-million, e.g. 250_000 = 25%
 * @returns the ceding commission as Money in the same currency
 */
export function flatCedingCommission(premiumMinor: Money, ratePpm: number): Money {
  if (!Number.isFinite(ratePpm) || ratePpm < 0) {
    throw new RangeError(`flatCedingCommission ratePpm must be a non-negative number, got ${ratePpm}`);
  }
  return multiply(premiumMinor, ratePpm / 1_000_000);
}

// ---------------------------------------------------------------------------
// Sliding-scale commission
// ---------------------------------------------------------------------------

/**
 * A loss-ratio band point for sliding-scale commission. The commission rate
 * applies for loss ratios at or below `lossRatioUpTo`. Bands are read in
 * ascending `lossRatioUpTo` order; commission slides **down** as the loss ratio
 * rises (the reinsurer pays less when the business runs worse).
 */
export interface SlidingScaleBand {
  /** Upper loss-ratio bound this band covers, as a fraction (e.g. 0.60 = 60%). */
  lossRatioUpTo: number;
  /** Commission rate for this band, as a decimal fraction (e.g. 0.30 = 30%). */
  commissionRate: number;
}

export interface SlidingScaleInput {
  /** Subject premium as Money in minor units. */
  premiumMinor: Money;
  /** Incurred losses (paid + outstanding) as Money in minor units. */
  incurredLossMinor: Money;
  /** Provisional commission rate booked before the slide is known (fraction). */
  provisionalRate: number;
  /** Minimum commission rate floor (fraction). */
  minRate: number;
  /** Maximum commission rate ceiling (fraction). */
  maxRate: number;
  /**
   * Slide rate per loss-ratio point for the LINEAR fallback: how much the
   * commission rate decreases per 1 percentage point of loss ratio above the
   * point where `maxRate` applies. Expressed as a fraction per LR-point
   * (e.g. 0.5 means commission drops 0.5% for each 1% of loss ratio).
   * Ignored when `bands` is supplied; defaults to 0.
   */
  slideRatePerLossRatioPoint?: number;
  /**
   * Optional explicit loss-ratio bands (preferred). When present the effective
   * rate is the rate of the lowest band whose `lossRatioUpTo` is >= the actual
   * loss ratio; below the first band -> maxRate, above the last band -> minRate.
   */
  bands?: SlidingScaleBand[];
}

export interface SlidingScaleResult {
  /** Actual loss ratio = incurred losses / premium (0 if premium is zero). */
  lossRatio: number;
  /** Commission rate actually applied after the slide, clamped to [minRate,maxRate]. */
  effectiveRate: number;
  /** Provisional commission booked at `provisionalRate`. */
  provisionalCommission: Money;
  /** Final commission at the slid `effectiveRate`. */
  finalCommission: Money;
  /**
   * Adjustment = final − provisional. Positive means more commission is owed to
   * the cedent; negative means a clawback from the cedent.
   */
  adjustment: Money;
}

/**
 * Sliding-scale commission. The commission rate slides **inversely** with the
 * loss ratio between `minRate` and `maxRate`.
 *
 * Two slide modes:
 *  - **bands** (preferred): the effective rate is the `commissionRate` of the
 *    lowest band whose `lossRatioUpTo` is at or above the actual loss ratio.
 *    A loss ratio below every band gets `maxRate`; above every band gets `minRate`.
 *  - **linear**: starting from `maxRate` at a loss ratio of 0, the rate falls by
 *    `slideRatePerLossRatioPoint`% for every 1 percentage point of loss ratio,
 *    clamped to [minRate, maxRate].
 *
 * Returns provisional and final commission amounts plus the effective rate.
 */
export function slidingScaleCommission(input: SlidingScaleInput): SlidingScaleResult {
  const {
    premiumMinor,
    incurredLossMinor,
    provisionalRate,
    minRate,
    maxRate,
    slideRatePerLossRatioPoint,
    bands,
  } = input;

  if (minRate > maxRate) {
    throw new RangeError(`slidingScaleCommission minRate (${minRate}) must not exceed maxRate (${maxRate})`);
  }

  const lossRatio = premiumMinor.amount === 0 ? 0 : incurredLossMinor.amount / premiumMinor.amount;

  let effectiveRate: number;
  if (bands && bands.length > 0) {
    effectiveRate = rateFromBands(lossRatio, bands, minRate, maxRate);
  } else {
    // Linear slide: rate falls from maxRate by slideRatePerLossRatioPoint per LR-point.
    // lossRatio is a fraction; * 100 gives loss-ratio points.
    const slid = maxRate - (slideRatePerLossRatioPoint ?? 0) * (lossRatio * 100) / 100;
    effectiveRate = clampRate(slid, minRate, maxRate);
  }

  const provisionalCommission = multiply(premiumMinor, provisionalRate);
  const finalCommission = multiply(premiumMinor, effectiveRate);

  return {
    lossRatio,
    effectiveRate,
    provisionalCommission,
    finalCommission,
    adjustment: subtract(finalCommission, provisionalCommission),
  };
}

function rateFromBands(
  lossRatio: number,
  bands: SlidingScaleBand[],
  minRate: number,
  maxRate: number,
): number {
  const sorted = [...bands].sort((a, b) => a.lossRatioUpTo - b.lossRatioUpTo);
  for (const band of sorted) {
    if (lossRatio <= band.lossRatioUpTo) {
      return clampRate(band.commissionRate, minRate, maxRate);
    }
  }
  // Above every band -> the floor.
  return minRate;
}

function clampRate(rate: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, rate));
}

// ---------------------------------------------------------------------------
// Profit commission (with deficit carry-forward)
// ---------------------------------------------------------------------------

export interface ProfitCommissionInput {
  /** Premium as Money in minor units. */
  premiumMinor: Money;
  /** Incurred losses as Money in minor units. */
  lossesMinor: Money;
  /** Reinsurer's expense allowance as a fraction of premium (e.g. 0.05 = 5%). */
  expenseAllowanceRate: number;
  /** Reinsurer's profit margin as a fraction of premium (e.g. 0.10 = 10%). */
  reinsurerMarginRate: number;
  /** Profit commission rate on the net profit, as a fraction (e.g. 0.20 = 20%). */
  profitCommissionRate: number;
  /** Deficit brought forward from a prior period as Money (positive amount). */
  priorDeficitMinor?: Money;
}

export interface ProfitCommissionResult {
  /**
   * Reinsurer profit before applying the PC rate:
   *   premium − losses − expenses − reinsurer margin − prior deficit.
   * A negative value means the account is in deficit.
   */
  profitMinor: Money;
  /** Profit commission payable to the cedent (0 when profit <= 0). */
  profitCommissionMinor: Money;
  /** Deficit to carry forward to the next period as a positive Money (0 when profitable). */
  carryForwardDeficitMinor: Money;
  /** The components used, for explainability (§4.4). */
  workings: {
    expensesMinor: Money;
    reinsurerMarginMinor: Money;
    priorDeficitMinor: Money;
  };
}

/**
 * Profit commission with **deficit carry-forward**.
 *
 *   profit = premium − losses − expenses − reinsurer margin − prior deficit
 *   commission = max(0, profit) × profitCommissionRate
 *
 * Expenses and reinsurer margin are taken as fractions of premium. When profit
 * is negative the commission is zero and the absolute deficit is returned as
 * `carryForwardDeficitMinor` to be brought forward next period.
 */
export function profitCommission(input: ProfitCommissionInput): ProfitCommissionResult {
  const currency = input.premiumMinor.currency;
  const expensesMinor = multiply(input.premiumMinor, input.expenseAllowanceRate);
  const reinsurerMarginMinor = multiply(input.premiumMinor, input.reinsurerMarginRate);
  const priorDeficitMinor = input.priorDeficitMinor ?? zero(currency);

  const profitMinor = subtract(
    subtract(
      subtract(subtract(input.premiumMinor, input.lossesMinor), expensesMinor),
      reinsurerMarginMinor,
    ),
    priorDeficitMinor,
  );

  const workings = { expensesMinor, reinsurerMarginMinor, priorDeficitMinor };

  if (profitMinor.amount <= 0) {
    return {
      profitMinor,
      profitCommissionMinor: zero(currency),
      // Carry forward the absolute deficit as a positive value (|0| normalises -0 -> 0).
      carryForwardDeficitMinor: money(Math.abs(profitMinor.amount), currency),
      workings,
    };
  }

  return {
    profitMinor,
    profitCommissionMinor: multiply(profitMinor, input.profitCommissionRate),
    carryForwardDeficitMinor: zero(currency),
    workings,
  };
}

// ---------------------------------------------------------------------------
// Overriding commission & brokerage
// ---------------------------------------------------------------------------

/**
 * Overriding commission (broker/intermediary override) on the ceded premium.
 *
 * @param cededPremiumMinor ceded premium as Money in minor units
 * @param overriderRate override rate as a decimal fraction (e.g. 0.025 = 2.5%)
 */
export function overridingCommission(cededPremiumMinor: Money, overriderRate: number): Money {
  if (!Number.isFinite(overriderRate) || overriderRate < 0) {
    throw new RangeError(`overridingCommission overriderRate must be a non-negative number, got ${overriderRate}`);
  }
  return multiply(cededPremiumMinor, overriderRate);
}

/**
 * Brokerage retained by the broker, on the premium.
 *
 * @param premiumMinor premium as Money in minor units
 * @param brokerageRate brokerage rate as a decimal fraction (e.g. 0.01 = 1%)
 */
export function brokerage(premiumMinor: Money, brokerageRate: number): Money {
  if (!Number.isFinite(brokerageRate) || brokerageRate < 0) {
    throw new RangeError(`brokerage brokerageRate must be a non-negative number, got ${brokerageRate}`);
  }
  return multiply(premiumMinor, brokerageRate);
}

// ---------------------------------------------------------------------------
// Sliding scale - interpolated (vs stepped) variant
// ---------------------------------------------------------------------------

/**
 * Interpolated sliding-scale commission: the rate is linearly interpolated
 * between the band knots (each band's `lossRatioUpTo` is treated as a knot at
 * `commissionRate`), rather than stepping to a band's flat rate. Below the first
 * knot the first rate applies; above the last knot the last rate applies; the
 * result is collared to [minRate, maxRate].
 */
export function slidingScaleInterpolated(input: SlidingScaleInput): SlidingScaleResult {
  const { premiumMinor, incurredLossMinor, provisionalRate, minRate, maxRate, bands } = input;
  if (minRate > maxRate) {
    throw new RangeError(`slidingScaleInterpolated minRate (${minRate}) must not exceed maxRate (${maxRate})`);
  }
  if (!bands || bands.length === 0) {
    throw new RangeError('slidingScaleInterpolated requires at least one band knot');
  }
  const lossRatio = premiumMinor.amount === 0 ? 0 : incurredLossMinor.amount / premiumMinor.amount;
  const effectiveRate = clampRate(interpolateBands(lossRatio, bands), minRate, maxRate);
  const provisionalCommission = multiply(premiumMinor, provisionalRate);
  const finalCommission = multiply(premiumMinor, effectiveRate);
  return {
    lossRatio,
    effectiveRate,
    provisionalCommission,
    finalCommission,
    adjustment: subtract(finalCommission, provisionalCommission),
  };
}

function interpolateBands(lossRatio: number, bands: SlidingScaleBand[]): number {
  const knots = [...bands].sort((a, b) => a.lossRatioUpTo - b.lossRatioUpTo);
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (lossRatio <= first.lossRatioUpTo) return first.commissionRate;
  if (lossRatio >= last.lossRatioUpTo) return last.commissionRate;
  for (let i = 0; i < knots.length - 1; i++) {
    const lo = knots[i]!;
    const hi = knots[i + 1]!;
    if (lossRatio >= lo.lossRatioUpTo && lossRatio <= hi.lossRatioUpTo) {
      const span = hi.lossRatioUpTo - lo.lossRatioUpTo;
      const t = span === 0 ? 0 : (lossRatio - lo.lossRatioUpTo) / span;
      return lo.commissionRate + t * (hi.commissionRate - lo.commissionRate);
    }
  }
  return last.commissionRate;
}
