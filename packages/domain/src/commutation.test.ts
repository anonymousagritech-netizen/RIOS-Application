import { describe, it, expect } from 'vitest';
import { commute, lossPortfolioTransfer } from './commutation.js';
import { money, toMajor } from './money.js';

const usd = (major: number) => money(Math.round(major * 100), 'USD');

describe('commutation.commute', () => {
  it('prices a commutation as PV of outstanding plus a risk load', () => {
    // 1,000,000 outstanding, 4% for 3y => PV = 1,000,000 / 1.04^3 = 888,996.36
    // risk load 10% of PV => price = PV * 1.10
    const r = commute({ outstanding: usd(1_000_000), discountRate: 0.04, meanTermYears: 3, riskLoadPct: 10 });
    expect(r.pvOutstanding.amount).toBeCloseTo(usd(1_000_000).amount / 1.04 ** 3, -1);
    expect(toMajor(r.pvOutstanding)).toBeCloseTo(888996.36, 1);
    expect(r.riskLoad.amount).toBeCloseTo(r.pvOutstanding.amount * 0.10, 0);
    expect(r.commutationPrice.amount).toBe(r.pvOutstanding.amount + r.riskLoad.amount);
  });

  it('gives the cedent a loss and the reinsurer a gain when both carry nominal reserves', () => {
    const r = commute({ outstanding: usd(1_000_000), discountRate: 0.04, meanTermYears: 3, riskLoadPct: 5 });
    // price < nominal (discount dominates a 5% load) => cedent accepts a discount, reinsurer releases it
    expect(r.commutationPrice.amount).toBeLessThan(usd(1_000_000).amount);
    expect(r.cedentGainLoss.amount).toBeLessThan(0);
    expect(r.reinsurerGainLoss.amount).toBeGreaterThan(0);
    // zero-sum between the two parties when carried amounts equal the nominal
    expect(r.cedentGainLoss.amount + r.reinsurerGainLoss.amount).toBe(0);
  });

  it('respects explicit carried amounts and rejects a bad discount rate', () => {
    const r = commute({
      outstanding: usd(500_000), discountRate: 0.03, meanTermYears: 2, riskLoadPct: 8,
      cedentCarriedRecoverable: usd(480_000), reinsurerCarriedReserve: usd(510_000),
    });
    expect(r.cedentGainLoss.amount).toBe(r.commutationPrice.amount - usd(480_000).amount);
    expect(r.reinsurerGainLoss.amount).toBe(usd(510_000).amount - r.commutationPrice.amount);
    expect(() => commute({ outstanding: usd(1), discountRate: -2, meanTermYears: 1, riskLoadPct: 0 })).toThrow(RangeError);
  });
});

describe('commutation.lossPortfolioTransfer', () => {
  it('builds the premium from PV + risk margin + expense load', () => {
    const r = lossPortfolioTransfer({
      reservesTransferred: usd(2_000_000), discountRate: 0.05, meanTermYears: 4, riskMarginPct: 6, expenseLoadPct: 2,
    });
    const pv = r.pvReserves.amount;
    expect(pv).toBeCloseTo(usd(2_000_000).amount / 1.05 ** 4, 0);
    expect(r.riskMargin.amount).toBeCloseTo(pv * 0.06, 0);
    expect(r.expenseLoad.amount).toBeCloseTo(pv * 0.02, 0);
    expect(r.premium.amount).toBe(pv + r.riskMargin.amount + r.expenseLoad.amount);
  });

  it('shows a capital-relief benefit when the premium is below the nominal reserve', () => {
    const r = lossPortfolioTransfer({ reservesTransferred: usd(2_000_000), discountRate: 0.05, meanTermYears: 4, riskMarginPct: 6 });
    expect(r.premium.amount).toBeLessThan(usd(2_000_000).amount);
    expect(r.cedingBenefit.amount).toBeGreaterThan(0);
    expect(r.expenseLoad.amount).toBe(0); // omitted load defaults to zero
  });
});
