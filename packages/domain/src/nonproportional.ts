/**
 * Non-proportional (excess of loss) calculations — brief §7.2.
 *
 * Layer recovery against attachment/limit, multi-layer programmes, rate-on-line,
 * minimum & deposit premium, and reinstatement premium (pro-rata as to time
 * and/or amount, free reinstatements, finite reinstatement counts).
 *
 * Pure and currency-consistent. All terms are explicit and configurable (§10).
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

// ---------------------------------------------------------------------------
// Layer definition & single-loss recovery
// ---------------------------------------------------------------------------

export interface Layer {
  /** Attachment point / priority / retention: losses below this are retained by the cedent. */
  attachment: Money;
  /** Limit: the most this layer pays for a single qualifying loss/occurrence. */
  limit: Money;
  /** Optional annual aggregate deductible applied to qualifying losses before recovery. */
  aggregateDeductible?: Money;
  /**
   * Number of reinstatements available. `Infinity` for unlimited; 0 for none
   * (single shot). The total layer capacity = limit × (reinstatements + 1).
   */
  reinstatements: number;
  /**
   * Reinstatement premium terms, one entry per reinstatement. Each value is the
   * reinstatement rate as a fraction of the deposit/annual premium for 100% of
   * the limit (e.g. 1.0 = 100%, 0 = free). If fewer entries than reinstatements,
   * the last entry applies to the remainder.
   */
  reinstatementRates?: number[];
}

/** Recovery from a single layer for one loss amount (ground-up). */
export function layerRecovery(grossLoss: Money, layer: Layer): Money {
  const currency = grossLoss.currency;
  const aboveAttachment = max(zero(currency), subtract(grossLoss, layer.attachment));
  return min(aboveAttachment, layer.limit);
}

export interface ProgrammeLayer extends Layer {
  /** Layer label, e.g. "$5m xs $5m". */
  name?: string;
}

export interface ProgrammeRecovery {
  totalRecovery: Money;
  retainedByCedent: Money;
  byLayer: { layer: ProgrammeLayer; recovery: Money }[];
}

/**
 * Recovery across a stacked XL programme for a single loss. Layers are sorted by
 * attachment ascending; each pays its excess slice up to its limit.
 */
export function programmeRecovery(grossLoss: Money, layers: ProgrammeLayer[]): ProgrammeRecovery {
  const currency = grossLoss.currency;
  const sorted = [...layers].sort((a, b) => a.attachment.amount - b.attachment.amount);
  const byLayer = sorted.map((layer) => ({ layer, recovery: layerRecovery(grossLoss, layer) }));
  const totalRecovery = sum(
    byLayer.map((x) => x.recovery),
    currency,
  );
  return {
    totalRecovery,
    retainedByCedent: subtract(grossLoss, totalRecovery),
    byLayer,
  };
}

// ---------------------------------------------------------------------------
// Aggregate erosion across multiple losses in a period
// ---------------------------------------------------------------------------

export interface LayerLossApplication {
  grossLoss: Money;
  recovery: Money;
  /** Cumulative limit consumed after this loss. */
  cumulativeUsed: Money;
}

export interface LayerPeriodResult {
  applications: LayerLossApplication[];
  totalRecovered: Money;
  totalCapacity: Money;
  capacityRemaining: Money;
  /** Aggregate deductible eroded so far. */
  aadEroded: Money;
}

/**
 * Apply a sequence of losses to a single layer over a period, honouring the
 * annual aggregate deductible and the finite reinstatement capacity. Recoveries
 * stop once total capacity (limit × (reinstatements + 1)) is exhausted.
 */
export function applyLossesToLayer(grossLosses: Money[], layer: Layer): LayerPeriodResult {
  const currency = layer.limit.currency;
  const reinstatements = Number.isFinite(layer.reinstatements) ? layer.reinstatements : Infinity;
  const totalCapacity = Number.isFinite(reinstatements)
    ? multiply(layer.limit, reinstatements + 1)
    : money(Number.MAX_SAFE_INTEGER, currency);

  const aad = layer.aggregateDeductible ?? zero(currency);
  let aadRemaining = aad;
  let used = zero(currency);
  const applications: LayerLossApplication[] = [];

  for (const grossLoss of grossLosses) {
    // Each loss first erodes the per-loss excess, then the annual aggregate deductible.
    let perLoss = layerRecovery(grossLoss, layer);

    if (!isZero(aadRemaining)) {
      const absorbed = min(perLoss, aadRemaining);
      perLoss = subtract(perLoss, absorbed);
      aadRemaining = subtract(aadRemaining, absorbed);
    }

    const capacityLeft = subtract(totalCapacity, used);
    const recovery = clamp(perLoss, zero(currency), max(zero(currency), capacityLeft));
    used = add(used, recovery);
    applications.push({ grossLoss, recovery, cumulativeUsed: used });
  }

  return {
    applications,
    totalRecovered: used,
    totalCapacity,
    capacityRemaining: subtract(totalCapacity, used),
    aadEroded: subtract(aad, aadRemaining),
  };
}

