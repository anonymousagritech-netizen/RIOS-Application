/**
 * Reinsurance rating / pricing calculations - brief §7.2 (technical pricing).
 *
 * Pure, deterministic pricing primitives used to derive a technical price for a
 * layer or treaty:
 *
 *   - burning-cost (experience) rating: trend + develop historical losses and
 *     divide by exposure to get a loss rate, then load for expenses/profit;
 *   - exposure rating: apply a configurable first-loss-scale / exposure curve to
 *     allocate the subject premium loss cost to a layer;
 *   - increased limit factors (ILFs): scale a premium from a basis limit to a
 *     target limit using a configurable ILF curve;
 *   - rate-on-line <-> premium conversions;
 *   - minimum & deposit premium (MDP);
 *   - catastrophe load from a modeled AAL/expected layer loss.
 *
 * Conventions (see CLAUDE.md / ADR 0003):
 *   - Money is an integer count of minor units (`Money`); never float money.
 *   - Rates, factors, ratios and curve values are plain `number`s (dimensionless).
 *   - No I/O, no clock, no randomness - the domain core stays unit-testable.
 *
 * Curves (exposure curves, ILF curves) are passed in as data so they can be held
 * in reference/configuration and changed without a deployment (ADR 0004); this
 * module only knows how to interpolate and apply them.
 */

import { Money, money, multiply, isZero } from './money.js';

// ---------------------------------------------------------------------------
// 1. Burning-cost (experience) rating
// ---------------------------------------------------------------------------

export interface BurningCostInput {
  /** Historical incurred losses to the layer/treaty, one Money per period (minor units). */
  historicalLossesMinor: Money[];
  /**
   * Exposure base per period, used as the denominator of the burning cost rate.
   * Supply EITHER the historical premium per period OR the subject premium per
   * period (whichever is the rating exposure). Aligns by index with losses.
   */
  historicalPremiumMinor?: Money[];
  /** Alias for the exposure base when the denominator is subject premium. */
  subjectPremiumMinor?: Money[];
  /** Multiplicative trend factor applied to losses (e.g. 1.05 for 5% inflation). Default 1. */
  trendFactor?: number;
  /** Multiplicative loss-development factor (IBNR / development to ultimate). Default 1. */
  developmentFactor?: number;
  /**
   * Loading factor applied to the pure burning cost to cover expenses, risk margin
   * and profit. Expressed as a multiplier on the rate (e.g. 1.25 loads 25%). Default 1.
   */
  loadingFactor?: number;
}

export interface BurningCostResult {
  /**
   * Pure burning-cost rate = trended+developed losses / total exposure premium.
   * Dimensionless (loss minor units / premium minor units).
   */
  pureRate: number;
  /** Loaded rate = pureRate × loadingFactor (the technical rate to charge). */
  loadedRate: number;
  /** Total trended + developed losses across the experience period. */
  trendedDevelopedLossesMinor: Money;
  /** Total exposure (premium) used as the denominator. */
  totalExposureMinor: Money;
}

/**
 * Experience rating via burning cost.
 *
 *   trendedDeveloped = Σ losses × trendFactor × developmentFactor
 *   pureRate         = trendedDeveloped / Σ exposurePremium
 *   loadedRate       = pureRate × loadingFactor
 *
 * The losses are summed as Money (integer minor units) after applying the
 * trend/development multipliers through `multiply` (single explicit rounding per
 * period); only the final division to a rate uses floating arithmetic, and only
 * on the integer minor-unit totals.
 *
 * If total exposure is zero the rate is 0 (no exposure ⇒ no chargeable rate),
 * rather than dividing by zero.
 */
