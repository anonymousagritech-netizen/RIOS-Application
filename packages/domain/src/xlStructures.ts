/**
 * Excess-of-loss (XL) structure math and reinstatement-premium calculations -
 * brief §7.2.
 *
 * This module builds on `nonproportional.ts` (which owns the canonical
 * single-loss `layerRecovery` clamp, the rate-on-line/MDP helpers and the
 * recovery-driven reinstatement engine) and adds the named XL *structures*:
 *
 *   - per-risk XL          (a working-layer recovery against one risk loss)
 *   - per-occurrence XL     (cat XL against an aggregated occurrence loss)
 *   - aggregate XL / stop loss with an annual aggregate deductible (AAD)
 *   - whole-account stop loss expressed in loss-ratio terms
 *   - a self-contained reinstatement-premium calculator (pro-rata as to
 *     amount and optionally time, free reinstatements, multiple reinstatements
 *     consumed in order as losses erode and reinstate the layer)
 *
 * All money is integer minor units (see `money.ts`); rates and loss ratios are
 * plain numbers. No floating-point money arithmetic - every monetary result is
 * produced through the explicitly-rounded `money.ts` helpers. Pure and
 * deterministic: no I/O, DB, framework or clock.
 */

import {
  Money,
  money,
  zero,
  add,
  subtract,
  multiply,
  min,
  max,
  clamp,
  sum,
  isZero,
} from './money.js';
import { layerRecovery, type Layer } from './nonproportional.js';

// ---------------------------------------------------------------------------
// 1. Per-risk XL
// ---------------------------------------------------------------------------

export interface PerRiskRecoveryInput {
  /** Ground-up loss for a single risk. */
  lossMinor: Money;
  /** Attachment / retention: losses below this are retained by the cedent. */
  attachmentMinor: Money;
  /** Layer limit: the most this layer pays for the single risk loss. */
  limitMinor: Money;
}

/**
 * Recovery to a per-risk XL layer for one risk loss:
 *
 *   recovery = clamp(loss - attachment, 0, limit)
 *
 * This is the canonical layer clamp (delegates to `layerRecovery`), expressed
 * with the per-risk vocabulary. Use when the subject is a single risk.
 */
export function perRiskRecovery(input: PerRiskRecoveryInput): Money {
  const layer: Layer = {
    attachment: input.attachmentMinor,
    limit: input.limitMinor,
    reinstatements: 0,
  };
  return layerRecovery(input.lossMinor, layer);
}

// ---------------------------------------------------------------------------
// 2. Per-occurrence (catastrophe) XL
// ---------------------------------------------------------------------------

export interface PerOccurrenceRecoveryInput {
  /**
   * The *aggregated* occurrence loss: the sum of individual risk losses
   * belonging to one event, AFTER applying the event definition / hours clause
   * upstream (e.g. all property losses within a 72-hour windstorm window). This
   * aggregation is a policy/event-grouping concern and is assumed already done.
   */
  occurrenceLossMinor: Money;
  /** Occurrence attachment / priority. */
  attachmentMinor: Money;
  /** Occurrence limit: the most the layer pays for the single occurrence. */
  limitMinor: Money;
}

/**
 * Recovery to a per-occurrence / catastrophe XL layer:
 *
 *   recovery = clamp(occurrenceLoss - attachment, 0, limit)
 *
 * Identical clamp to {@link perRiskRecovery}; the distinction is the SUBJECT.
 * `occurrenceLossMinor` must be the aggregated event loss produced by an
 * hours-clause / event definition upstream - this function does not group
 * losses into occurrences.
 */
export function perOccurrenceRecovery(input: PerOccurrenceRecoveryInput): Money {
  const layer: Layer = {
    attachment: input.attachmentMinor,
    limit: input.limitMinor,
    reinstatements: 0,
  };
  return layerRecovery(input.occurrenceLossMinor, layer);
}

// ---------------------------------------------------------------------------
// 3. Aggregate XL / stop loss with an annual aggregate deductible
// ---------------------------------------------------------------------------

export interface AggregateXlRecoveryInput {
  /** All qualifying losses in the period (already net of any per-loss terms). */
  periodLossesMinor: Money[];
  /** Annual aggregate deductible: the cedent retains this much in total first. */
  aadMinor: Money;
  /** Aggregate limit: the most the layer pays across the whole period. */
  limitMinor: Money;
}

export interface AggregateXlRecoveryResult {
  /** Sum of all period losses. */
  sumLossesMinor: Money;
  /** Aggregate recovery = clamp(sumLosses - aad, 0, limit). */
  recoveryMinor: Money;
}

/**
 * Aggregate XL / stop loss with an annual aggregate deductible (AAD):
 *
 *   sumLosses = Σ periodLosses
 *   recovery  = clamp(sumLosses - aad, 0, limit)
 *
 * The losses are aggregated for the period, the AAD is subtracted once, and the
 * excess is paid up to the aggregate limit.
 */
