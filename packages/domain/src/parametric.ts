/**
 * Parametric (index-trigger) and Industry Loss Warranty (ILW) evaluation.
 *
 * Parametric covers pay on a measured index crossing a threshold, NOT on
 * adjusted loss: binary (all-or-nothing), stepped (banded), or linear (rate per
 * unit above an attachment, capped at the limit). ILWs pay off a third-party
 * industry-loss index, typically with a dual trigger (the buyer must also show a
 * minimum own loss, giving genuine insurable interest).
 *
 * Pure and deterministic. All money amounts are integer minor units (numbers);
 * payouts are rounded to whole minor units, never left as floats.
 */

// ---------------------------------------------------------------------------
// Parametric
// ---------------------------------------------------------------------------

export type PayoutFunction =
  | { type: 'BINARY'; trigger: number; payoutMinor: number }
  | { type: 'STEP'; steps: { trigger: number; payoutMinor: number }[] }
  | { type: 'LINEAR'; attachment: number; slopeMinorPerUnit: number; limitMinor: number };

export interface ParametricCover {
  perilType: string;
  index: { source: string; metric: string };
  payout: PayoutFunction;
}

export interface ParametricResult {
  triggered: boolean;
  payoutMinor: number;
  observed: number;
}

/** Evaluate a parametric cover against an observed index value. */
export function evaluateParametric(cover: ParametricCover, observed: number): ParametricResult {
  const p = cover.payout;
  if (p.type === 'BINARY') {
    const triggered = observed >= p.trigger;
    return { triggered, payoutMinor: triggered ? p.payoutMinor : 0, observed };
  }
  if (p.type === 'STEP') {
    // Highest band whose trigger is met.
    let payout = 0;
    let triggered = false;
    for (const s of [...p.steps].sort((a, b) => a.trigger - b.trigger)) {
      if (observed >= s.trigger) { payout = s.payoutMinor; triggered = true; }
    }
    return { triggered, payoutMinor: payout, observed };
  }
  // LINEAR: clamp((observed - attachment) * slope, 0, limit), rounded to minor units.
  const raw = Math.max(0, observed - p.attachment) * p.slopeMinorPerUnit;
  const payout = Math.min(p.limitMinor, Math.round(raw));
  return { triggered: payout > 0, payoutMinor: payout, observed };
}

// ---------------------------------------------------------------------------
// Industry Loss Warranty (ILW)
// ---------------------------------------------------------------------------

export interface Ilw {
  structure: 'BINARY' | 'INDEMNITY';
  basis: 'OCCURRENCE' | 'AGGREGATE';
  peril: string;
  industryTriggerMinor: number;
  limitMinor: number;
  /** Dual trigger: the buyer must also show at least this own loss. */
  warrantyMinOwnLossMinor?: number;
}

export interface IlwResult {
  triggered: boolean;
  payoutMinor: number;
  industryTriggerMet: boolean;
  warrantyMet: boolean;
}

/**
 * Evaluate an ILW for a single industry-loss figure (occurrence) or the summed
 * figure (aggregate, summed upstream) plus the buyer's own loss.
 *  - BINARY: pays the full limit when triggered.
 *  - INDEMNITY: pays min(ownLoss, limit) when triggered.
 */
export function evaluateIlw(ilw: Ilw, industryLossMinor: number, ownLossMinor: number): IlwResult {
  const industryTriggerMet = industryLossMinor >= ilw.industryTriggerMinor;
  const warrantyMet = ilw.warrantyMinOwnLossMinor == null || ownLossMinor >= ilw.warrantyMinOwnLossMinor;
  const triggered = industryTriggerMet && warrantyMet;
  let payout = 0;
  if (triggered) {
    payout = ilw.structure === 'BINARY' ? ilw.limitMinor : Math.min(ilw.limitMinor, ownLossMinor);
  }
  return { triggered, payoutMinor: payout, industryTriggerMet, warrantyMet };
}
