/**
 * Minimum & Deposit (M&D) premium adjustment on actual GNPI - brief §7.2/§7.6,
 * industry-gap-analysis Tier-2 #7 (EPI vs booked premium tracking).
 *
 * A rated XL treaty charges a deposit premium up front (booked on binding, often
 * paid in instalments) against an Estimated Premium Income (EPI). At adjustment
 * the final premium is re-rated on the *actual* Gross Net Premium Income:
 *
 *   indicated  = premiumRatePct% x actualGNPI
 *   final      = max(minimumPremium, indicated)
 *   adjustment = final - premium already booked
 *
 * The booked figure must include any prior adjustment premiums, which makes the
 * calculation idempotent: re-running with the same GNPI yields a zero adjustment.
 *
 * Pure and deterministic (no I/O/clock/DB) per the domain-core rule; money is
 * integer minor units with a single explicit rounding when the rate is applied.
 */

import { Money, percentOf, subtract, max } from './money.js';

export interface MdPremiumAdjustmentInput {
  /** Actual GNPI (subject premium income) for the adjustment period, minor units. */
  actualGnpi: Money;
  /** Adjustable premium rate applied to GNPI, as a percentage 0-100 (e.g. 2 = 2%). */
  premiumRatePct: number;
  /** Contractual minimum premium (the floor the layer earns regardless of GNPI). */
  minimumPremium: Money;
  /**
   * Premium already booked against the contract (deposit + instalments + prior
   * adjustment premiums), signed net: DR positive / CR negative. Including prior
   * adjustments is what makes repeat runs book only the incremental difference.
   */
  bookedPremium: Money;
}

export interface MdPremiumAdjustmentResult {
  /** Rate-indicated premium = premiumRatePct% x actualGNPI (one rounding). */
  indicatedPremium: Money;
  /** Echo of the contractual minimum used. */
  minimumPremium: Money;
  /** Final earned premium = max(minimum, indicated). */
  finalPremium: Money;
  /** Echo of the premium already booked (incl. prior adjustments). */
  bookedPremium: Money;
  /**
   * final - booked. Positive = additional premium due from the cedent (book DR);
   * negative = return premium due to the cedent (book CR); zero = nothing to book.
   */
  adjustmentPremium: Money;
  /** True when the minimum premium bit (indicated < minimum). */
  minimumApplied: boolean;
}

/**
 * Compute the M&D adjustment premium on actual GNPI.
 *
 * Throws on a negative/non-finite rate, a negative minimum, or mixed currencies
 * (cross-currency adjustments must go through FX first, per the money rules).
 */
export function mdPremiumAdjustment(input: MdPremiumAdjustmentInput): MdPremiumAdjustmentResult {
  if (!Number.isFinite(input.premiumRatePct) || input.premiumRatePct < 0) {
    throw new RangeError(`premiumRatePct must be a finite number >= 0, got ${input.premiumRatePct}`);
  }
  if (input.minimumPremium.amount < 0) {
    throw new RangeError('minimumPremium must not be negative');
  }

  // percentOf/max/subtract enforce same-currency (cross-currency throws -> FX first).
  const indicatedPremium = percentOf(input.actualGnpi, input.premiumRatePct);
  const finalPremium = max(input.minimumPremium, indicatedPremium);
  const adjustmentPremium = subtract(finalPremium, input.bookedPremium);

  return {
    indicatedPremium,
    minimumPremium: input.minimumPremium,
    finalPremium,
    bookedPremium: input.bookedPremium,
    adjustmentPremium,
    minimumApplied: indicatedPremium.amount < input.minimumPremium.amount,
  };
}
