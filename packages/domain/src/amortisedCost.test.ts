import { describe, it, expect } from 'vitest';
import { effectivePeriodRate, amortisedCostSchedule } from './treasury.js';

describe('treasury.effectivePeriodRate', () => {
  it('equals the coupon rate for a par bond', () => {
    // 5% annual coupon, 3y, bought at par 1,000,000 => EIR = 5%
    const r = effectivePeriodRate(1_000_000, 1_000_000, 50_000, 3);
    expect(r).toBeCloseTo(0.05, 4);
  });

  it('exceeds the coupon for a discount bond', () => {
    const r = effectivePeriodRate(950_000, 1_000_000, 50_000, 3);
    expect(r).toBeGreaterThan(0.05);
  });
});

describe('treasury.amortisedCostSchedule', () => {
  it('holds carrying at par for a par bond (no amortisation)', () => {
    const s = amortisedCostSchedule({ priceMinor: 1_000_000, faceMinor: 1_000_000, couponRate: 0.05, periods: 3 });
    expect(s.effectiveAnnualYield).toBeCloseTo(0.05, 4);
    s.periods.forEach((p) => expect(p.closingMinor).toBe(1_000_000));
    expect(s.periods[0]!.amortisationMinor).toBe(0);
  });

  it('amortises a discount up to par by maturity (income exceeds coupon)', () => {
    const s = amortisedCostSchedule({ priceMinor: 950_000, faceMinor: 1_000_000, couponRate: 0.05, periods: 3 });
    expect(s.periods[s.periods.length - 1]!.closingMinor).toBe(1_000_000); // redeems at par
    expect(s.periods[0]!.interestIncomeMinor).toBeGreaterThan(s.periods[0]!.couponMinor);
    const totalAmort = s.periods.reduce((a, p) => a + p.amortisationMinor, 0);
    expect(totalAmort).toBe(50_000); // face - price
  });

  it('amortises a premium down to par by maturity (income below coupon)', () => {
    const s = amortisedCostSchedule({ priceMinor: 1_050_000, faceMinor: 1_000_000, couponRate: 0.06, periods: 4 });
    expect(s.periods[s.periods.length - 1]!.closingMinor).toBe(1_000_000);
    expect(s.periods[0]!.interestIncomeMinor).toBeLessThan(s.periods[0]!.couponMinor);
    const totalAmort = s.periods.reduce((a, p) => a + p.amortisationMinor, 0);
    expect(totalAmort).toBe(-50_000); // premium written off
  });

  it('supports semi-annual coupons', () => {
    const s = amortisedCostSchedule({ priceMinor: 1_000_000, faceMinor: 1_000_000, couponRate: 0.04, periods: 4, frequency: 2 });
    expect(s.periods[0]!.couponMinor).toBe(20_000); // 4% / 2 * face
    expect(s.effectivePeriodRate).toBeCloseTo(0.02, 4);
  });
});
