/**
 * Underwriting decision support - pure, deterministic, framework-free.
 *
 * Two things live here:
 *  1. The submission stage machine (Submission → … → Bound / Declined) with the
 *     legal transitions, so the server can reject illegal moves the same way the
 *     treaty lifecycle does.
 *  2. A transparent, explainable risk score (0-100) built from underwriting
 *     factors - loss experience, catastrophe exposure, capacity utilisation, the
 *     class-of-business hazard weight and the relationship history. It is NOT a
 *     black box: every factor's contribution is returned so an underwriter (and
 *     an auditor) can see why a submission scored the way it did.
 */

export type UwStage =
  | 'SUBMISSION'
  | 'TRIAGE'
  | 'ANALYSIS'
  | 'PRICING'
  | 'REFERRAL'
  | 'QUOTED'
  | 'BOUND'
  | 'DECLINED'
  | 'LAPSED';

/** The linear "happy path" through the pipeline (excludes terminal side-exits). */
export const UW_PIPELINE: UwStage[] = [
  'SUBMISSION', 'TRIAGE', 'ANALYSIS', 'PRICING', 'REFERRAL', 'QUOTED', 'BOUND',
];

/** Legal next-stages from each stage. Any submission can be declined or lapse. */
export const UW_TRANSITIONS: Record<UwStage, UwStage[]> = {
  SUBMISSION: ['TRIAGE', 'DECLINED', 'LAPSED'],
  TRIAGE: ['ANALYSIS', 'DECLINED', 'LAPSED'],
  ANALYSIS: ['PRICING', 'REFERRAL', 'DECLINED', 'LAPSED'],
  PRICING: ['REFERRAL', 'QUOTED', 'DECLINED', 'LAPSED'],
  REFERRAL: ['PRICING', 'QUOTED', 'DECLINED', 'LAPSED'],
  QUOTED: ['BOUND', 'REFERRAL', 'DECLINED', 'LAPSED'],
  BOUND: [],
  DECLINED: [],
  LAPSED: [],
};

