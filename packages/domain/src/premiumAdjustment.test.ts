import { describe, it, expect } from 'vitest';
import { mdPremiumAdjustment } from './premiumAdjustment.js';
import { money, MoneyError } from './money.js';

const usd = (major: number) => money(Math.round(major * 100), 'USD');

describe('premiumAdjustment.mdPremiumAdjustment', () => {
  it('books additional premium when rate x GNPI exceeds minimum and deposit', () => {
    // 2% x 6,000,000 = 120,000 indicated; minimum 90,000; deposit booked 80,000
    const r = mdPremiumAdjustment({
      actualGnpi: usd(6_000_000),
      premiumRatePct: 2,
      minimumPremium: usd(90_000),
      bookedPremium: usd(80_000),
    });
    expect(r.indicatedPremium.amount).toBe(12_000_000);
    expect(r.finalPremium.amount).toBe(12_000_000);
    expect(r.adjustmentPremium.amount).toBe(4_000_000); // 120,000 - 80,000
    expect(r.minimumApplied).toBe(false);
  });

  it('applies the minimum premium as a floor when GNPI comes in low', () => {
    // 2% x 3,000,000 = 60,000 < minimum 90,000 -> final 90,000
    const r = mdPremiumAdjustment({
      actualGnpi: usd(3_000_000),
      premiumRatePct: 2,
      minimumPremium: usd(90_000),
      bookedPremium: usd(80_000),
    });
    expect(r.indicatedPremium.amount).toBe(6_000_000);
    expect(r.finalPremium.amount).toBe(9_000_000);
    expect(r.adjustmentPremium.amount).toBe(1_000_000); // top up to the minimum
    expect(r.minimumApplied).toBe(true);
  });

  it('produces a return premium (negative) when booked exceeds the final premium', () => {
    // Deposit 120,000 booked but final premium only 90,000 (minimum) -> return 30,000
    const r = mdPremiumAdjustment({
      actualGnpi: usd(3_000_000),
      premiumRatePct: 2,
      minimumPremium: usd(90_000),
      bookedPremium: usd(120_000),
    });
    expect(r.finalPremium.amount).toBe(9_000_000);
    expect(r.adjustmentPremium.amount).toBe(-3_000_000);
  });

  it('is idempotent: re-running with booked including the prior adjustment yields zero', () => {
    const first = mdPremiumAdjustment({
      actualGnpi: usd(6_000_000),
      premiumRatePct: 2,
      minimumPremium: usd(90_000),
      bookedPremium: usd(80_000),
    });
    const bookedAfter = money(first.bookedPremium.amount + first.adjustmentPremium.amount, 'USD');
    const second = mdPremiumAdjustment({
      actualGnpi: usd(6_000_000),
      premiumRatePct: 2,
      minimumPremium: usd(90_000),
      bookedPremium: bookedAfter,
    });
    expect(second.adjustmentPremium.amount).toBe(0);
  });

  it('rounds the rate application once, half-up, on integer minor units', () => {
    // 1.5% x 333.33 = 5.00 (499.995 minor -> 500 half-up)
    const r = mdPremiumAdjustment({
      actualGnpi: money(33_333, 'USD'),
      premiumRatePct: 1.5,
      minimumPremium: money(0, 'USD'),
      bookedPremium: money(0, 'USD'),
    });
    expect(r.indicatedPremium.amount).toBe(500);
  });

  it('handles zero GNPI: final premium is the minimum', () => {
    const r = mdPremiumAdjustment({
      actualGnpi: usd(0),
      premiumRatePct: 2,
      minimumPremium: usd(90_000),
      bookedPremium: usd(80_000),
    });
    expect(r.finalPremium.amount).toBe(9_000_000);
    expect(r.adjustmentPremium.amount).toBe(1_000_000);
    expect(r.minimumApplied).toBe(true);
  });

  it('rejects a negative or non-finite rate and a negative minimum', () => {
    const base = { actualGnpi: usd(1_000), minimumPremium: usd(0), bookedPremium: usd(0) };
    expect(() => mdPremiumAdjustment({ ...base, premiumRatePct: -1 })).toThrow(RangeError);
    expect(() => mdPremiumAdjustment({ ...base, premiumRatePct: Number.NaN })).toThrow(RangeError);
    expect(() =>
      mdPremiumAdjustment({ ...base, premiumRatePct: 1, minimumPremium: money(-1, 'USD') }),
    ).toThrow(RangeError);
  });

  it('throws on cross-currency inputs (must go through FX first)', () => {
    expect(() =>
      mdPremiumAdjustment({
        actualGnpi: usd(1_000),
        premiumRatePct: 2,
        minimumPremium: money(100, 'EUR'),
        bookedPremium: usd(0),
      }),
    ).toThrow(MoneyError);
    expect(() =>
      mdPremiumAdjustment({
        actualGnpi: usd(1_000),
        premiumRatePct: 2,
        minimumPremium: usd(100),
        bookedPremium: money(0, 'EUR'),
      }),
    ).toThrow(MoneyError);
  });
});
