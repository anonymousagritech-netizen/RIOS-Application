import { describe, it, expect } from 'vitest';
import { projectOrsa, stressOrsa, type OrsaProjectionInput } from './orsa.js';

const base: OrsaProjectionInput = {
  openingOwnFundsMinor: 100_000_000, // 1,000,000.00
  appetiteRatio: 1.3,
  years: [
    { resultMinor: 10_000_000, dividendMinor: 5_000_000, scrMinor: 70_000_000 },
    { resultMinor: 10_000_000, dividendMinor: 5_000_000, scrMinor: 72_000_000 },
    { resultMinor: 10_000_000, dividendMinor: 5_000_000, scrMinor: 74_000_000 },
  ],
};

describe('orsa.projectOrsa', () => {
  it('rolls own funds forward and computes ratio, surplus and breach flags', () => {
    const r = projectOrsa(base);
    // Y1 own funds = 100m + 10m - 5m = 105m; ratio = 105/70 = 1.5
    expect(r.years[0]!.ownFundsMinor).toBe(105_000_000);
    expect(r.years[0]!.solvencyRatio).toBeCloseTo(1.5, 3);
    expect(r.years[0]!.surplusMinor).toBe(35_000_000);
    expect(r.years[0]!.scrBreach).toBe(false);
    // closing own funds after 3 years
    expect(r.closingOwnFundsMinor).toBe(115_000_000);
    expect(r.firstBreachYear).toBeNull();
  });

  it('flags an appetite breach without an SCR breach', () => {
    const r = projectOrsa({
      openingOwnFundsMinor: 80_000_000,
      appetiteRatio: 1.3,
      years: [{ resultMinor: 0, scrMinor: 70_000_000 }], // ratio 1.14: above 100% but below 130%
    });
    expect(r.years[0]!.scrBreach).toBe(false);
    expect(r.years[0]!.appetiteBreach).toBe(true);
  });

  it('detects the first SCR breach year', () => {
    const r = projectOrsa({
      openingOwnFundsMinor: 100_000_000,
      years: [
        { resultMinor: -20_000_000, scrMinor: 70_000_000 }, // 80m vs 70m -> ok
        { resultMinor: -20_000_000, scrMinor: 70_000_000 }, // 60m vs 70m -> breach
      ],
    });
    expect(r.firstBreachYear).toBe(2);
    expect(r.years[1]!.scrBreach).toBe(true);
    expect(r.minSolvencyRatio).toBeCloseTo(60 / 70, 3);
  });
});

describe('orsa.stressOrsa', () => {
  it('shocks opening own funds, results and SCR and can trigger a breach', () => {
    const stressed = stressOrsa(base, { openingLossMinor: 40_000_000, ownFundsShock: -1, scrShock: 0.25 });
    // opening 60m; result shocked to 0 each year, dividends still paid (-5m/yr); SCR +25%
    // Y1 own funds = 60m + 0 - 5m = 55m vs 70m*1.25=87.5m -> breach
    expect(stressed.years[0]!.ownFundsMinor).toBe(55_000_000);
    expect(stressed.years[0]!.scrMinor).toBe(87_500_000);
    expect(stressed.firstBreachYear).toBe(1);
    expect(stressed.minSolvencyRatio).toBeLessThan(1);
  });

  it('leaves the base case unchanged (no mutation)', () => {
    stressOrsa(base, { scrShock: 0.5 });
    expect(base.years[0]!.scrMinor).toBe(70_000_000);
    expect(base.openingOwnFundsMinor).toBe(100_000_000);
  });
});