export function burningCostRate(input: BurningCostInput): BurningCostResult {
  const exposureSeries = input.historicalPremiumMinor ?? input.subjectPremiumMinor;
  if (!exposureSeries || exposureSeries.length === 0) {
    throw new RangeError('burningCostRate requires historicalPremiumMinor or subjectPremiumMinor');
  }
  if (input.historicalLossesMinor.length === 0) {
    throw new RangeError('burningCostRate requires at least one historical loss period');
  }

  const trend = input.trendFactor ?? 1;
  const development = input.developmentFactor ?? 1;
  const loading = input.loadingFactor ?? 1;
  const factor = trend * development;
  const currency = input.historicalLossesMinor[0]!.currency;

  // Trend + develop each period's loss as Money, then total.
  let trendedDeveloped = 0;
  for (const loss of input.historicalLossesMinor) {
    trendedDeveloped += multiply(loss, factor).amount;
  }
  const trendedDevelopedLossesMinor = money(trendedDeveloped, currency);

  let totalExposure = 0;
  for (const prem of exposureSeries) {
    totalExposure += prem.amount;
  }
  const totalExposureMinor = money(totalExposure, exposureSeries[0]!.currency);

  const pureRate = totalExposure === 0 ? 0 : trendedDeveloped / totalExposure;
  const loadedRate = pureRate * loading;

  return { pureRate, loadedRate, trendedDevelopedLossesMinor, totalExposureMinor };
}

// ---------------------------------------------------------------------------
// 2. Exposure rating (first-loss-scale / exposure curve)
// ---------------------------------------------------------------------------

/**
 * One point on an exposure curve (a.k.a. first-loss scale, Riebesell/Bernegger
 * style table). `ratio` is loss / underlying limit (in [0,1] for a single
 * underlying policy); `G` is the fraction of the ground-up loss cost that falls
 * at or below that ratio (G is non-decreasing, G(0)=0, G(1)=1).
 */
export interface ExposureCurvePoint {
  /** Loss-to-limit ratio (exhaustion point), typically in [0,1]. */
  ratio: number;
  /** Cumulative fraction of loss cost in [0, ratio]; non-decreasing, in [0,1]. */
  G: number;
}

export interface ExposureRateInput {
  /** Subject premium for the underlying business (loss cost basis), minor units. */
  subjectPremiumMinor: Money;
  /** Exposure curve points; sorted internally by ratio ascending. */
  exposureCurve: ExposureCurvePoint[];
  /** Layer attachment as a Money amount (in the same exposure basis as the limit). */
  layerAttachmentMinor: Money;
  /** Layer limit (width) as a Money amount. */
  layerLimitMinor: Money;
  /**
   * The underlying exposure size (e.g. policy limit / sum insured) that the
   * attachment and top are expressed against, as minor units. The ratios are
   * computed as attachment/exposure and (attachment+limit)/exposure.
   */
  underlyingExposureMinor: Money;
}

export interface ExposureRateResult {
  /** G evaluated at the layer's exit ratio (top of layer / underlying exposure). */
  gTop: number;
  /** G evaluated at the layer's entry ratio (attachment / underlying exposure). */
  gAttach: number;
  /** Fraction of the subject premium's loss cost allocated to the layer = G(top) − G(attach). */
  layerFraction: number;
  /** Loss cost allocated to the layer = subjectPremium × (G(top) − G(attach)). */
  layerLossCostMinor: Money;
}

/**
 * Linearly interpolate an exposure curve G(x) for an exhaustion ratio `x`.
 * Below the first point's ratio, G is held at the first point's G (clamped);
 * above the last point's ratio, G is held at the last point's G. Between points
 * the value is linearly interpolated.
 */
export function interpolateExposureCurve(curve: ExposureCurvePoint[], x: number): number {
  if (curve.length === 0) throw new RangeError('exposure curve must have at least one point');
  const pts = [...curve].sort((a, b) => a.ratio - b.ratio);

  if (x <= pts[0]!.ratio) return pts[0]!.G;
  const last = pts[pts.length - 1]!;
  if (x >= last.ratio) return last.G;

  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i]!;
    const hi = pts[i + 1]!;
    if (x >= lo.ratio && x <= hi.ratio) {
      const span = hi.ratio - lo.ratio;
      const t = span === 0 ? 0 : (x - lo.ratio) / span;
      return lo.G + t * (hi.G - lo.G);
    }
  }
  return last.G;
}

