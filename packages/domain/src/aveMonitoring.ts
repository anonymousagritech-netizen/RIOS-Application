/**
 * Actual-vs-expected (AvE) reserve monitoring - pure, deterministic, framework-free.
 *
 * After an IBNR recommendation is approved and booked, the reserving actuary
 * tracks how actual loss emergence compares with what the study expected. Each
 * monitoring period records an actual emergence amount; this helper folds the
 * observations into a cumulative deviation against the expected amount. Money is
 * integer minor units. No I/O; the server feeds it rows from ibnr_ave.
 */

export interface AveSummary {
  /** Number of monitoring observations folded in. */
  periods: number;
  /** Sum of actual emergence recorded so far (minor units). */
  cumulativeActualMinor: number;
  /** The study's expected emergence (minor units) the actuals are tracked against. */
  expectedMinor: number;
  /** cumulativeActual - expected; positive = emerging worse than the study expected. */
  cumulativeDeviationMinor: number;
  /** Deviation as a percentage of expected, 1 decimal place; 0 when expected is 0. */
  deviationPct: number;
}

/**
 * Fold per-period actual emergence into a cumulative actual-vs-expected view
 * against a single expected amount (e.g. a booked IBNR recommendation).
 */
export function actualVsExpected(expectedMinor: number, actualsMinor: number[]): AveSummary {
  const cumulativeActual = actualsMinor.reduce((a, b) => a + Math.round(b), 0);
  const deviation = cumulativeActual - Math.round(expectedMinor);
  const pct = expectedMinor !== 0 ? Math.round((deviation / expectedMinor) * 1000) / 10 : 0;
  return {
    periods: actualsMinor.length,
    cumulativeActualMinor: cumulativeActual,
    expectedMinor: Math.round(expectedMinor),
    cumulativeDeviationMinor: deviation,
    deviationPct: pct,
  };
}
