/**
 * Pricing & rating (brief §7.8, §29.5).
 *
 * Burning-cost / experience rating and exposure rating for non-proportional
 * business, plus rate-on-line capacity checks. Pure and reproducible: a pricing
 * run is fully determined by its inputs (brief §29.5 acceptance criterion).
 */

import { Money, money, multiply, sum, zero, percentOf, toMajor, fromMajor } from './money.js';
import { layerRecovery, type Layer } from './nonproportional.js';

// ---------------------------------------------------------------------------
// Experience / burning-cost rating
// ---------------------------------------------------------------------------

export interface ExperienceYear {
  year: number;
  /** Subject premium (the cedent's premium the layer sits on) for the year. */
  subjectPremium: Money;
  /** Ground-up losses for the year (already trended/developed by the caller). */
  losses: Money[];
}

export interface BurningCostInput {
  years: ExperienceYear[];
  layer: Layer;
  /** Loading factor applied to the pure burning cost for expenses/profit (e.g. 1.25 = 100/80). */
  loadingFactor: number;
  /** Optional minimum rate on line floor. */
  minRateOnLine?: number;
}

export interface BurningCostResult {
  /** Total losses to the layer across the experience period. */
  totalLayerLosses: Money;
  /** Total subject premium across the period. */
  totalSubjectPremium: Money;
  /** Pure burning cost = layer losses / subject premium. */
  pureBurningCost: number;
  /** Loaded burning cost = pure × loadingFactor. */
  loadedBurningCost: number;
  /** Technical premium = loaded burning cost × current subject premium. */
  technicalPremium: Money;
  /** Implied rate on line = technical premium / limit. */
  rateOnLine: number;
  perYear: { year: number; layerLosses: Money; subjectPremium: Money; lossCost: number }[];
}

/**
 * Burning-cost (experience) rating: project the layer's technical premium from
 * historical experience. `currentSubjectPremium` is the premium the rate is
 * applied to for the prospective period.
 */
export function burningCost(input: BurningCostInput, currentSubjectPremium: Money): BurningCostResult {
  const ccy = currentSubjectPremium.currency;
  const perYear = input.years.map((y) => {
    const layerLosses = sum(
      y.losses.map((l) => layerRecovery(l, input.layer)),
      ccy,
    );
    return {
      year: y.year,
      layerLosses,
      subjectPremium: y.subjectPremium,
      lossCost: y.subjectPremium.amount > 0 ? layerLosses.amount / y.subjectPremium.amount : 0,
    };
  });

  const totalLayerLosses = sum(perYear.map((p) => p.layerLosses), ccy);
  const totalSubjectPremium = sum(input.years.map((y) => y.subjectPremium), ccy);
  const pureBurningCost = totalSubjectPremium.amount > 0 ? totalLayerLosses.amount / totalSubjectPremium.amount : 0;
  const loadedBurningCost = pureBurningCost * input.loadingFactor;

  let technicalPremium = multiply(currentSubjectPremium, loadedBurningCost);
  let rol = input.layer.limit.amount > 0 ? technicalPremium.amount / input.layer.limit.amount : 0;
  if (input.minRateOnLine !== undefined && rol < input.minRateOnLine) {
    rol = input.minRateOnLine;
    technicalPremium = multiply(input.layer.limit, input.minRateOnLine);
  }

  return {
    totalLayerLosses,
    totalSubjectPremium,
    pureBurningCost,
    loadedBurningCost,
    technicalPremium,
    rateOnLine: rol,
    perYear,
  };
}

// ---------------------------------------------------------------------------
// Exposure rating (first-loss / exposure curve)
// ---------------------------------------------------------------------------

export interface ExposureBand {
  /** Sum insured / TIV band upper bound (major units). */
  bandLimit: number;
  /** Premium volume in this band. */
  premium: Money;
  /** Expected loss ratio for the band. */
  lossRatio: number;
}

/**
 * Exposure rating with an exposure (first-loss-scale) curve. `curve(x)` returns
 * the proportion of a total loss expected at retained fraction x∈[0,1] of the
 * sum insured (a Riebesell/MBBEFD-style ILF in [0,1]). The layer's expected
 * loss cost is the difference of the curve at the exit and entry points,
 * weighted by each band's expected losses.
 */
export function exposureRate(
  bands: ExposureBand[],
  layer: Layer,
  curve: (retainedFraction: number) => number,
): { expectedLoss: Money; technicalPremium: Money; rateOnLine: number; loadingFactor: number } {
  const ccy = layer.limit.currency;
  const attach = toMajor(layer.attachment);
  const limit = toMajor(layer.limit);

  let expectedLoss = zero(ccy);
  for (const band of bands) {
    if (band.bandLimit <= 0) continue;
    const exit = Math.min(1, (attach + limit) / band.bandLimit);
    const entry = Math.min(1, attach / band.bandLimit);
    const exposed = Math.max(0, curve(exit) - curve(entry));
    const bandExpectedLosses = percentOf(band.premium, band.lossRatio * 100);
    expectedLoss = money(expectedLoss.amount + Math.round(bandExpectedLosses.amount * exposed), ccy);
  }

  const loadingFactor = 1; // exposure expected loss is already a pure cost; caller may load
  const technicalPremium = expectedLoss;
  const rol = layer.limit.amount > 0 ? technicalPremium.amount / layer.limit.amount : 0;
  return { expectedLoss, technicalPremium, rateOnLine: rol, loadingFactor };
}

// ---------------------------------------------------------------------------
// Capacity / authority check
// ---------------------------------------------------------------------------

export interface AuthorityCheck {
  /** Line size the underwriter wants to write (major units of exposure). */
  requestedLine: number;
  /** The underwriter's per-risk authority limit. */
  authorityLimit: number;
  /** Remaining aggregate capacity in the relevant zone/peril. */
  remainingCapacity: number;
}

export interface AuthorityResult {
  withinAuthority: boolean;
  withinCapacity: boolean;
  /** True when the line can be bound without escalation. */
  allowed: boolean;
  breaches: string[];
}

export function checkAuthority(c: AuthorityCheck): AuthorityResult {
  const breaches: string[] = [];
  const withinAuthority = c.requestedLine <= c.authorityLimit;
  const withinCapacity = c.requestedLine <= c.remainingCapacity;
  if (!withinAuthority) breaches.push(`Requested line ${c.requestedLine} exceeds authority ${c.authorityLimit}`);
  if (!withinCapacity) breaches.push(`Requested line ${c.requestedLine} exceeds remaining capacity ${c.remainingCapacity}`);
  return { withinAuthority, withinCapacity, allowed: withinAuthority && withinCapacity, breaches };
}

/**
 * A simple first-loss-scale (exposure) curve usable with exposureRate():
 * G(x) = x^(1/alpha) on [0,1]. alpha=1 is linear; alpha>1 is concave (severity
 * concentrated in lower layers, so upper layers attract proportionally less
 * expected loss). Illustrative - a production build would calibrate MBBEFD /
 * Riebesell curves per line of business.
 */
export function paretoCurve(alpha: number): (x: number) => number {
  if (!(alpha > 0)) throw new RangeError('alpha must be positive');
  return (x: number) => {
    const c = Math.max(0, Math.min(1, x));
    return Math.pow(c, 1 / alpha);
  };
}
