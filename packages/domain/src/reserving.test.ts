import { describe, it, expect } from 'vitest';
import {
  developmentFactors, projectUltimate, cumulativeDevelopmentFactors, percentDeveloped,
  bornhuetterFerguson, benktander, reserveComparison,
} from './lossAnalytics.js';

// A simple, fully-developed square-ish triangle for hand-checkable results.
// Ages 0..2; each origin cumulative paid.
const triangle = [
  [1000, 1500, 1800], // origin 0: fully developed
  [1200, 1800],       // origin 1: to age 1
  [900],              // origin 2: to age 0
];

describe('reserving.cumulativeDevelopmentFactors & percentDeveloped', () => {
  const factors = developmentFactors(triangle); // [f0, f1]
  it('builds CDFs to ultimate with 1 at the ultimate age', () => {
    const cdf = cumulativeDevelopmentFactors(factors);
    expect(cdf).toHaveLength(factors.length + 1);
    expect(cdf[cdf.length - 1]).toBe(1);
    // cdf[0] = f0 * f1
    expect(cdf[0]).toBeCloseTo(factors[0]! * factors[1]!, 3);
  });

  it('percent developed is 1/cdf and increases with age', () => {
    const pd = percentDeveloped(factors);
    expect(pd[pd.length - 1]).toBe(1); // fully developed at ultimate
    expect(pd[0]!).toBeLessThan(pd[1]!);
  });
});

describe('reserving.bornhuetterFerguson', () => {
  const factors = developmentFactors(triangle);
  const aPriori = [1800, 2000, 1600]; // plan ultimates

  it('adds only the unreported portion of the a-priori', () => {
    const bf = bornhuetterFerguson(triangle, factors, aPriori);
    const cdf = cumulativeDevelopmentFactors(factors);
    // origin 0 fully developed => BF ultimate == latest (no emergence)
    expect(bf.ultimates[0]).toBe(1800);
    expect(bf.ibnrMinor[0]).toBe(0);
    // origin 2 at age 0 => emergence = aPriori * (1 - 1/cdf0)
    const expectedEmergence = Math.round(1600 * (1 - 1 / cdf[0]!));
    expect(bf.ibnrMinor[2]).toBe(expectedEmergence);
    expect(bf.ultimates[2]).toBe(900 + expectedEmergence);
  });

  it('total IBNR equals the sum of per-origin IBNR', () => {
    const bf = bornhuetterFerguson(triangle, factors, aPriori);
    expect(bf.totalIbnrMinor).toBe(bf.ibnrMinor.reduce((a, b) => a + b, 0));
    expect(bf.totalUltimateMinor).toBe(bf.ultimates.reduce((a, b) => a + b, 0));
  });
});

describe('reserving method comparison', () => {
  const factors = developmentFactors(triangle);
  const aPriori = [1800, 2100, 1700];

  it('Benktander sits between chain-ladder and BF for the immature origin', () => {
    const cl = projectUltimate(triangle, factors).ultimates[2]!;
    const bf = bornhuetterFerguson(triangle, factors, aPriori).ultimates[2]!;
    const gb = benktander(triangle, factors, aPriori).ultimates[2]!;
    const lo = Math.min(cl, bf), hi = Math.max(cl, bf);
    expect(gb).toBeGreaterThanOrEqual(lo - 1);
    expect(gb).toBeLessThanOrEqual(hi + 1);
  });

  it('reserveComparison returns all four methods and the expected-loss equals the a-priori sum', () => {
    const cmp = reserveComparison(triangle, factors, aPriori);
    expect(cmp.expectedLoss).toBe(1800 + 2100 + 1700);
    expect(cmp.chainLadder).toBeGreaterThan(0);
    expect(cmp.bornhuetterFerguson).toBeGreaterThan(0);
    expect(cmp.benktander).toBeGreaterThan(0);
  });
});
