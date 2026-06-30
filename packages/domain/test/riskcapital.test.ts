import { describe, it, expect } from 'vitest';
import {
  valueAtRisk,
  tailValueAtRisk,
  diversifiedCapital,
  coverageRatio,
  capitalAdequacy,
  evaluateScenario,
} from '../src/riskcapital.js';

const losses = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

describe('tail-risk metrics', () => {
  it('computes empirical VaR at a confidence level', () => {
    expect(valueAtRisk(losses, 0.8)).toBe(900);  // 2nd worst of 10
    expect(valueAtRisk(losses, 0.9)).toBe(1000); // worst of 10
    expect(valueAtRisk([], 0.99)).toBe(0);
  });

  it('computes Tail-VaR as the mean beyond the threshold', () => {
    expect(tailValueAtRisk(losses, 0.8)).toBe(950); // (1000+900)/2
    expect(tailValueAtRisk(losses, 0.7)).toBe(Math.round((1000 + 900 + 800) / 3)); // worst 3
  });
});

describe('capital aggregation & adequacy', () => {
  it('aggregates standalone charges with a correlation matrix', () => {
    // Independent (identity): √(300² + 400²) = 500
    expect(diversifiedCapital([300, 400])).toBe(500);
    // Perfectly correlated (all ones): 300 + 400 = 700
    expect(diversifiedCapital([300, 400], [[1, 1], [1, 1]])).toBe(700);
    // Partial correlation 0.5
    expect(diversifiedCapital([300, 400], [[1, 0.5], [0.5, 1]]))
      .toBe(Math.round(Math.sqrt(300 * 300 + 400 * 400 + 2 * 0.5 * 300 * 400)));
  });

  it('computes the solvency ratio and adequacy band', () => {
    expect(coverageRatio(1500, 1000)).toBe(1.5);
    expect(coverageRatio(1000, 0)).toBe(Infinity);

    expect(capitalAdequacy(900, 1000).status).toBe('breach');   // 0.9
    expect(capitalAdequacy(1200, 1000).status).toBe('warning'); // 1.2
    expect(capitalAdequacy(1400, 1000).status).toBe('adequate'); // 1.4
    expect(capitalAdequacy(2000, 1000).status).toBe('strong');  // 2.0
    expect(capitalAdequacy(1200, 1000).surplusMinor).toBe(200);
  });
});

describe('disaster scenario evaluation', () => {
  it('nets a scenario by recoveries and projects the post-event ratio', () => {
    const r = evaluateScenario(
      1_000_000,                                   // gross loss
      [{ source: 'treaty', recoveryMinor: 600_000 }, { source: 'retro', recoveryMinor: 150_000 }],
      2_000_000,                                   // own funds
      800_000,                                     // SCR
    );
    expect(r.totalRecoveryMinor).toBe(750_000);
    expect(r.netLossMinor).toBe(250_000);
    expect(r.postEventOwnFundsMinor).toBe(1_750_000);
    expect(r.postEventRatio).toBeCloseTo(1_750_000 / 800_000, 10);
  });

  it('floors recoveries at the gross loss', () => {
    const r = evaluateScenario(500_000, [{ recoveryMinor: 900_000 }], 1_000_000, 500_000);
    expect(r.totalRecoveryMinor).toBe(500_000);
    expect(r.netLossMinor).toBe(0);
  });
});
