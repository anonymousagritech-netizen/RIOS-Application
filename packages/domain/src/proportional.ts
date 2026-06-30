/**
 * Proportional (pro-rata) treaty calculations - brief §7.2.
 *
 * Covers quota share and surplus cession, the standard commission stack
 * (ceding / overriding / brokerage), profit commission with allowable expenses
 * and loss carry-forward, and sliding-scale commission.
 *
 * Every function is pure and currency-consistent. Defaults are explicit and are
 * intended to be supplied from configuration in the running platform (§3.5, §10).
 */

import { Money, money, multiply, percentOf, subtract, add, zero, isNegative } from './money.js';

// ---------------------------------------------------------------------------
// Cession
// ---------------------------------------------------------------------------

export interface QuotaShareTerms {
  /** Ceded share as a fraction in [0,1], e.g. 0.30 for 30%. */
  cededShare: number;
}

export interface CessionResult {
  cededShare: number;
  cededPremium: Money;
  retainedPremium: Money;
}

export function quotaShareCession(grossPremium: Money, terms: QuotaShareTerms): CessionResult {
  if (terms.cededShare < 0 || terms.cededShare > 1) {
    throw new RangeError(`Quota share cededShare must be in [0,1], got ${terms.cededShare}`);
  }
  const cededPremium = multiply(grossPremium, terms.cededShare);
  return {
    cededShare: terms.cededShare,
    cededPremium,
    retainedPremium: subtract(grossPremium, cededPremium),
  };
}

export interface SurplusTerms {
  /** The cedent's retained line (sum insured retained), in the same currency basis as sumInsured. */
  retentionLine: number;
  /** Number of lines of surplus capacity (e.g. 9 lines => up to 9x the retention can be ceded). */
  numberOfLines: number;
}

/**
 * Surplus cession for a single risk. The ceded share is the surplus above the
 * retention, capped by the treaty capacity (lines * retention), expressed as a
 * fraction of the sum insured.
 */
export function surplusCession(sumInsured: number, grossPremium: Money, terms: SurplusTerms): CessionResult {
  if (terms.retentionLine <= 0) throw new RangeError('retentionLine must be positive');
  if (terms.numberOfLines < 0) throw new RangeError('numberOfLines must be non-negative');

  const capacity = terms.retentionLine * terms.numberOfLines;
  const surplus = Math.max(0, sumInsured - terms.retentionLine);
  const ceded = Math.min(surplus, capacity);
  const cededShare = sumInsured > 0 ? ceded / sumInsured : 0;

  const cededPremium = multiply(grossPremium, cededShare);
  return {
    cededShare,
    cededPremium,
    retainedPremium: subtract(grossPremium, cededPremium),
  };
}

// ---------------------------------------------------------------------------
// Commissions
// ---------------------------------------------------------------------------

export interface CommissionTerms {
  /** Ceding commission % paid by reinsurer to cedent (e.g. 25 = 25%). */
  cedingCommissionPct: number;
  /** Overriding commission % (broker/intermediary override), optional. */
  overridingCommissionPct?: number;
  /** Brokerage % retained by the broker, optional. */
  brokeragePct?: number;
}

export interface CommissionResult {
  cedingCommission: Money;
  overridingCommission: Money;
  brokerage: Money;
  totalCommission: Money;
}

/** Commissions are computed on the ceded premium. */
export function commissions(cededPremium: Money, terms: CommissionTerms): CommissionResult {
  const cedingCommission = percentOf(cededPremium, terms.cedingCommissionPct);
  const overridingCommission = percentOf(cededPremium, terms.overridingCommissionPct ?? 0);
  const brokerage = percentOf(cededPremium, terms.brokeragePct ?? 0);
  return {
    cedingCommission,
    overridingCommission,
    brokerage,
    totalCommission: add(add(cedingCommission, overridingCommission), brokerage),
  };
}

