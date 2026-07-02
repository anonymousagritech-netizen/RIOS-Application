/**
 * NAIC Schedule F - provision for reinsurance (pure engine).
 *
 * Schedule F is the US statutory ceded-reinsurance schedule: recoverables by
 * counterparty, with a statutory *provision for reinsurance* driven by the
 * counterparty's security - unauthorized/uncollateralized reinsurers and
 * overdue balances attract a provision that reduces the credit the cedent may
 * take for the reinsurance.
 *
 * HONESTY (CLAUDE.md / gap-analysis Tier-3 #12): this is a structurally
 * correct **template engine**, not certified NAIC content. The shape follows
 * the SSAP 62R / Schedule F provision mechanics (uncollateralized exposure to
 * unauthorized reinsurers + a percentage of overdue balances, capped at the
 * recoverable), but the percentages and the secure-rating sets below are
 * **ILLUSTRATIVE DEFAULTS (configurable)** - not the certified NAIC factor
 * tables, which a real filing would source from the current NAIC instructions.
 *
 * Pure domain: Money in integer minor units, no I/O, no clock, no DB.
 */

import { type Money, MoneyError, add, max, min, money, multiply, subtract, zero } from './money.js';

/**
 * ILLUSTRATIVE DEFAULT (configurable): the provision rate applied to overdue
 * recoverable balances (the classic "20% of overdue" shape). Not a certified
 * NAIC factor.
 */
export const ILLUSTRATIVE_OVERDUE_PROVISION_RATE = 0.2;

/**
 * ILLUSTRATIVE DEFAULTS (configurable): ratings treated as "secure" per
 * agency, used to classify a counterparty as authorized/secure when no
 * licensure data is available. Real Schedule F authorization is a licensure /
 * accreditation question and certified reinsurer ratings carry their own
 * collateral percentages - both are jurisdiction configuration, not this list.
 */
export const ILLUSTRATIVE_SECURE_RATINGS: Readonly<Record<string, readonly string[]>> = {
  SP: ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-'],
  FITCH: ['AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-'],
  MOODYS: ['Aaa', 'Aa1', 'Aa2', 'Aa3', 'A1', 'A2', 'A3', 'Baa1', 'Baa2', 'Baa3'],
  AM_BEST: ['A++', 'A+', 'A', 'A-', 'B++', 'B+'],
  INTERNAL: ['SECURE'],
};

/**
 * Is a rating "secure" under the given (default: illustrative) per-agency
 * sets? Unknown agencies and unlisted ratings are NOT secure (fail-closed).
 */
export function ratingIsSecure(
  agency: string,
  rating: string,
  secureRatings: Readonly<Record<string, readonly string[]>> = ILLUSTRATIVE_SECURE_RATINGS,
): boolean {
  const set = secureRatings[agency.toUpperCase()];
  return set !== undefined && set.includes(rating);
}

/** One ceded counterparty's position feeding the provision. Same currency throughout. */
export interface ScheduleFCounterparty {
  counterparty: string;
  /** Treated-as-authorized (licensed/accredited or secure-rated). Unrated ⇒ false. */
  authorized: boolean;
  /** Total reinsurance recoverable from this counterparty. */
  recoverable: Money;
  /** Portion of the recoverable overdue past the aging threshold (e.g. >90 days). */
  overdue: Money;
  /** Qualifying collateral held (LOC / funds withheld / trust / cash). Must be >= 0. */
  collateral: Money;
}

export interface ScheduleFProvisionLine {
  counterparty: string;
  authorized: boolean;
  recoverable: Money;
  /** Overdue clamped into [0, recoverable exposure]. */
  overdue: Money;
  collateral: Money;
  /** Recoverable exposure not covered by collateral (unauthorized only; zero for authorized). */
  uncollateralized: Money;
  /** Provision for reinsurance for this counterparty (never exceeds the exposure). */
  provision: Money;
  /** recoverable - provision. */
  net: Money;
}

