import { describe, it, expect } from 'vitest';
import { fdAccruedInterest, mutualFundBookValue } from './treasury.js';

describe('fdAccruedInterest', () => {
  it('returns 0n for 0 days', () => {
    expect(fdAccruedInterest(1_000_000n, 7.5, 0)).toBe(0n);
  });

  it('returns 0n for negative days', () => {
    expect(fdAccruedInterest(1_000_000n, 7.5, -10)).toBe(0n);
  });

  it('returns 0n for zero rate', () => {
    expect(fdAccruedInterest(1_000_000n, 0, 365)).toBe(0n);
  });

  it('returns 0n for negative rate', () => {
    expect(fdAccruedInterest(1_000_000n, -5, 365)).toBe(0n);
  });

  it('calculates simple interest correctly for a full year', () => {
    // 1,000,000 minor @ 7.5% for 365 days = 75,000 minor
    expect(fdAccruedInterest(1_000_000n, 7.5, 365)).toBe(75_000n);
  });

  it('handles partial year', () => {
    // 1,000,000 minor @ 10% for 182 days ≈ 49,863 minor
    const result = fdAccruedInterest(1_000_000n, 10, 182);
    expect(Number(result)).toBeCloseTo(49863, -1);
  });

  it('returns bigint type', () => {
    const result = fdAccruedInterest(500_000n, 5, 180);
    expect(typeof result).toBe('bigint');
  });

  it('rounds to whole minor units', () => {
    // 1n minor @ 1% for 1 day = 1 * 0.01 * (1/365) ≈ 0.000027 → rounds to 0
    expect(fdAccruedInterest(1n, 1, 1)).toBe(0n);
    // Large value: 10,000,000 minor @ 5% for 1 day ≈ 1370 minor
    const r = fdAccruedInterest(10_000_000n, 5, 1);
    expect(Number(r)).toBeCloseTo(1370, 0);
  });
});

describe('mutualFundBookValue', () => {
  it('returns 0n for 0 units', () => {
    expect(mutualFundBookValue(0, 10.50)).toBe(0n);
  });

  it('returns 0n for negative units', () => {
    expect(mutualFundBookValue(-5, 10.50)).toBe(0n);
  });

  it('returns 0n for zero NAV', () => {
    expect(mutualFundBookValue(100, 0)).toBe(0n);
  });

  it('returns 0n for negative NAV', () => {
    expect(mutualFundBookValue(100, -1)).toBe(0n);
  });

  it('calculates book value correctly', () => {
    // 100 units @ 10.50 NAV = 1050.00 major = 105,000 minor
    expect(mutualFundBookValue(100, 10.50)).toBe(105_000n);
  });

  it('handles fractional units', () => {
    // 1.5 units @ 100 NAV = 150.00 major = 15,000 minor
    expect(mutualFundBookValue(1.5, 100)).toBe(15_000n);
  });

  it('returns bigint type', () => {
    const result = mutualFundBookValue(50, 20);
    expect(typeof result).toBe('bigint');
  });

  it('rounds sub-minor amounts', () => {
    // 3 units @ 0.001 NAV = 0.003 major = 0.3 minor → rounds to 0
    expect(mutualFundBookValue(3, 0.001)).toBe(0n);
  });
});