export function aggregateXlRecovery(input: AggregateXlRecoveryInput): AggregateXlRecoveryResult {
  const currency = input.aadMinor.currency;
  const sumLosses = sum(input.periodLossesMinor, currency);
  const aboveAad = max(zero(currency), subtract(sumLosses, input.aadMinor));
  const recovery = min(aboveAad, input.limitMinor);
  return { sumLossesMinor: sumLosses, recoveryMinor: recovery };
}

// ---------------------------------------------------------------------------
// 4. Whole-account stop loss expressed in loss-ratio terms
// ---------------------------------------------------------------------------

export interface StopLossRecoveryInput {
  /** Subject premium - the base the loss ratios are expressed against. */
  subjectPremiumMinor: Money;
  /** Incurred losses for the account in the period. */
  incurredLossesMinor: Money;
  /** Attachment loss ratio (e.g. 0.80 = 80%): cover begins above this. */
  attachmentLossRatio: number;
  /** Limit loss ratio (e.g. 1.10 = 110%): cover ends at this ratio. */
  limitLossRatio: number;
}

export interface StopLossRecoveryResult {
  /** Realised incurred loss ratio = incurredLosses / subjectPremium. */
  incurredLossRatio: number;
  /** Attachment expressed in money (attachmentLossRatio × subjectPremium). */
  attachmentMinor: Money;
  /** Cover ceiling in money (limitLossRatio × subjectPremium). */
  ceilingMinor: Money;
  /** Recovery = clamp(incurredLosses, attachment, ceiling) - attachment. */
  recoveryMinor: Money;
}

/**
 * Whole-account stop loss expressed in loss-ratio terms. The attach/limit loss
 * ratios are converted to money against the subject premium, then the standard
 * layer clamp is applied to the incurred losses:
 *
 *   attachment = attachmentLossRatio × subjectPremium
 *   ceiling    = limitLossRatio    × subjectPremium
 *   recovery   = clamp(incurredLosses, attachment, ceiling) - attachment
 *
 * Ratios are dimensionless numbers; the conversion to money uses the
 * explicitly-rounded `multiply`, so the result stays integer minor units.
 */
export function stopLossRecovery(input: StopLossRecoveryInput): StopLossRecoveryResult {
  const { subjectPremiumMinor: subjectPremium, incurredLossesMinor: incurred } = input;
  const currency = subjectPremium.currency;
  const attachment = multiply(subjectPremium, input.attachmentLossRatio);
  const ceiling = multiply(subjectPremium, input.limitLossRatio);
  const cappedIncurred = clamp(incurred, attachment, ceiling);
  const recovery = max(zero(currency), subtract(cappedIncurred, attachment));
  const incurredLossRatio =
    subjectPremium.amount === 0 ? 0 : incurred.amount / subjectPremium.amount;
  return {
    incurredLossRatio,
    attachmentMinor: attachment,
    ceilingMinor: ceiling,
    recoveryMinor: recovery,
  };
}

// ---------------------------------------------------------------------------
// 5. Reinstatement premium (self-contained, loss-driven)
// ---------------------------------------------------------------------------

export interface Reinstatement {
  /** Reinstatement rate as a fraction of the deposit premium (e.g. 1.0 = 100%). */
  rate: number;
  /** Free reinstatement: charges no premium regardless of `rate` (treated as 0). */
  free?: boolean;
  /**
   * Pro-rata as to amount: charge proportionally to the fraction of the layer
   * limit actually reinstated. Standard market practice; when false the full
   * reinstatement premium is charged for any (non-zero) reinstatement of this
   * tranche.
   */
  proRataAmount: boolean;
  /**
   * Optional pro-rata as to time: scale the premium by the unexpired fraction
   * of the period (daysRemaining / totalDays) at the date the layer reinstates.
   */
  proRataTime?: { daysRemaining: number; totalDays: number };
}

export interface ReinstatementChargeDetail {
  /** Index of the reinstatement (0-based) in the supplied order. */
  index: number;
  /** Amount of layer limit reinstated by this tranche. */
  amountReinstatedMinor: Money;
  /** Fraction of the layer limit reinstated (amountReinstated / layerLimit). */
  amountFraction: number;
  /** Effective rate applied (0 for free reinstatements). */
  rate: number;
  /** Pro-rata-as-to-time fraction applied (1 when no time apportionment). */
  timeFraction: number;
  /** Reinstatement premium charged for this tranche. */
  premiumMinor: Money;
}

export interface ReinstatementPremiumInput {
  /**
   * Total loss to the layer over the period (the cumulative recovered amount
   * that erodes the original limit and each successive reinstatement).
   */
  lossToLayerMinor: Money;
  /** The layer limit (one full reinstatement restores this much cover). */
  layerLimitMinor: Money;
  /** The deposit / annual premium that the reinstatement rate is applied to. */
  depositPremiumMinor: Money;
  /**
   * The reinstatements in order. Each restores up to one full `layerLimitMinor`
   * of cover as the loss erodes the layer. Once these are exhausted the layer is
   * exhausted and no further premium is charged.
   */
  reinstatements: Reinstatement[];
}

