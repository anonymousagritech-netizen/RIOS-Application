import { describe, it, expect } from 'vitest';
import { money, fromMajor } from '../src/money.js';
import {
  quotaShareCession,
  surplusCession,
  commissions,
  profitCommission,
  slidingScaleCommissionPct,
  proportionalAccountBalance,
} from '../src/proportional.js';

describe('quota share cession', () => {
  it('cedes the agreed share and retains the rest', () => {
    const gross = fromMajor(1_000_000, 'USD');
    const r = quotaShareCession(gross, { cededShare: 0.3 });
    expect(r.cededPremium.amount).toBe(fromMajor(300_000, 'USD').amount);
    expect(r.retainedPremium.amount).toBe(fromMajor(700_000, 'USD').amount);
  });

  it('rejects out-of-range shares', () => {
    expect(() => quotaShareCession(money(100, 'USD'), { cededShare: 1.5 })).toThrow();
  });
});

describe('surplus cession', () => {
  it('cedes the surplus above retention capped by capacity', () => {
    // Retention 1m, 9 lines = 9m capacity. Risk 6m -> surplus 5m ceded.
    const r = surplusCession(6_000_000, fromMajor(60_000, 'USD'), {
      retentionLine: 1_000_000,
      numberOfLines: 9,
    });
    expect(r.cededShare).toBeCloseTo(5 / 6);
    expect(r.cededPremium.amount).toBe(fromMajor(50_000, 'USD').amount);
  });

  it('caps ceding at treaty capacity', () => {
    // Risk 20m, retention 1m, 9 lines (9m capacity) -> cede 9m of 20m.
    const r = surplusCession(20_000_000, fromMajor(100_000, 'USD'), {
      retentionLine: 1_000_000,
      numberOfLines: 9,
    });
    expect(r.cededShare).toBeCloseTo(9 / 20);
  });
});

describe('commissions', () => {
  it('computes the commission stack on ceded premium', () => {
    const ceded = fromMajor(300_000, 'USD');
    const r = commissions(ceded, { cedingCommissionPct: 25, overridingCommissionPct: 2.5, brokeragePct: 1 });
    expect(r.cedingCommission.amount).toBe(fromMajor(75_000, 'USD').amount);
    expect(r.overridingCommission.amount).toBe(fromMajor(7_500, 'USD').amount);
    expect(r.brokerage.amount).toBe(fromMajor(3_000, 'USD').amount);
    expect(r.totalCommission.amount).toBe(fromMajor(85_500, 'USD').amount);
  });
});

describe('profit commission', () => {
  it('pays PC on a profitable account with no carry-forward', () => {
    // Ceded 1,000,000; commission 250,000; expenses 5% = 50,000; losses 400,000.
    // profit = 1,000,000 - 250,000 - 50,000 - 400,000 = 300,000; PC @20% = 60,000.
    const r = profitCommission(
      {
        cededPremium: fromMajor(1_000_000, 'USD'),
        commissionPaid: fromMajor(250_000, 'USD'),
        incurredLosses: fromMajor(400_000, 'USD'),
      },
      { ratePct: 20, allowableExpensesPct: 5 },
    );
    expect(r.profit.amount).toBe(fromMajor(300_000, 'USD').amount);
    expect(r.profitCommission.amount).toBe(fromMajor(60_000, 'USD').amount);
    expect(r.lossCarriedForward.amount).toBe(0);
  });

  it('carries a deficit forward when the account is unprofitable', () => {
    // losses 800,000 -> profit = 1,000,000 - 250,000 - 50,000 - 800,000 = -100,000.
    const r = profitCommission(
      {
        cededPremium: fromMajor(1_000_000, 'USD'),
        commissionPaid: fromMajor(250_000, 'USD'),
        incurredLosses: fromMajor(800_000, 'USD'),
      },
      { ratePct: 20, allowableExpensesPct: 5 },
    );
    expect(r.profitCommission.amount).toBe(0);
    expect(r.lossCarriedForward.amount).toBe(fromMajor(100_000, 'USD').amount);
  });

  it('absorbs a prior-year deficit before paying PC', () => {
    // Same profitable year but with 250,000 brought forward: 300,000 - 250,000 = 50,000 @20% = 10,000.
    const r = profitCommission(
      {
        cededPremium: fromMajor(1_000_000, 'USD'),
        commissionPaid: fromMajor(250_000, 'USD'),
        incurredLosses: fromMajor(400_000, 'USD'),
      },
      { ratePct: 20, allowableExpensesPct: 5, lossCarriedForward: fromMajor(250_000, 'USD') },
    );
    expect(r.profit.amount).toBe(fromMajor(50_000, 'USD').amount);
    expect(r.profitCommission.amount).toBe(fromMajor(10_000, 'USD').amount);
  });
});

describe('sliding-scale commission', () => {
  const terms = {
    bands: [
      { lossRatioFrom: 0.4, commissionPct: 35 },
      { lossRatioFrom: 0.6, commissionPct: 25 },
      { lossRatioFrom: 0.8, commissionPct: 15 },
    ],
    provisionalPct: 25,
    minPct: 15,
    maxPct: 35,
  };

  it('returns the max commission at low loss ratios', () => {
    expect(slidingScaleCommissionPct(0.3, terms)).toBe(35);
  });

  it('interpolates between bands', () => {
    // halfway between 0.4 (35%) and 0.6 (25%) -> 30%
    expect(slidingScaleCommissionPct(0.5, terms)).toBeCloseTo(30);
  });

  it('clamps at the minimum for high loss ratios', () => {
    expect(slidingScaleCommissionPct(0.95, terms)).toBe(15);
  });
});

describe('proportional account balance', () => {
  it('nets premium less commission less losses', () => {
    const balance = proportionalAccountBalance({
      cededPremium: fromMajor(300_000, 'USD'),
      totalCommission: fromMajor(85_500, 'USD'),
      cededLosses: fromMajor(120_000, 'USD'),
    });
    expect(balance.amount).toBe(fromMajor(94_500, 'USD').amount);
  });
});
