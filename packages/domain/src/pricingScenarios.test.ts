import { describe, it, expect } from 'vitest';
import { ratios, scenarioGrid, sensitivity, rateChangeForTarget } from './pricingScenarios.js';
import { MockCatModel, tvarFromEpCurve, RETURN_PERIODS, defaultCatModel } from './catModel.js';

describe('pricing ratios & scenarios', () => {
  it('computes loss / expense / combined ratios and UW result', () => {
    const r = ratios({ premiumMinor: 1_000_000, expectedLossMinor: 600_000, expenseRatio: 0.2 });
    expect(r.lossRatioPct).toBe(60);
    expect(r.expenseRatioPct).toBe(20);
    expect(r.combinedRatioPct).toBe(80);
    expect(r.underwritingResultMinor).toBe(1_000_000 - 600_000 - 200_000); // 200,000 profit
    expect(r.marginPct).toBe(20);
  });

  it('builds a rate × loss scenario grid; more rate → lower combined ratio', () => {
    const grid = scenarioGrid({ basePremiumMinor: 1_000_000, expectedLossMinor: 700_000, expenseRatio: 0.15, rateChanges: [0, 0.2], lossShocks: [1, 1.2] });
    expect(grid).toHaveLength(4);
    const base = grid.find((c) => c.rateChange === 0 && c.lossShock === 1)!;
    const priced = grid.find((c) => c.rateChange === 0.2 && c.lossShock === 1)!;
    expect(priced.combinedRatioPct).toBeLessThan(base.combinedRatioPct);
    const shocked = grid.find((c) => c.rateChange === 0 && c.lossShock === 1.2)!;
    expect(shocked.combinedRatioPct).toBeGreaterThan(base.combinedRatioPct);
  });

  it('sensitivity varies one driver at a time', () => {
    const s = sensitivity({ basePremiumMinor: 1_000_000, expectedLossMinor: 600_000, rateChanges: [-0.1, 0, 0.1], lossShocks: [0.9, 1, 1.1] });
    expect(s.rate).toHaveLength(3);
    expect(s.loss).toHaveLength(3);
    expect(s.rate[0]!.combinedRatioPct).toBeGreaterThan(s.rate[2]!.combinedRatioPct);
  });

  it('solves the rate change needed for a target combined ratio', () => {
    const rc = rateChangeForTarget({ basePremiumMinor: 1_000_000, expectedLossMinor: 700_000, expenseRatio: 0.15, targetCombinedPct: 95 });
    // need premium so that 700k/premium + 0.15 = 0.95 → premium = 875k → rate change -12.5%
    expect(rc).toBeCloseTo(-0.125, 2);
  });
});

describe('CAT model adapter', () => {
  it('mock provider returns AAL, a rising PML curve and an EP curve', () => {
    const res = new MockCatModel().run({ aggregateExposureMinor: 100_000_000, peril: 'HURRICANE', region: 'US-FL' });
    expect(res.provider).toContain('Mock');
    expect(res.aalMinor).toBeGreaterThan(0);
    expect(res.aalMinor).toBeLessThan(100_000_000);
    // PML rises with return period and never exceeds exposure
    for (let i = 1; i < RETURN_PERIODS.length; i++) {
      const lo = res.pmlMinor[RETURN_PERIODS[i - 1]!]!;
      const hi = res.pmlMinor[RETURN_PERIODS[i]!]!;
      expect(hi).toBeGreaterThanOrEqual(lo);
      expect(hi).toBeLessThanOrEqual(100_000_000);
    }
    expect(res.epCurve).toHaveLength(RETURN_PERIODS.length);
    expect(res.epCurve[0]!.exceedanceProb).toBeCloseTo(0.1, 5); // 1/10
  });

  it('exposes a default provider and TVaR from the EP curve', () => {
    const res = defaultCatModel.run({ aggregateExposureMinor: 50_000_000, peril: 'EARTHQUAKE' });
    const tvar99 = tvarFromEpCurve(res.epCurve, 0.99);
    expect(tvar99).toBeGreaterThan(0);
    expect(tvar99).toBeLessThanOrEqual(50_000_000);
  });
});