export interface ReinstatementPremiumResult {
  /** Total reinstatement premium across all tranches. */
  totalReinstatementPremiumMinor: Money;
  /** Per-reinstatement breakdown, in order. */
  breakdown: ReinstatementChargeDetail[];
  /**
   * Cover remaining after the loss erodes the original limit and the supplied
   * reinstatements: clamp(totalCapacity - lossToLayer, 0, totalCapacity).
   */
  remainingCoverMinor: Money;
}

/**
 * Reinstatement premium - pro-rata as to amount (and optionally time).
 *
 * As the cumulative `lossToLayer` erodes the layer, each reinstatement in turn
 * restores up to one full `layerLimit` of cover. The premium for a tranche that
 * reinstates `r` of the limit is:
 *
 *   RP = depositPremium × rate × (r / layerLimit)         [pro-rata as to amount]
 *      × (daysRemaining / totalDays)                       [optional, as to time]
 *
 * - `free` reinstatements use an effective rate of 0 (no premium).
 * - When `proRataAmount` is false, a (partial) reinstatement of this tranche is
 *   charged at the full tranche premium (rate × deposit × timeFraction).
 * - The first `layerLimit` of loss consumes the ORIGINAL cover (no premium); the
 *   next `layerLimit` is restored by reinstatement #0, the next by #1, and so on.
 * - Loss beyond the original limit + all reinstatements is uncovered (the layer
 *   is exhausted) and charges nothing.
 *
 * Money stays integer minor units; the per-tranche factor is a plain number fed
 * to the explicitly-rounded `multiply`.
 */
export function reinstatementPremium(input: ReinstatementPremiumInput): ReinstatementPremiumResult {
  const { lossToLayerMinor, layerLimitMinor, depositPremiumMinor, reinstatements } = input;
  const currency = depositPremiumMinor.currency;
  const limitAmount = layerLimitMinor.amount;

  if (limitAmount <= 0) {
    throw new RangeError('layerLimitMinor must be a positive amount');
  }

  // Loss that bites into the reinstated tranches, i.e. everything above the
  // original cover. The original limit is consumed first and carries no
  // reinstatement premium.
  let erosionAboveOriginal = max(zero(currency), subtract(lossToLayerMinor, layerLimitMinor));

  const breakdown: ReinstatementChargeDetail[] = [];

  reinstatements.forEach((ri, index) => {
    // How much of THIS reinstatement's limit is actually reinstated by the loss.
    const amountReinstated = min(erosionAboveOriginal, layerLimitMinor);
    if (isZero(amountReinstated)) {
      // No (more) loss reaches this tranche; nothing reinstated, nothing charged.
      return;
    }

    const amountFraction = amountReinstated.amount / limitAmount;
    const effectiveRate = ri.free ? 0 : ri.rate;

    let timeFraction = 1;
    if (ri.proRataTime) {
      const { daysRemaining, totalDays } = ri.proRataTime;
      if (totalDays <= 0) throw new RangeError('proRataTime.totalDays must be positive');
      timeFraction = daysRemaining / totalDays;
    }

    // Pro-rata as to amount uses the reinstated fraction; otherwise charge the
    // full tranche premium for any non-zero reinstatement.
    const amountFactor = ri.proRataAmount ? amountFraction : 1;
    const premium = multiply(depositPremiumMinor, effectiveRate * amountFactor * timeFraction);

    breakdown.push({
      index,
      amountReinstatedMinor: amountReinstated,
      amountFraction,
      rate: effectiveRate,
      timeFraction,
      premiumMinor: premium,
    });

    // Consume this tranche's share of the loss.
    erosionAboveOriginal = subtract(erosionAboveOriginal, amountReinstated);
  });

  const totalCapacity = layerReinstatementCapacity({
    layerLimitMinor,
    numReinstatements: reinstatements.length,
  });
  const remainingCover = clamp(
    subtract(totalCapacity, lossToLayerMinor),
    zero(currency),
    totalCapacity,
  );

  return {
    totalReinstatementPremiumMinor: sum(
      breakdown.map((b) => b.premiumMinor),
      currency,
    ),
    breakdown,
    remainingCoverMinor: remainingCover,
  };
}

// ---------------------------------------------------------------------------
// 6. Aggregate cover helper
// ---------------------------------------------------------------------------

export interface LayerReinstatementCapacityInput {
  /** The layer limit (one occurrence's worth of cover). */
  layerLimitMinor: Money;
  /** Number of reinstatements purchased (0 = single shot). */
  numReinstatements: number;
}

/**
 * Total aggregate cover of a layer with reinstatements:
 *
 *   totalCapacity = layerLimit × (numReinstatements + 1)
 *
 * The "+1" is the original limit; each reinstatement adds one more full limit.
 */
export function layerReinstatementCapacity(input: LayerReinstatementCapacityInput): Money {
  if (input.numReinstatements < 0 || !Number.isInteger(input.numReinstatements)) {
    throw new RangeError('numReinstatements must be a non-negative integer');
  }
  return multiply(input.layerLimitMinor, input.numReinstatements + 1);
}