// ---------------------------------------------------------------------------
// Profit commission (§7.2 - allowable expenses + loss carry-forward)
// ---------------------------------------------------------------------------

export interface ProfitCommissionTerms {
  /** Profit-commission rate on the net profit, e.g. 20 = 20%. */
  ratePct: number;
  /** Reinsurer's management expense allowance as % of ceded premium, e.g. 5 = 5%. */
  allowableExpensesPct: number;
  /** Loss brought forward from prior period(s) as a positive Money (a prior-year deficit). */
  lossCarriedForward?: Money;
}

export interface ProfitCommissionInput {
  cededPremium: Money;
  /** Commission already paid to the cedent in the period (ceding + overriding). */
  commissionPaid: Money;
  /** Incurred losses to the reinsurer in the period (paid + outstanding) for the treaty. */
  incurredLosses: Money;
}

export interface ProfitCommissionResult {
  /** Reinsurer profit before applying the PC rate (>= 0 means a payment is due). */
  profit: Money;
  /** The profit commission payable to the cedent (0 if no profit). */
  profitCommission: Money;
  /** Deficit to carry forward to the next period (0 if profitable). */
  lossCarriedForward: Money;
  /** The full statement used to derive the result, for explainability (§4.4). */
  workings: {
    cededPremium: Money;
    allowableExpenses: Money;
    commissionPaid: Money;
    incurredLosses: Money;
    lossBroughtForward: Money;
  };
}

/**
 * Profit commission on the classic reinsurer-account basis:
 *
 *   profit = cededPremium
 *          − commissionPaid
 *          − allowableExpenses (reinsurer margin)
 *          − incurredLosses
 *          − lossBroughtForward
 *
 * If profit > 0, PC = profit × rate and nothing is carried forward.
 * If profit <= 0, PC = 0 and the deficit is carried forward to the next period.
 */
export function profitCommission(
  input: ProfitCommissionInput,
  terms: ProfitCommissionTerms,
): ProfitCommissionResult {
  const currency = input.cededPremium.currency;
  const allowableExpenses = percentOf(input.cededPremium, terms.allowableExpensesPct);
  const lossBroughtForward = terms.lossCarriedForward ?? zero(currency);

  const profit = subtract(
    subtract(
      subtract(subtract(input.cededPremium, input.commissionPaid), allowableExpenses),
      input.incurredLosses,
    ),
    lossBroughtForward,
  );

  if (isNegative(profit) || profit.amount === 0) {
    return {
      profit,
      profitCommission: zero(currency),
      // Carry forward the absolute deficit (positive value).
      lossCarriedForward: money(-profit.amount, currency),
      workings: {
        cededPremium: input.cededPremium,
        allowableExpenses,
        commissionPaid: input.commissionPaid,
        incurredLosses: input.incurredLosses,
        lossBroughtForward,
      },
    };
  }

  return {
    profit,
    profitCommission: percentOf(profit, terms.ratePct),
    lossCarriedForward: zero(currency),
    workings: {
      cededPremium: input.cededPremium,
      allowableExpenses,
      commissionPaid: input.commissionPaid,
      incurredLosses: input.incurredLosses,
      lossBroughtForward,
    },
  };
}

// ---------------------------------------------------------------------------
// Sliding-scale commission (§7.2)
// ---------------------------------------------------------------------------

export interface SlidingScaleBand {
  /** Loss ratio at or above which this commission applies, as a fraction (e.g. 0.50 = 50%). */
  lossRatioFrom: number;
  /** Commission % at this band (e.g. 30 = 30%). Interpolated between band points. */
  commissionPct: number;
}

export interface SlidingScaleTerms {
  /** Bands ordered by lossRatioFrom ascending. Commission is highest at low loss ratios. */
  bands: SlidingScaleBand[];
  /** Provisional commission % booked before the slide is known. */
  provisionalPct: number;
  minPct: number;
  maxPct: number;
}