/**
 * Exposure rating for a layer using an exposure curve.
 *
 *   attachRatio = attachment / underlyingExposure
 *   topRatio    = (attachment + limit) / underlyingExposure
 *   layerFraction = G(topRatio) − G(attachRatio)
 *   layerLossCost = subjectPremium × layerFraction
 *
 * The exposure curve G gives the share of total loss cost consumed up to a given
 * exhaustion ratio, so the difference across the layer's entry/exit ratios is the
 * share of the subject premium's loss cost that the layer is exposed to.
 *
 * If the underlying exposure is zero, the layer fraction is 0 (nothing to expose).
 */
export function exposureRate(input: ExposureRateInput): ExposureRateResult {
  const currency = input.subjectPremiumMinor.currency;
  const exposure = input.underlyingExposureMinor.amount;

  if (exposure === 0) {
    return {
      gTop: 0,
      gAttach: 0,
      layerFraction: 0,
      layerLossCostMinor: money(0, currency),
    };
  }

  const attachRatio = input.layerAttachmentMinor.amount / exposure;
  const topRatio = (input.layerAttachmentMinor.amount + input.layerLimitMinor.amount) / exposure;

  const gAttach = interpolateExposureCurve(input.exposureCurve, attachRatio);
  const gTop = interpolateExposureCurve(input.exposureCurve, topRatio);
  const layerFraction = Math.max(0, gTop - gAttach);

  return {
    gTop,
    gAttach,
    layerFraction,
    layerLossCostMinor: multiply(input.subjectPremiumMinor, layerFraction),
  };
}

// ---------------------------------------------------------------------------
// 3. Increased Limit Factors (ILF)
// ---------------------------------------------------------------------------

/**
 * One point on an ILF curve: the cumulative factor (relative to some base of 1.0
 * at the curve's reference limit) for a given limit. Factors are non-decreasing
 * in limit.
 */
export interface IlfCurvePoint {
  /** Policy limit (in major or minor units consistently across the curve). */
  limit: number;
  /** Increased limit factor at this limit (dimensionless). */
  factor: number;
}

/**
 * Interpolate an ILF for a given limit. Below the first point the first factor
 * is held (clamped); above the last point the last factor is held; between points
 * the factor is linearly interpolated.
 */
export function ilf(limit: number, ilfCurve: IlfCurvePoint[]): number {
  if (ilfCurve.length === 0) throw new RangeError('ILF curve must have at least one point');
  const pts = [...ilfCurve].sort((a, b) => a.limit - b.limit);

  if (limit <= pts[0]!.limit) return pts[0]!.factor;
  const last = pts[pts.length - 1]!;
  if (limit >= last.limit) return last.factor;

  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i]!;
    const hi = pts[i + 1]!;
    if (limit >= lo.limit && limit <= hi.limit) {
      const span = hi.limit - lo.limit;
      const t = span === 0 ? 0 : (limit - lo.limit) / span;
      return lo.factor + t * (hi.factor - lo.factor);
    }
  }
  return last.factor;
}

/**
 * Scale a premium from a basis limit to a target limit using an ILF curve.
 *
 *   premiumAtLimit = basisPremium × ILF(limit) / ILF(basisLimit)
 *
 * The ratio of ILFs converts the price known at the basis limit to the target
 * limit. If ILF(basisLimit) is 0 this throws (an undefined ILF basis).
 */
export function premiumAtLimit(
  basisPremiumMinor: Money,
  limit: number,
  basisLimit: number,
  ilfCurve: IlfCurvePoint[],
): Money {
  const ilfTarget = ilf(limit, ilfCurve);
  const ilfBasis = ilf(basisLimit, ilfCurve);
  if (ilfBasis === 0) throw new RangeError('ILF at basis limit is zero; cannot scale premium');
  return multiply(basisPremiumMinor, ilfTarget / ilfBasis);
}

