/**
 * Risk & capital management (brief §13 — risk & capital; complements Solvency II).
 *
 * Pure capital and tail-risk metrics: empirical Value-at-Risk / Tail-VaR over a
 * loss sample, diversified capital aggregation across risk modules (a
 * correlation-matrix square-root, the standard-formula shape), the solvency
 * ratio and adequacy verdict, and the net retained loss of a deterministic
 * scenario after recoveries. Money is integer minor units; no I/O, unit-tested.
 */

/**
 * Empirical Value-at-Risk at a confidence level (e.g. 0.995). The α-VaR is the
 * loss exceeded with probability (1−α): we take the ⌈(1−α)·N⌉-th worst sample.
 * Returns 0 for an empty sample.
 */
export function valueAtRisk(losses: number[], confidence: number): number {
  const sorted = [...(losses ?? [])].sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  const c = Math.min(Math.max(confidence, 0), 1);
  // Subtract a tiny epsilon so float drift (e.g. (1−0.7)·10 = 3.0000…4) can't
  // bump the rank to the next integer.
  const rank = Math.max(1, Math.ceil((1 - c) * sorted.length - 1e-9));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

/**
 * Tail Value-at-Risk (expected shortfall): the mean of the worst ⌈(1−α)·N⌉
 * samples — the average loss given the VaR threshold is breached.
 */
export function tailValueAtRisk(losses: number[], confidence: number): number {
  const sorted = [...(losses ?? [])].sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  const c = Math.min(Math.max(confidence, 0), 1);
  const k = Math.max(1, Math.ceil((1 - c) * sorted.length - 1e-9));
  const tail = sorted.slice(0, Math.min(k, sorted.length));
  return Math.round(tail.reduce((a, b) => a + b, 0) / tail.length);
}

/**
 * Diversified capital across standalone module charges using a correlation
 * matrix: √(Σ_i Σ_j ρ_ij · c_i · c_j) (the Solvency-II standard-formula
 * aggregation). Defaults to the identity matrix (independent → √Σc²). A full
 * matrix of ones reproduces simple addition (Σc). Result rounded to minor units.
 */
export function diversifiedCapital(standalone: number[], correlation?: number[][]): number {
  const c = standalone ?? [];
  const n = c.length;
  if (n === 0) return 0;
  const rho = (i: number, j: number): number => {
    if (i === j) return 1;
    return correlation?.[i]?.[j] ?? 0;
  };
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sum += rho(i, j) * c[i]! * c[j]!;
    }
  }
  return Math.round(Math.sqrt(Math.max(0, sum)));
}

export interface CapitalAdequacy {
  ownFundsMinor: number;
  scrMinor: number;
  /** own funds ÷ SCR; Infinity when SCR is 0. */
  solvencyRatio: number;
  /** own funds − SCR (positive = surplus, negative = deficit). */
  surplusMinor: number;
  /** Coverage band against the SCR. */
  status: 'breach' | 'warning' | 'adequate' | 'strong';
}

/**
 * Capital coverage ratio = own funds ÷ SCR. Unlike the strict Pillar-3
 * `solvencyRatio` in solvency2 (which requires a positive SCR), this is total —
 * it returns Infinity (or 0) when the SCR is zero, so post-event projections
 * never throw.
 */
export function coverageRatio(ownFundsMinor: number, scrMinor: number): number {
  if (scrMinor <= 0) return ownFundsMinor > 0 ? Infinity : 0;
  return ownFundsMinor / scrMinor;
}

/**
 * Capital adequacy verdict against the SCR. Bands: < 1.0 breach, < 1.25 warning,
 * < 1.5 adequate, otherwise strong.
 */
export function capitalAdequacy(ownFundsMinor: number, scrMinor: number): CapitalAdequacy {
  const ratio = coverageRatio(ownFundsMinor, scrMinor);
  const status: CapitalAdequacy['status'] =
    ratio < 1 ? 'breach' : ratio < 1.25 ? 'warning' : ratio < 1.5 ? 'adequate' : 'strong';
  return {
    ownFundsMinor,
    scrMinor,
    solvencyRatio: ratio,
    surplusMinor: ownFundsMinor - scrMinor,
    status,
  };
}

export interface ScenarioRecovery {
  source?: string;
  recoveryMinor: number;
}

export interface ScenarioResult {
  grossLossMinor: number;
  totalRecoveryMinor: number;
  netLossMinor: number;
  /** Own funds remaining after absorbing the net loss. */
  postEventOwnFundsMinor: number;
  /** Solvency ratio after the event (own funds − net loss) ÷ SCR. */
  postEventRatio: number;
}

/**
 * Evaluate a deterministic disaster scenario: net it down by recoveries
 * (reinsurance/retro), then show the post-event own funds and solvency ratio.
 * Net loss is floored at zero (recoveries cannot exceed the gross).
 */
export function evaluateScenario(
  grossLossMinor: number,
  recoveries: ScenarioRecovery[],
  ownFundsMinor: number,
  scrMinor: number,
): ScenarioResult {
  const totalRecoveryMinor = Math.min(
    grossLossMinor,
    (recoveries ?? []).reduce((a, r) => a + Math.max(0, r.recoveryMinor), 0),
  );
  const netLossMinor = grossLossMinor - totalRecoveryMinor;
  const postEventOwnFundsMinor = ownFundsMinor - netLossMinor;
  return {
    grossLossMinor,
    totalRecoveryMinor,
    netLossMinor,
    postEventOwnFundsMinor,
    postEventRatio: coverageRatio(postEventOwnFundsMinor, scrMinor),
  };
}
