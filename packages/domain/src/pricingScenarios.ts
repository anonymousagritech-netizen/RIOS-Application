/**
 * Underwriting pricing scenarios & profitability ratios - pure and deterministic.
 *
 * Builds on the loss-cost primitives elsewhere in @rios/domain (burning cost,
 * exposure rating, ILF) by turning an expected loss + expense/profit assumptions
 * into the headline underwriting ratios and letting an underwriter run rate-change
 * / loss-ratio "what-if" grids and one-at-a-time sensitivities.
 *
 * All money is integer minor units; ratios are fractions unless a field name ends
 * in "Pct".
 */

export interface RatioInput {
  premiumMinor: number;
  expectedLossMinor: number;
  expenseRatio?: number;   // fraction of premium (default 0.15)
}
export interface RatioResult {
  lossRatioPct: number;
  expenseRatioPct: number;
  combinedRatioPct: number;
  underwritingResultMinor: number;   // premium - loss - expense (positive = profit)
  marginPct: number;                 // 100 - combined
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

export function ratios(input: RatioInput): RatioResult {
  const premium = Math.max(0, input.premiumMinor);
  const expense = clamp(input.expenseRatio ?? 0.15, 0, 1);
  const lossRatio = premium > 0 ? input.expectedLossMinor / premium : 0;
  const combined = lossRatio + expense;
  const expenseMinor = Math.round(premium * expense);
  return {
    lossRatioPct: r1(lossRatio * 100),
    expenseRatioPct: r1(expense * 100),
    combinedRatioPct: r1(combined * 100),
    underwritingResultMinor: premium - input.expectedLossMinor - expenseMinor,
    marginPct: r1((1 - combined) * 100),
  };
}

export interface ScenarioInput {
  basePremiumMinor: number;
  expectedLossMinor: number;
  expenseRatio?: number;
  /** Rate changes to apply to premium, as fractions (e.g. [-0.1, 0, 0.1, 0.2]). */
  rateChanges: number[];
  /** Multiplicative shocks to the expected loss (e.g. [0.9, 1, 1.1, 1.25]). */
  lossShocks: number[];
}
export interface ScenarioCell {
  rateChange: number;
  lossShock: number;
  premiumMinor: number;
  expectedLossMinor: number;
  combinedRatioPct: number;
  underwritingResultMinor: number;
}

/** A rate-change × loss-shock grid of combined ratios and technical results. */
export function scenarioGrid(input: ScenarioInput): ScenarioCell[] {
  const cells: ScenarioCell[] = [];
  for (const rc of input.rateChanges) {
    for (const ls of input.lossShocks) {
      const premiumMinor = Math.round(input.basePremiumMinor * (1 + rc));
      const expectedLossMinor = Math.round(input.expectedLossMinor * ls);
      const rr = ratios({ premiumMinor, expectedLossMinor, expenseRatio: input.expenseRatio });
      cells.push({
        rateChange: rc, lossShock: ls, premiumMinor, expectedLossMinor,
        combinedRatioPct: rr.combinedRatioPct, underwritingResultMinor: rr.underwritingResultMinor,
      });
    }
  }
  return cells;
}

export interface SensitivityPoint { driver: string; value: number; combinedRatioPct: number; }

/**
 * One-at-a-time sensitivity of the combined ratio to the two headline drivers:
 * the rate change and the loss shock, holding the other at its base.
 */
export function sensitivity(input: ScenarioInput): { rate: SensitivityPoint[]; loss: SensitivityPoint[] } {
  const rate = input.rateChanges.map((rc) => ({
    driver: 'rateChange', value: rc,
    combinedRatioPct: ratios({
      premiumMinor: Math.round(input.basePremiumMinor * (1 + rc)),
      expectedLossMinor: input.expectedLossMinor, expenseRatio: input.expenseRatio,
    }).combinedRatioPct,
  }));
  const loss = input.lossShocks.map((ls) => ({
    driver: 'lossShock', value: ls,
    combinedRatioPct: ratios({
      premiumMinor: input.basePremiumMinor,
      expectedLossMinor: Math.round(input.expectedLossMinor * ls), expenseRatio: input.expenseRatio,
    }).combinedRatioPct,
  }));
  return { rate, loss };
}

/**
 * The premium rate change needed to hit a target combined ratio, holding the
 * expected loss and expense ratio fixed. Returns the fractional rate change.
 */
export function rateChangeForTarget(input: { basePremiumMinor: number; expectedLossMinor: number; expenseRatio?: number; targetCombinedPct: number }): number {
  const expense = clamp(input.expenseRatio ?? 0.15, 0, 1);
  const targetLossFraction = Math.max(0.01, input.targetCombinedPct / 100 - expense);
  const requiredPremium = input.expectedLossMinor / targetLossFraction;
  if (input.basePremiumMinor <= 0) return 0;
  return r1((requiredPremium / input.basePremiumMinor - 1) * 100) / 100;
}
