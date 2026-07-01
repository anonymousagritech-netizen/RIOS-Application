import { describe, it, expect } from 'vitest';
import { swingRatedPremium } from './rating.js';
import { slidingScaleInterpolated, type SlidingScaleBand } from './commission.js';
import { money, toMajor } from './money.js';

const usd = (major: number) => money(Math.round(major * 100), 'USD');

describe('rating.swingRatedPremium', () => {
  const base = {
    subjectPremium: usd(10_000_000),
    provisionalRatePct: 10,
    lossConversionFactor: 1.25,
    minRatePct: 5,
    maxRatePct: 15,
  };

  it('retro-rates the premium from actual losses within the collar', () => {
    // losses 800k on 10m subject => burn 8% x 1.25 = 10% => adjusted == provisional
    const r = swingRatedPremium({ ...base, incurredLosses: usd(800_000) });
    expect(r.burnRatePct).toBeCloseTo(10, 3);
    expect(r.adjustedRatePct).toBeCloseTo(10, 3);
    expect(toMajor(r.provisionalPremium)).toBe(1_000_000);
    expect(r.adjustmentPremium.amount).toBe(0);
    expect(r.collared).toBe(false);
  });

  it('charges additional premium when losses push the rate up, capped at the maximum', () => {
    // losses 2m => burn 20% x 1.25 = 25% -> capped at 15%
    const r = swingRatedPremium({ ...base, incurredLosses: usd(2_000_000) });
    expect(r.burnRatePct).toBeCloseTo(25, 3);
    expect(r.adjustedRatePct).toBe(15);
    expect(toMajor(r.adjustedPremium)).toBe(1_500_000);
    expect(toMajor(r.adjustmentPremium)).toBe(500_000); // additional premium
    expect(r.collared).toBe(true);
  });

  it('returns premium when losses are low, floored at the minimum', () => {
    // losses 100k => burn 1% x 1.25 = 1.25% -> floored at 5%
    const r = swingRatedPremium({ ...base, incurredLosses: usd(100_000) });
    expect(r.adjustedRatePct).toBe(5);
    expect(toMajor(r.adjustmentPremium)).toBe(-500_000); // return premium
    expect(r.collared).toBe(true);
  });

  it('rejects an inverted collar', () => {
    expect(() => swingRatedPremium({ ...base, minRatePct: 20, maxRatePct: 10, incurredLosses: usd(1) })).toThrow(RangeError);
  });
});

describe('commission.slidingScaleInterpolated', () => {
  const bands: SlidingScaleBand[] = [
    { lossRatioUpTo: 0.5, commissionRate: 0.35 },
    { lossRatioUpTo: 0.7, commissionRate: 0.25 },
  ];

  it('interpolates the commission rate linearly between band knots', () => {
    // LR 0.6 is halfway between 0.5 (35%) and 0.7 (25%) => 30%
    const r = slidingScaleInterpolated({
      premiumMinor: usd(1000), incurredLossMinor: usd(600), provisionalRate: 0.30,
      minRate: 0.20, maxRate: 0.40, bands,
    });
    expect(r.effectiveRate).toBeCloseTo(0.30, 6);
    expect(toMajor(r.finalCommission)).toBeCloseTo(300, 2);
    expect(r.adjustment.amount).toBe(0);
  });

  it('holds the boundary rates outside the knot range and collars to [min,max]', () => {
    const low = slidingScaleInterpolated({
      premiumMinor: usd(1000), incurredLossMinor: usd(300), provisionalRate: 0.30, minRate: 0.20, maxRate: 0.40, bands,
    });
    expect(low.effectiveRate).toBeCloseTo(0.35, 6); // LR 0.3 below first knot => 35%
    const high = slidingScaleInterpolated({
      premiumMinor: usd(1000), incurredLossMinor: usd(900), provisionalRate: 0.30, minRate: 0.20, maxRate: 0.40, bands,
    });
    expect(high.effectiveRate).toBeCloseTo(0.25, 6); // LR 0.9 above last knot => 25%
  });

  it('requires band knots', () => {
    expect(() => slidingScaleInterpolated({
      premiumMinor: usd(1000), incurredLossMinor: usd(600), provisionalRate: 0.30, minRate: 0.20, maxRate: 0.40,
    })).toThrow(RangeError);
  });
});