// ---------------------------------------------------------------------------
// 4. Rate on line <-> premium
// ---------------------------------------------------------------------------

/**
 * Rate on line = layer premium / layer limit (a fraction, e.g. 0.10 = 10% ROL).
 * Throws if the limit is zero (rate on line is undefined for a zero-width layer).
 */
export function rateOnLine(layerPremiumMinor: Money, layerLimitMinor: Money): number {
  if (layerLimitMinor.amount === 0) {
    throw new RangeError('Cannot compute rate on line with a zero limit');
  }
  return layerPremiumMinor.amount / layerLimitMinor.amount;
}

/**
 * Inverse of {@link rateOnLine}: layer premium = ROL × limit, rounded once to
 * integer minor units.
 */
export function premiumFromRol(rolFraction: number, layerLimitMinor: Money): Money {
  return multiply(layerLimitMinor, rolFraction);
}

// ---------------------------------------------------------------------------
// 5. Minimum & Deposit Premium (MDP)
// ---------------------------------------------------------------------------

export interface MinimumAndDepositInput {
  /** Estimated (annual / EPI) premium for the layer, minor units. */
  estimatedPremiumMinor: Money;
  /** MDP rate as a fraction of the estimated premium, typically 0.8..0.9. */
  mdpRate: number;
}

export interface MinimumAndDepositResult {
  /** Deposit premium payable up front = estimatedPremium × mdpRate. */
  depositPremiumMinor: Money;
  /** The same amount is the contractual minimum the layer can earn. */
  minimumPremiumMinor: Money;
  /** Echo of the rate applied. */
  mdpRate: number;
}

/**
 * Minimum & Deposit Premium.
 *
 *   MDP = estimatedPremium × mdpRate
 *
 * The deposit is paid at inception and is also the floor: the layer never earns
 * less than the MDP regardless of the final adjusted premium. The deposit and the
 * minimum are the same amount here (a single MDP figure), returned under both
 * names for clarity at the call site.
 */
export function minimumAndDepositPremium(input: MinimumAndDepositInput): MinimumAndDepositResult {
  const mdp = multiply(input.estimatedPremiumMinor, input.mdpRate);
  return {
    depositPremiumMinor: mdp,
    minimumPremiumMinor: mdp,
    mdpRate: input.mdpRate,
  };
}

// ---------------------------------------------------------------------------
// 6. Catastrophe load from a modeled layer loss
// ---------------------------------------------------------------------------

export interface CatLoadInput {
  /**
   * Average Annual Loss (AAL) / modeled expected annual loss to the whole account
   * or portfolio, minor units. Provided for context/reference; the load is driven
   * by the modeled loss to THIS layer (`modeledLayerLossMinor`).
   */
  aalMinor: Money;
  /** Layer attachment, minor units. */
  layerAttachmentMinor: Money;
  /** Layer limit (width), minor units. */
  layerLimitMinor: Money;
  /**
   * Modeled expected annual loss to THIS layer (the AAL allocated to the layer by
   * the cat model), minor units. This is the catastrophe loss cost for the layer.
   */
  modeledLayerLossMinor: Money;
}

export interface CatLoadResult {
  /** Catastrophe loss cost for the layer (the modeled expected layer loss), minor units. */
  catLoadMinor: Money;
  /**
   * Catastrophe load expressed as a rate on line = modeledLayerLoss / limit.
   * 0 if the limit is zero (no exposure to express a rate against).
   */
  catLoadRateOnLine: number;
  /**
   * The modeled layer loss as a fraction of the portfolio AAL (the share of the
   * total modeled cat load attributable to this layer). 0 if AAL is zero.
   */
  shareOfAal: number;
}