/**
 * Determine the sliding-scale commission % for an actual loss ratio.
 * Linear interpolation between adjacent band points, clamped to [minPct, maxPct].
 */
export function slidingScaleCommissionPct(lossRatio: number, terms: SlidingScaleTerms): number {
  const bands = [...terms.bands].sort((a, b) => a.lossRatioFrom - b.lossRatioFrom);
  if (bands.length === 0) return clampPct(terms.provisionalPct, terms);

  if (lossRatio <= bands[0]!.lossRatioFrom) return clampPct(bands[0]!.commissionPct, terms);
  const last = bands[bands.length - 1]!;
  if (lossRatio >= last.lossRatioFrom) return clampPct(last.commissionPct, terms);

  for (let i = 0; i < bands.length - 1; i++) {
    const lo = bands[i]!;
    const hi = bands[i + 1]!;
    if (lossRatio >= lo.lossRatioFrom && lossRatio <= hi.lossRatioFrom) {
      const span = hi.lossRatioFrom - lo.lossRatioFrom;
      const t = span === 0 ? 0 : (lossRatio - lo.lossRatioFrom) / span;
      const pct = lo.commissionPct + t * (hi.commissionPct - lo.commissionPct);
      return clampPct(pct, terms);
    }
  }
  return clampPct(terms.provisionalPct, terms);
}

function clampPct(pct: number, terms: SlidingScaleTerms): number {
  return Math.min(terms.maxPct, Math.max(terms.minPct, pct));
}

/**
 * Net account balance from the cedent's perspective:
 *   ceded premium − total commission − ceded losses.
 * A positive balance is owed by the cedent to the reinsurer.
 */
export function proportionalAccountBalance(args: {
  cededPremium: Money;
  totalCommission: Money;
  cededLosses: Money;
}): Money {
  return subtract(subtract(args.cededPremium, args.totalCommission), args.cededLosses);
}

// ---------------------------------------------------------------------------
// Portfolio entry / withdrawal (§7.2 - proportional treaty inception/expiry)
// ---------------------------------------------------------------------------

export interface PortfolioTransferTerms {
  /** Premium-portfolio percentage of the unearned premium reserve transferred (e.g. 35 = 35%). */
  premiumPortfolioPct: number;
  /** Loss-portfolio percentage of the outstanding reserves transferred (e.g. 90 = 90%). */
  lossPortfolioPct: number;
  /** 'entry' at inception (reinsurer assumes the in-force book), 'withdrawal' at expiry (reinsurer releases it). */
  direction: 'entry' | 'withdrawal';
}

export interface PortfolioTransferResult {
  premiumTransfer: Money;
  lossTransfer: Money;
  /** Net cash effect from the reinsurer's perspective: a portfolio entry receives premium and assumes losses. */
  netTransfer: Money;
}

/**
 * Portfolio transfer at the start (entry) or end (withdrawal) of a proportional
 * treaty. On entry the reinsurer receives a premium-portfolio amount (UPR share)
 * and assumes a loss-portfolio amount (outstanding share); on withdrawal the
 * signs reverse. Net = premium − loss for an entry; the inverse for a withdrawal.
 */
export function portfolioTransfer(
  unearnedPremium: Money,
  outstandingLosses: Money,
  terms: PortfolioTransferTerms,
): PortfolioTransferResult {
  const premiumTransfer = percentOf(unearnedPremium, terms.premiumPortfolioPct);
  const lossTransfer = percentOf(outstandingLosses, terms.lossPortfolioPct);
  const sign = terms.direction === 'entry' ? 1 : -1;
  const net = (premiumTransfer.amount - lossTransfer.amount) * sign;
  return {
    premiumTransfer: money(premiumTransfer.amount * sign, premiumTransfer.currency),
    lossTransfer: money(lossTransfer.amount * sign, lossTransfer.currency),
    netTransfer: money(net, premiumTransfer.currency),
  };
}
