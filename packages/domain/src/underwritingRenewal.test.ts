import { describe, it, expect } from 'vitest';
import { renewalRateChangePct, retentionRatePct, renewalBook } from './underwritingRenewal.js';

const M = (major: number) => major * 100;

describe('underwriting renewals', () => {
  it('computes rate change vs expiring', () => {
    expect(renewalRateChangePct(M(105), M(100))).toBe(5);
    expect(renewalRateChangePct(M(90), M(100))).toBe(-10);
    expect(renewalRateChangePct(M(100), 0)).toBeNull();
  });

  it('computes retention rate', () => {
    expect(retentionRatePct(8, 10)).toBe(80);
    expect(retentionRatePct(0, 0)).toBe(0);
  });

  it('rolls a renewal book into KPIs', () => {
    const book = renewalBook([
      { stage: 'BOUND', expiringPremiumMinor: M(100), renewalPremiumMinor: M(110) },
      { stage: 'BOUND', expiringPremiumMinor: M(200), renewalPremiumMinor: M(210) },
      { stage: 'LAPSED', expiringPremiumMinor: M(50), renewalPremiumMinor: 0 },
      { stage: 'QUOTED', expiringPremiumMinor: M(80), renewalPremiumMinor: M(85) },
    ]);
    expect(book.upForRenewal).toBe(4);
    expect(book.renewed).toBe(2);
    expect(book.lapsed).toBe(1);
    expect(book.inProgress).toBe(1);
    expect(book.retentionRatePct).toBe(50);            // 2 of 4
    expect(book.expiringPremiumMinor).toBe(M(430));
    expect(book.renewedPremiumMinor).toBe(M(320));
    // renewed expiring = 300, renewed premium = 320 → 106.7%
    expect(book.premiumRetentionPct).toBe(106.7);
    // rate changes: +10%, +5% → avg 7.5%
    expect(book.avgRateChangePct).toBe(7.5);
  });

  it('handles an empty book', () => {
    const book = renewalBook([]);
    expect(book.upForRenewal).toBe(0);
    expect(book.retentionRatePct).toBe(0);
    expect(book.avgRateChangePct).toBeNull();
  });
});