export interface ScheduleFTotals {
  recoverable: Money;
  overdue: Money;
  collateral: Money;
  provision: Money;
  netRecoverable: Money;
  authorizedRecoverable: Money;
  unauthorizedRecoverable: Money;
  authorizedProvision: Money;
  unauthorizedProvision: Money;
}

export interface ScheduleFResult {
  lines: ScheduleFProvisionLine[];
  totals: ScheduleFTotals;
  /** The rate actually applied (illustrative default unless overridden). */
  overdueProvisionRate: number;
}

export interface ScheduleFOptions {
  /** Provision rate on overdue balances, 0..1. ILLUSTRATIVE DEFAULT 0.20 - configurable, not a certified NAIC factor. */
  overdueProvisionRate?: number;
}

/**
 * Compute the provision for reinsurance across a set of same-currency ceded
 * counterparties (illustrative Schedule F shape, see file header):
 *
 * - authorized:   provision = rate × overdue                       (capped at exposure)
 * - unauthorized: provision = (exposure − collateral)⁺
 *                           + rate × (overdue within the collateralized part)  (capped at exposure)
 *
 * Exposure is the recoverable floored at zero (a net-payable counterparty
 * needs no provision). Overdue is clamped into [0, exposure]. All arithmetic
 * is integer minor units via the Money helpers; mixing currencies throws.
 */
export function scheduleFProvision(
  counterparties: ScheduleFCounterparty[],
  currency: string,
  options: ScheduleFOptions = {},
): ScheduleFResult {
  const rate = options.overdueProvisionRate ?? ILLUSTRATIVE_OVERDUE_PROVISION_RATE;
  if (!(rate >= 0 && rate <= 1)) {
    throw new MoneyError(`overdueProvisionRate must be within [0,1], got ${rate}`);
  }
  const nil = zero(currency);

  const lines: ScheduleFProvisionLine[] = counterparties.map((c) => {
    if (c.collateral.amount < 0) {
      throw new MoneyError(`Collateral for ${c.counterparty} must not be negative`);
    }
    if (c.overdue.amount < 0) {
      throw new MoneyError(`Overdue for ${c.counterparty} must not be negative`);
    }
    // Exposure floored at zero; overdue clamped into the exposure.
    const exposure = max(nil, c.recoverable);
    const overdue = min(c.overdue, exposure);

    let uncollateralized = nil;
    let provision: Money;
    if (c.authorized) {
      provision = min(exposure, multiply(overdue, rate));
    } else {
      uncollateralized = max(nil, subtract(exposure, c.collateral));
      // The overdue penalty applies to the part of the overdue balance that the
      // collateral covers; the uncollateralized part is already provisioned in full.
      const collateralizedOverdue = min(overdue, min(c.collateral, exposure));
      provision = min(exposure, add(uncollateralized, multiply(collateralizedOverdue, rate)));
    }

    return {
      counterparty: c.counterparty,
      authorized: c.authorized,
      recoverable: c.recoverable,
      overdue,
      collateral: c.collateral,
      uncollateralized,
      provision,
      net: subtract(c.recoverable, provision),
    };
  });

  const total = (pick: (l: ScheduleFProvisionLine) => Money, only?: (l: ScheduleFProvisionLine) => boolean): Money =>
    lines.filter(only ?? (() => true)).reduce((acc, l) => add(acc, pick(l)), money(0, currency));

  const recoverable = total((l) => l.recoverable);
  const provision = total((l) => l.provision);

  return {
    lines,
    totals: {
      recoverable,
      overdue: total((l) => l.overdue),
      collateral: total((l) => l.collateral),
      provision,
      netRecoverable: subtract(recoverable, provision),
      authorizedRecoverable: total((l) => l.recoverable, (l) => l.authorized),
      unauthorizedRecoverable: total((l) => l.recoverable, (l) => !l.authorized),
      authorizedProvision: total((l) => l.provision, (l) => l.authorized),
      unauthorizedProvision: total((l) => l.provision, (l) => !l.authorized),
    },
    overdueProvisionRate: rate,
  };
}
