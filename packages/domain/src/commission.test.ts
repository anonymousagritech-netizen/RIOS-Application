import { describe, it, expect } from 'vitest';
import { fromMajor } from './money.js';
import {
  flatCedingCommission,
  slidingScaleCommission,
  profitCommission,
  overridingCommission,
  brokerage,
} from './commission.js';

describe('flatCedingCommission', () => {
  it('applies a flat ppm rate to the premium', () => {
    // 1,000,000 premium @ 250,000 ppm (25%) -> 250,000 commission.
    const r = flatCedingCommission(fromMajor(1_000_000, 'USD'), 250_000);
    expect(r.amount).toBe(fromMajor(250_000, 'USD').amount);
  });

  it('handles a fractional-percent ppm rate', () => {
    // 1,000,000 premium @ 275,000 ppm (27.5%) -> 275,000 commission.
    const r = flatCedingCommission(fromMajor(1_000_000, 'USD'), 275_000);
    expect(r.amount).toBe(fromMajor(275_000, 'USD').amount);
  });

  it('returns zero commission on zero premium', () => {
    // 0 premium @ 250,000 ppm -> 0.
    expect(flatCedingCommission(fromMajor(0, 'USD'), 250_000).amount).toBe(0);
  });

  it('rejects a negative rate', () => {
    expect(() => flatCedingCommission(fromMajor(1_000, 'USD'), -1)).toThrow();
  });
});

describe('slidingScaleCommission (bands)', () => {
  // Bands: LR <= 50% -> 35%, LR <= 60% -> 30%, LR <= 80% -> 20%. min 15%, max 35%.
  const bands = [
    { lossRatioUpTo: 0.5, commissionRate: 0.35 },
    { lossRatioUpTo: 0.6, commissionRate: 0.3 },
    { lossRatioUpTo: 0.8, commissionRate: 0.2 },
  ];
  const base = {
    premiumMinor: fromMajor(1_000_000, 'USD'),
    provisionalRate: 0.25,
    minRate: 0.15,
    maxRate: 0.35,
    slideRatePerLossRatioPoint: 0, // unused when bands present
    bands,
  };

  it('picks the band for a mid loss ratio', () => {
    // losses 600,000 / premium 1,000,000 = 60% LR -> falls in "<=60%" band = 30%.
    // final commission = 1,000,000 * 30% = 300,000; provisional = 25% = 250,000; adj = +50,000.
    const r = slidingScaleCommission({ ...base, incurredLossMinor: fromMajor(600_000, 'USD') });
    expect(r.lossRatio).toBeCloseTo(0.6);
    expect(r.effectiveRate).toBeCloseTo(0.3);
    expect(r.finalCommission.amount).toBe(fromMajor(300_000, 'USD').amount);
    expect(r.provisionalCommission.amount).toBe(fromMajor(250_000, 'USD').amount);
    expect(r.adjustment.amount).toBe(fromMajor(50_000, 'USD').amount);
  });

  it('uses max rate below the first band', () => {
    // losses 400,000 = 40% LR, below first band (<=50%) -> max rate 35% -> 350,000.
    const r = slidingScaleCommission({ ...base, incurredLossMinor: fromMajor(400_000, 'USD') });
    expect(r.effectiveRate).toBeCloseTo(0.35);
    expect(r.finalCommission.amount).toBe(fromMajor(350_000, 'USD').amount);
  });

  it('uses min rate above the last band', () => {
    // losses 950,000 = 95% LR, above last band (<=80%) -> min rate 15% -> 150,000.
    const r = slidingScaleCommission({ ...base, incurredLossMinor: fromMajor(950_000, 'USD') });
    expect(r.effectiveRate).toBeCloseTo(0.15);
    expect(r.finalCommission.amount).toBe(fromMajor(150_000, 'USD').amount);
  });

  it('treats a loss ratio exactly on a band boundary as inside that band', () => {
    // losses 500,000 = 50% LR, exactly on the <=50% boundary -> 35% -> 350,000.
    const r = slidingScaleCommission({ ...base, incurredLossMinor: fromMajor(500_000, 'USD') });
    expect(r.effectiveRate).toBeCloseTo(0.35);
    expect(r.finalCommission.amount).toBe(fromMajor(350_000, 'USD').amount);
  });
});

