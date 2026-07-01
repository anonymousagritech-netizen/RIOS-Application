import { describe, it, expect } from 'vitest';
import { riskMargin, eligibleOwnFunds } from './solvency2.js';

describe('solvency2.riskMargin', () => {
  it('applies the 6% cost of capital over undiscounted projected SCRs', () => {
    // rate 0 => RM = 0.06 * (100 + 80 + 60) = 14.4
    expect(riskMargin([100, 80, 60])).toBeCloseTo(14.4, 6);
  });

  it('discounts future SCRs at the risk-free rate', () => {
    // 0.06 * (100/1.02 + 80/1.02^2) = 0.06 * (98.039 + 76.893) = 10.496
    expect(riskMargin([100, 80], 0.06, 0.02)).toBeCloseTo(10.496, 3);
  });

  it('accepts a spot-rate vector and rejects negative SCRs', () => {
    const rm = riskMargin([100, 100], 0.06, [0.01, 0.03]);
    expect(rm).toBeCloseTo(0.06 * (100 / 1.01 + 100 / 1.03 ** 2), 6);
    expect(() => riskMargin([-1])).toThrow(RangeError);
  });
});

describe('solvency2.eligibleOwnFunds', () => {
  it('caps Tier 3 at 15% and Tier 2+3 at 50% of SCR', () => {
    // SCR 1000: t3 capped to 150, lower (t2 200 + t3 150 = 350) under 500 cap
    const r = eligibleOwnFunds({ tier1: 800, tier2: 200, tier3: 300 }, 1000, 400);
    expect(r.eligibleForScr).toBe(800 + 200 + 150); // t3 capped 300 -> 150
    expect(r.scrRatio).toBeCloseTo(1.15, 6);
    expect(r.breaches).toHaveLength(0);
  });

  it('caps the Tier 2+3 lower layer at 50% of SCR', () => {
    // t2 400 + t3(cap 150) = 550 > 500 -> lower capped at 500
    const r = eligibleOwnFunds({ tier1: 600, tier2: 400, tier3: 300 }, 1000, 400);
    expect(r.eligibleForScr).toBe(600 + 500);
  });

  it('flags a Tier 1 shortfall against the SCR', () => {
    const r = eligibleOwnFunds({ tier1: 400, tier2: 100, tier3: 0 }, 1000, 400);
    expect(r.breaches).toContain('Tier 1 below 50% of SCR');
    expect(r.breaches).toContain('Eligible own funds do not cover the SCR'); // 500 < 1000
  });

  it('excludes Tier 3 from MCR cover and caps Tier 2 at 20% of MCR', () => {
    // MCR 400: t2 admitted min(200, 80)=80, t3 excluded
    const r = eligibleOwnFunds({ tier1: 500, tier2: 200, tier3: 300 }, 1000, 400);
    expect(r.eligibleForMcr).toBe(500 + 80);
    expect(r.mcrRatio).toBeCloseTo((500 + 80) / 400, 6);
    expect(() => eligibleOwnFunds({ tier1: 1, tier2: 0, tier3: 0 }, 0, 100)).toThrow(RangeError);
  });
});