export function canTransition(from: UwStage, to: UwStage): boolean {
  return (UW_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalStage(s: UwStage): boolean {
  return s === 'BOUND' || s === 'DECLINED' || s === 'LAPSED';
}

/** 0..1 progress along the pipeline (terminal non-bound stages report their
 *  furthest reached point, capped just below completion). */
export function stageProgress(s: UwStage): number {
  if (s === 'BOUND') return 1;
  if (s === 'DECLINED' || s === 'LAPSED') return 0;
  const i = UW_PIPELINE.indexOf(s);
  if (i < 0) return 0;
  return i / (UW_PIPELINE.length - 1);
}

export type RiskBand = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH';

export interface RiskFactorInput {
  /** Historical loss ratio as a percentage (e.g. 65 = 65%). */
  lossRatioPct?: number;
  /** Whether the risk is materially catastrophe-exposed. */
  catExposed?: boolean;
  /** Capacity already committed to the peril/zone, as a percentage 0-100. */
  capacityUtilPct?: number;
  /** Class-of-business hazard weight, 1 (benign) … 5 (hazardous). */
  classHazard?: number;
  /** Number of prior claims on the account. */
  priorClaims?: number;
  /** Years of relationship with the cedent (loyalty reduces risk). */
  yearsWithCedent?: number;
}

export interface RiskContribution { factor: string; points: number; detail: string; }
export interface RiskScoreResult {
  score: number;               // 0 (benign) … 100 (severe)
  band: RiskBand;
  contributions: RiskContribution[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Weighted additive model on a 0-100 scale. Weights sum to 100 at their caps so
 * the score is directly interpretable as a percentage of "maximum concern".
 */
export function riskScore(input: RiskFactorInput): RiskScoreResult {
  const contributions: RiskContribution[] = [];

  // Loss experience — up to 35 pts. A 100% loss ratio saturates the factor.
  const lr = input.lossRatioPct ?? 0;
  const lrPts = clamp((lr / 100) * 35, 0, 35);
  contributions.push({ factor: 'Loss experience', points: round1(lrPts), detail: `Loss ratio ${lr}%` });

  // Catastrophe exposure — flat 20 pts if exposed.
  const catPts = input.catExposed ? 20 : 0;
  contributions.push({ factor: 'Catastrophe exposure', points: catPts, detail: input.catExposed ? 'Cat-exposed' : 'Non-cat' });

  // Capacity utilisation — up to 15 pts; accumulation risk rises with usage.
  const cu = clamp(input.capacityUtilPct ?? 0, 0, 100);
  const cuPts = (cu / 100) * 15;
  contributions.push({ factor: 'Capacity utilisation', points: round1(cuPts), detail: `${cu}% of zone capacity used` });

  // Class hazard — up to 20 pts (weight 1..5 → 0..20).
  const hz = clamp(input.classHazard ?? 1, 1, 5);
  const hzPts = ((hz - 1) / 4) * 20;
  contributions.push({ factor: 'Class hazard', points: round1(hzPts), detail: `Hazard weight ${hz}/5` });

  // Prior claims — up to 15 pts; each claim adds 3, capped.
  const pc = Math.max(0, input.priorClaims ?? 0);
  const pcPts = clamp(pc * 3, 0, 15);
  contributions.push({ factor: 'Prior claims', points: pcPts, detail: `${pc} prior claim(s)` });

  // Relationship — a credit (negative), up to -5 pts for a 5+ year relationship.
  const yrs = Math.max(0, input.yearsWithCedent ?? 0);
  const relPts = -clamp(yrs, 0, 5);
  contributions.push({ factor: 'Cedent relationship', points: relPts, detail: `${yrs} year(s) with cedent` });

  const raw = contributions.reduce((a, c) => a + c.points, 0);
  const score = Math.round(clamp(raw, 0, 100));
  return { score, band: riskBand(score), contributions };
}

export function riskBand(score: number): RiskBand {
  if (score < 25) return 'LOW';
  if (score < 50) return 'MODERATE';
  if (score < 75) return 'ELEVATED';
  return 'HIGH';
}

/**
 * A first-cut technical premium indicator: expected loss grossed up for expenses
 * and a risk-adjusted profit load that scales with the risk score. Everything is
 * in the same (integer minor) units as the inputs.
 *
 *   technical = expectedLoss / (1 - expenseRatio - profitLoad)
 *   profitLoad = base + (score/100) * spread
 */
export interface TechnicalPriceInput {
  expectedLossMinor: number;   // pure expected loss cost
  expenseRatio?: number;       // fraction 0..1 (default 0.15)
  baseProfitLoad?: number;     // fraction 0..1 (default 0.05)
  profitSpread?: number;       // fraction 0..1 (default 0.20) scaled by risk score
  riskScore?: number;          // 0..100
}
export interface TechnicalPriceResult {
  technicalPremiumMinor: number;
  profitLoad: number;
  impliedLossRatioPct: number;
}
export function technicalPremium(input: TechnicalPriceInput): TechnicalPriceResult {
  const expense = clamp(input.expenseRatio ?? 0.15, 0, 0.9);
  const base = clamp(input.baseProfitLoad ?? 0.05, 0, 0.9);
  const spread = clamp(input.profitSpread ?? 0.20, 0, 0.9);
  const score = clamp(input.riskScore ?? 0, 0, 100);
  const profitLoad = clamp(base + (score / 100) * spread, 0, 0.9);
  const denom = Math.max(0.05, 1 - expense - profitLoad);
  const technicalPremiumMinor = Math.round(input.expectedLossMinor / denom);
  const impliedLossRatioPct = technicalPremiumMinor > 0
    ? round1((input.expectedLossMinor / technicalPremiumMinor) * 100)
    : 0;
  return { technicalPremiumMinor, profitLoad: round1(profitLoad * 100) / 100, impliedLossRatioPct };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