describe('slidingScaleCommission (linear)', () => {
  const base = {
    premiumMinor: fromMajor(1_000_000, 'USD'),
    provisionalRate: 0.25,
    minRate: 0.15,
    maxRate: 0.35,
    // commission drops 0.5% per 1 LR-point, starting from max 35% at 0% LR.
    slideRatePerLossRatioPoint: 0.5,
  };

  it('slides the rate down linearly with the loss ratio', () => {
    // 60% LR -> 35% - 0.5% * 60 = 35% - 30% = 5%, clamped up to min 15% -> 150,000.
    const r = slidingScaleCommission({ ...base, incurredLossMinor: fromMajor(600_000, 'USD') });
    expect(r.lossRatio).toBeCloseTo(0.6);
    expect(r.effectiveRate).toBeCloseTo(0.15); // clamped to min
    expect(r.finalCommission.amount).toBe(fromMajor(150_000, 'USD').amount);
  });

  it('slides within the band without clamping', () => {
    // 20% LR -> 35% - 0.5% * 20 = 35% - 10% = 25% -> 250,000.
    const r = slidingScaleCommission({ ...base, incurredLossMinor: fromMajor(200_000, 'USD') });
    expect(r.effectiveRate).toBeCloseTo(0.25);
    expect(r.finalCommission.amount).toBe(fromMajor(250_000, 'USD').amount);
  });

  it('uses max rate at a zero loss ratio', () => {
    // 0 losses -> LR 0 -> 35% (max) -> 350,000.
    const r = slidingScaleCommission({ ...base, incurredLossMinor: fromMajor(0, 'USD') });
    expect(r.effectiveRate).toBeCloseTo(0.35);
    expect(r.finalCommission.amount).toBe(fromMajor(350_000, 'USD').amount);
  });

  it('treats zero premium as a zero loss ratio (no divide-by-zero)', () => {
    // premium 0, losses 100,000 -> LR forced to 0 -> max rate 35% -> commission 0 on 0 premium.
    const r = slidingScaleCommission({
      ...base,
      premiumMinor: fromMajor(0, 'USD'),
      incurredLossMinor: fromMajor(100_000, 'USD'),
    });
    expect(r.lossRatio).toBe(0);
    expect(r.finalCommission.amount).toBe(0);
  });
});

describe('profitCommission', () => {
  it('pays PC on a profitable account with no prior deficit', () => {
    // premium 1,000,000; losses 400,000; expenses 5% = 50,000; margin 10% = 100,000.
    // profit = 1,000,000 - 400,000 - 50,000 - 100,000 = 450,000; PC @20% = 90,000.
    const r = profitCommission({
      premiumMinor: fromMajor(1_000_000, 'USD'),
      lossesMinor: fromMajor(400_000, 'USD'),
      expenseAllowanceRate: 0.05,
      reinsurerMarginRate: 0.1,
      profitCommissionRate: 0.2,
    });
    expect(r.profitMinor.amount).toBe(fromMajor(450_000, 'USD').amount);
    expect(r.profitCommissionMinor.amount).toBe(fromMajor(90_000, 'USD').amount);
    expect(r.carryForwardDeficitMinor.amount).toBe(0);
  });

  it('absorbs a prior deficit before paying PC', () => {
    // Same as above but 200,000 prior deficit: profit = 450,000 - 200,000 = 250,000; PC @20% = 50,000.
    const r = profitCommission({
      premiumMinor: fromMajor(1_000_000, 'USD'),
      lossesMinor: fromMajor(400_000, 'USD'),
      expenseAllowanceRate: 0.05,
      reinsurerMarginRate: 0.1,
      profitCommissionRate: 0.2,
      priorDeficitMinor: fromMajor(200_000, 'USD'),
    });
    expect(r.profitMinor.amount).toBe(fromMajor(250_000, 'USD').amount);
    expect(r.profitCommissionMinor.amount).toBe(fromMajor(50_000, 'USD').amount);
    expect(r.carryForwardDeficitMinor.amount).toBe(0);
  });

  it('carries a deficit forward when the account is unprofitable', () => {
    // premium 1,000,000; losses 900,000; expenses 50,000; margin 100,000.
    // profit = 1,000,000 - 900,000 - 50,000 - 100,000 = -50,000 -> PC 0, carry forward 50,000.
    const r = profitCommission({
      premiumMinor: fromMajor(1_000_000, 'USD'),
      lossesMinor: fromMajor(900_000, 'USD'),
      expenseAllowanceRate: 0.05,
      reinsurerMarginRate: 0.1,
      profitCommissionRate: 0.2,
    });
    expect(r.profitMinor.amount).toBe(fromMajor(-50_000, 'USD').amount);
    expect(r.profitCommissionMinor.amount).toBe(0);
    expect(r.carryForwardDeficitMinor.amount).toBe(fromMajor(50_000, 'USD').amount);
  });

  it('pays no PC and carries nothing at exactly break-even', () => {
    // premium 1,000,000; losses 850,000; expenses 50,000; margin 100,000 -> profit 0.
    const r = profitCommission({
      premiumMinor: fromMajor(1_000_000, 'USD'),
      lossesMinor: fromMajor(850_000, 'USD'),
      expenseAllowanceRate: 0.05,
      reinsurerMarginRate: 0.1,
      profitCommissionRate: 0.2,
    });
    expect(r.profitMinor.amount).toBe(0);
    expect(r.profitCommissionMinor.amount).toBe(0);
    expect(r.carryForwardDeficitMinor.amount).toBe(0);
  });
});

describe('overridingCommission', () => {
  it('applies the override rate to ceded premium', () => {
    // 300,000 ceded premium @ 2.5% override -> 7,500.
    const r = overridingCommission(fromMajor(300_000, 'USD'), 0.025);
    expect(r.amount).toBe(fromMajor(7_500, 'USD').amount);
  });
});

describe('brokerage', () => {
  it('applies the brokerage rate to premium', () => {
    // 300,000 premium @ 1% brokerage -> 3,000.
    const r = brokerage(fromMajor(300_000, 'USD'), 0.01);
    expect(r.amount).toBe(fromMajor(3_000, 'USD').amount);
  });

  it('is zero on zero premium', () => {
    // 0 premium @ 1% -> 0.
    expect(brokerage(fromMajor(0, 'USD'), 0.01).amount).toBe(0);
  });
});