// ---------------------------------------------------------------------------
// Premium: ROL, MDP, reinstatements
// ---------------------------------------------------------------------------

export interface RateOnLineResult {
  rateOnLine: number;
  layerPremium: Money;
}

/** Rate on line = premium / limit; layer premium = ROL × limit. */
export function premiumFromRateOnLine(limit: Money, rateOnLine: number): RateOnLineResult {
  return { rateOnLine, layerPremium: multiply(limit, rateOnLine) };
}

export function rateOnLine(layerPremium: Money, limit: Money): number {
  if (limit.amount === 0) throw new RangeError('Cannot compute rate on line with a zero limit');
  return layerPremium.amount / limit.amount;
}

export interface MinimumDepositPremium {
  /** Estimated premium income basis for swing/exposure rated layers. */
  estimatedPremium: Money;
  /** Deposit premium payable up front (a % of the estimated/annual premium). */
  depositPct: number;
  /** Minimum premium floor (the layer never costs less than this). */
  minimumPct: number;
}

export interface MdpResult {
  depositPremium: Money;
  minimumPremium: Money;
}

export function minimumAndDepositPremium(terms: MinimumDepositPremium): MdpResult {
  return {
    depositPremium: multiply(terms.estimatedPremium, terms.depositPct / 100),
    minimumPremium: multiply(terms.estimatedPremium, terms.minimumPct / 100),
  };
}

export interface ReinstatementPremiumInput {
  /** The layer being reinstated. */
  layer: Layer;
  /** Annual/deposit premium for 100% of the limit (the reinstatement base). */
  annualPremium: Money;
  /** Recoveries made in date order; each consumes (part of) the limit. */
  recoveries: Money[];
  /**
   * Pro-rata-as-to-time fractions for each recovery, in [0,1], representing the
   * unexpired portion of the period at the loss date. Omit (or 1) to disable
   * time apportionment. Must align by index with `recoveries`.
   */
  timeFractions?: number[];
}

export interface ReinstatementCharge {
  /** Amount of limit reinstated by this loss. */
  amountReinstated: Money;
  /** Reinstatement rate applied (fraction of annual premium per 100% limit). */
  rate: number;
  /** Pro-rata-as-to-time fraction applied. */
  timeFraction: number;
  /** Reinstatement premium charged for this loss. */
  premium: Money;
}

export interface ReinstatementResult {
  charges: ReinstatementCharge[];
  totalReinstatementPremium: Money;
  limitReinstated: Money;
}

/**
 * Reinstatement premium — pro-rata as to amount (the fraction of the limit
 * reinstated) and optionally pro-rata as to time (the unexpired period).
 *
 *   RP = annualPremium × (amountReinstated / limit) × rate × timeFraction
 *
 * Reinstatement rates are taken in order from `layer.reinstatementRates`
 * (the last rate repeats for any further reinstatements). Capacity beyond the
 * available reinstatements is not reinstated and incurs no premium.
 */
export function reinstatementPremium(input: ReinstatementPremiumInput): ReinstatementResult {
  const { layer, annualPremium, recoveries } = input;
  const currency = annualPremium.currency;
  const rates = layer.reinstatementRates ?? [];
  const maxReinstatements = Number.isFinite(layer.reinstatements) ? layer.reinstatements : Infinity;

  const charges: ReinstatementCharge[] = [];
  let limitConsumed = zero(currency);
  let reinstatementsUsedFraction = 0;

  recoveries.forEach((recovery, i) => {
    if (reinstatementsUsedFraction >= maxReinstatements) return;

    // The portion of this recovery that reinstates limit, capped by remaining reinstatement capacity.
    const remainingReinstatableLimit = Number.isFinite(maxReinstatements)
      ? max(zero(currency), subtract(multiply(layer.limit, maxReinstatements), limitConsumed))
      : recovery;
    const amountReinstated = min(recovery, remainingReinstatableLimit);
    if (isZero(amountReinstated)) return;

    const rateIndex = Math.min(Math.floor(reinstatementsUsedFraction), rates.length - 1);
    const rate = rates.length === 0 ? 1 : rates[Math.max(0, rateIndex)]!;
    const timeFraction = input.timeFractions?.[i] ?? 1;

    const amountFraction = amountReinstated.amount / layer.limit.amount;
    const premium = multiply(annualPremium, amountFraction * rate * timeFraction);

    charges.push({ amountReinstated, rate, timeFraction, premium });
    limitConsumed = add(limitConsumed, amountReinstated);
    reinstatementsUsedFraction += amountFraction;
  });

  return {
    charges,
    totalReinstatementPremium: sum(
      charges.map((c) => c.premium),
      currency,
    ),
    limitReinstated: limitConsumed,
  };
}
