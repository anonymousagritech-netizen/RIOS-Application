/**
 * SOA (statement of account) verification - industry-gap-analysis §2.2 item 8.
 *
 * A cedent's statement of account carries figures (ceding commission,
 * overriding commission, brokerage, reinstatement premium) that the reinsurer
 * must be able to recompute from the contract's typed terms. This module holds
 * the pure comparison layer of that verification engine:
 *
 *   - `expectedCedingCommission`: the terms-derived expectation - a flat rate,
 *     optionally collared to [min, max], or a sliding scale when loss-ratio
 *     bands are supplied (delegating to `commission.ts`; no formula is
 *     re-implemented here).
 *   - `compareSoaItems`: expected-vs-actual comparison of integer minor-unit
 *     figures with a percentage tolerance, yielding per-item deviations and an
 *     overall verdict.
 *
 * Money is integer minor units throughout (brief §16.1 / §20); rates arriving
 * from the term set are **percentages 0-100** (matching the server's typed
 * `termsSchema`), converted once at this boundary. Like the rest of the domain
 * core this file is dependency-free and clock-free (brief §4.4).
 */

import { Money, subtract, zero } from './money.js';
import { flatCedingCommission, slidingScaleCommission, type SlidingScaleBand } from './commission.js';

// ---------------------------------------------------------------------------
// Expected ceding commission from typed terms
// ---------------------------------------------------------------------------

/**
 * Commission terms as they appear on the contract's typed term set. All rates
 * are percentages 0-100 (`cedingCommissionPct`, `commissionMinPct`,
 * `commissionMaxPct` in the server's termsSchema); `bands` are the sliding-scale
 * loss-ratio bands with rates as decimal fractions (the `commission.ts`
 * convention).
 */
export interface ExpectedCommissionTerms {
  /** Flat / provisional ceding commission rate, percent 0-100. */
  provisionalRatePct?: number;
  /** Commission floor, percent 0-100 (termsSchema commissionMinPct). */
  minRatePct?: number;
  /** Commission ceiling, percent 0-100 (termsSchema commissionMaxPct). */
  maxRatePct?: number;
  /** Optional sliding-scale loss-ratio bands (rates as fractions in [0,1]). */
  bands?: SlidingScaleBand[];
}

/**
 * Recompute the ceding commission a statement should carry, from the typed
 * terms and the premium the statement itself reports.
 *
 *  - With `bands`: a sliding scale on the actual loss ratio
 *    (`incurredLoss / premium`), via `slidingScaleCommission`.
 *  - Without `bands`: a flat commission at `provisionalRatePct`, collared to
 *    [`minRatePct`, `maxRatePct`] when either bound is present, via
 *    `flatCedingCommission` (the percent is converted to parts-per-million and
 *    rounded once, so e.g. 27.5% -> 275_000 ppm exactly).
 *
 * @param premium subject premium on the statement, Money in minor units
 * @param terms commission terms (percent 0-100; see ExpectedCommissionTerms)
 * @param incurredLoss incurred losses on the statement (sliding scale only)
 */
export function expectedCedingCommission(
  premium: Money,
  terms: ExpectedCommissionTerms,
  incurredLoss?: Money,
): Money {
  const { provisionalRatePct, minRatePct, maxRatePct, bands } = terms;
  for (const [name, pct] of [
    ['provisionalRatePct', provisionalRatePct],
    ['minRatePct', minRatePct],
    ['maxRatePct', maxRatePct],
  ] as const) {
    if (pct !== undefined && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      throw new RangeError(`expectedCedingCommission ${name} must be a percentage in [0,100], got ${pct}`);
    }
  }
  if (minRatePct !== undefined && maxRatePct !== undefined && minRatePct > maxRatePct) {
    throw new RangeError(
      `expectedCedingCommission minRatePct (${minRatePct}) must not exceed maxRatePct (${maxRatePct})`,
    );
  }

  if (bands && bands.length > 0) {
    return slidingScaleCommission({
      premiumMinor: premium,
      incurredLossMinor: incurredLoss ?? zero(premium.currency),
      provisionalRate: (provisionalRatePct ?? 0) / 100,
      minRate: (minRatePct ?? 0) / 100,
      maxRate: (maxRatePct ?? 100) / 100,
      bands,
    }).finalCommission;
  }

  // Flat rate collared to [min, max] (either bound may be absent).
  let ratePct = provisionalRatePct ?? 0;
  if (minRatePct !== undefined) ratePct = Math.max(ratePct, minRatePct);
  if (maxRatePct !== undefined) ratePct = Math.min(ratePct, maxRatePct);
  return flatCedingCommission(premium, Math.round(ratePct * 10_000));
}

// ---------------------------------------------------------------------------
// Expected-vs-actual comparison with tolerance
// ---------------------------------------------------------------------------

/** One verifiable statement figure: what the terms say vs what the cedent reported. */
export interface SoaItemComparison {
  /** Stable key for the figure, e.g. 'CEDING_COMMISSION', 'REINSTATEMENT_PREMIUM'. */
  itemKey: string;
  /** Terms-recomputed expectation, Money in minor units. */
  expected: Money;
  /** Figure the cedent's statement actually carries, Money in minor units. */
  actual: Money;
  /** Optional explainability note carried through to the result. */
  note?: string;
}

export interface SoaVerifiedItem extends SoaItemComparison {
  /** actual − expected (positive: the statement carries more than the terms imply). */
  deviation: Money;
  withinTolerance: boolean;
}

export interface SoaVerificationResult {
  tolerancePct: number;
  items: SoaVerifiedItem[];
  /** True iff every compared item is within tolerance. */
  allWithinTolerance: boolean;
}

/**
 * Compare cedent-reported statement figures against terms-recomputed
 * expectations, in integer minor units.
 *
 * Tolerance rule: an item is within tolerance when
 * `|actual − expected| <= |expected| × tolerancePct / 100`. A zero expectation
 * is within tolerance only when the actual is also zero (a percentage of zero
 * tolerates nothing). Currencies must match per item (`subtract` throws
 * otherwise - cross-currency comparison must go through FX first).
 */
export function compareSoaItems(items: SoaItemComparison[], tolerancePct: number): SoaVerificationResult {
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0) {
    throw new RangeError(`compareSoaItems tolerancePct must be a non-negative number, got ${tolerancePct}`);
  }

  const verified: SoaVerifiedItem[] = items.map((item) => {
    const deviation = subtract(item.actual, item.expected);
    const withinTolerance =
      item.expected.amount === 0
        ? item.actual.amount === 0
        : Math.abs(deviation.amount) <= Math.abs(item.expected.amount) * (tolerancePct / 100);
    return { ...item, deviation, withinTolerance };
  });

  return {
    tolerancePct,
    items: verified,
    allWithinTolerance: verified.every((i) => i.withinTolerance),
  };
}