/**
 * Catastrophe load for a layer from a modeled expected loss.
 *
 *   catLoad        = modeledLayerLoss                       (Money, minor units)
 *   catLoadRateOL  = modeledLayerLoss / limit               (rate on line)
 *   shareOfAal     = modeledLayerLoss / AAL                 (diagnostic share)
 *
 * Even without a live catastrophe model wired in, the arithmetic of applying a
 * modeled AAL / expected layer loss to a layer (turning it into a chargeable rate
 * and amount) lives here so technical pricing can incorporate cat loads
 * deterministically. The modeled layer loss is supplied by the (external) model;
 * this function only expresses it as a load.
 */
export function catLoadFromModel(input: CatLoadInput): CatLoadResult {
  const catLoadMinor = input.modeledLayerLossMinor;
  const limit = input.layerLimitMinor.amount;
  const aal = input.aalMinor.amount;

  return {
    catLoadMinor,
    catLoadRateOnLine: limit === 0 ? 0 : catLoadMinor.amount / limit,
    shareOfAal: isZero(input.aalMinor) || aal === 0 ? 0 : catLoadMinor.amount / aal,
  };
}

// ---------------------------------------------------------------------------
// Swing (retrospectively) rated premium - brief §7.8, §29.5
// ---------------------------------------------------------------------------

export interface SwingRatedPremiumInput {
  /** Subject (GNPI) premium the rate is applied to. */
  subjectPremium: Money;
  /** Provisional (deposit) rate on subject premium, as a percentage (e.g. 10 = 10%). */
  provisionalRatePct: number;
  /** Incurred losses to the layer used to retro-rate the final premium. */
  incurredLosses: Money;
  /** Loss conversion factor / loading (e.g. 1.25 = 100/80) applied to the burn. */
  lossConversionFactor: number;
  /** Minimum and maximum rate on subject premium, as percentages. */
  minRatePct: number;
  maxRatePct: number;
}

export interface SwingRatedPremiumResult {
  provisionalPremium: Money;
  /** Loaded burn rate = losses / subject x LCF, as a percentage (before the min/max collar). */
  burnRatePct: number;
  /** Final rate on subject premium after applying the [min, max] collar. */
  adjustedRatePct: number;
  adjustedPremium: Money;
  /** Adjusted - provisional: positive = additional premium due, negative = return premium. */
  adjustmentPremium: Money;
  collared: boolean;
}

/**
 * Swing-rated (retrospectively-rated) premium: a provisional/deposit premium is
 * booked up front and the final premium is set from actual losses -
 *   rate = (incurred losses / subject premium) x loss-conversion-factor,
 * collared to [minRate, maxRate]. The difference to the provisional premium is
 * the additional or return premium.
 */
export function swingRatedPremium(input: SwingRatedPremiumInput): SwingRatedPremiumResult {
  if (input.minRatePct > input.maxRatePct) {
    throw new RangeError(`minRatePct (${input.minRatePct}) must not exceed maxRatePct (${input.maxRatePct})`);
  }
  const subject = input.subjectPremium.amount;
  const provisionalPremium = multiply(input.subjectPremium, input.provisionalRatePct / 100);
  const burnRatePct = subject === 0 ? 0 : (input.incurredLosses.amount / subject) * input.lossConversionFactor * 100;
  const adjustedRatePct = Math.min(input.maxRatePct, Math.max(input.minRatePct, burnRatePct));
  const adjustedPremium = multiply(input.subjectPremium, adjustedRatePct / 100);
  return {
    provisionalPremium,
    burnRatePct: Math.round(burnRatePct * 1000) / 1000,
    adjustedRatePct: Math.round(adjustedRatePct * 1000) / 1000,
    adjustedPremium,
    adjustmentPremium: money(adjustedPremium.amount - provisionalPremium.amount, input.subjectPremium.currency),
    collared: burnRatePct < input.minRatePct || burnRatePct > input.maxRatePct,
  };
}
