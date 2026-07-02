import { describe, it, expect } from 'vitest';
import { fromMajor, money } from './money.js';
import { expectedCedingCommission, compareSoaItems } from './soaVerification.js';

describe('expectedCedingCommission (flat)', () => {
  it('applies the flat provisional rate to the statement premium', () => {
    // 1,000,000 premium @ 25% -> 250,000.
    const r = expectedCedingCommission(fromMajor(1_000_000, 'USD'), { provisionalRatePct: 25 });
    expect(r.amount).toBe(fromMajor(250_000, 'USD').amount);
  });

  it('handles fractional percentages exactly (27.5% -> 275,000 ppm)', () => {
    const r = expectedCedingCommission(fromMajor(1_000_000, 'USD'), { provisionalRatePct: 27.5 });
    expect(r.amount).toBe(fromMajor(275_000, 'USD').amount);
  });

  it('collars the rate to commissionMaxPct', () => {
    // 40% provisional collared to max 30% -> 300,000 on 1,000,000.
    const r = expectedCedingCommission(fromMajor(1_000_000, 'USD'), {
      provisionalRatePct: 40, minRatePct: 20, maxRatePct: 30,
    });
    expect(r.amount).toBe(fromMajor(300_000, 'USD').amount);
  });

  it('collars the rate up to commissionMinPct', () => {
    // 10% provisional collared to min 20% -> 200,000 on 1,000,000.
    const r = expectedCedingCommission(fromMajor(1_000_000, 'USD'), {
      provisionalRatePct: 10, minRatePct: 20, maxRatePct: 30,
    });
    expect(r.amount).toBe(fromMajor(200_000, 'USD').amount);
  });

  it('returns zero on zero premium and zero rate', () => {
    expect(expectedCedingCommission(fromMajor(0, 'USD'), { provisionalRatePct: 25 }).amount).toBe(0);
    expect(expectedCedingCommission(fromMajor(1_000, 'USD'), {}).amount).toBe(0);
  });

  it('rejects min > max and out-of-range percentages', () => {
    const p = fromMajor(1_000, 'USD');
    expect(() => expectedCedingCommission(p, { minRatePct: 30, maxRatePct: 20 })).toThrow(RangeError);
    expect(() => expectedCedingCommission(p, { provisionalRatePct: 101 })).toThrow(RangeError);
    expect(() => expectedCedingCommission(p, { provisionalRatePct: -1 })).toThrow(RangeError);
  });
});

describe('expectedCedingCommission (sliding scale bands)', () => {
  // LR <= 50% -> 35%, LR <= 60% -> 30%, LR <= 80% -> 20%; collar [15%, 35%].
  const bands = [
    { lossRatioUpTo: 0.5, commissionRate: 0.35 },
    { lossRatioUpTo: 0.6, commissionRate: 0.3 },
    { lossRatioUpTo: 0.8, commissionRate: 0.2 },
  ];
  const terms = { provisionalRatePct: 25, minRatePct: 15, maxRatePct: 35, bands };

  it('slides to the band matching the actual loss ratio', () => {
    // LR = 550,000 / 1,000,000 = 55% -> 30% band -> 300,000.
    const r = expectedCedingCommission(fromMajor(1_000_000, 'USD'), terms, fromMajor(550_000, 'USD'));
    expect(r.amount).toBe(fromMajor(300_000, 'USD').amount);
  });

  it('falls to the floor above every band', () => {
    // LR = 90% is above every band -> minRate 15% -> 150,000.
    const r = expectedCedingCommission(fromMajor(1_000_000, 'USD'), terms, fromMajor(900_000, 'USD'));
    expect(r.amount).toBe(fromMajor(150_000, 'USD').amount);
  });

  it('treats a missing incurred loss as a zero loss ratio (best band)', () => {
    // LR = 0 -> first band 35% -> 350,000.
    const r = expectedCedingCommission(fromMajor(1_000_000, 'USD'), terms);
    expect(r.amount).toBe(fromMajor(350_000, 'USD').amount);
  });
});

describe('compareSoaItems', () => {
  const usd = (major: number) => fromMajor(major, 'USD');

  it('verifies an exact match', () => {
    const r = compareSoaItems(
      [{ itemKey: 'CEDING_COMMISSION', expected: usd(250_000), actual: usd(250_000) }],
      1,
    );
    expect(r.allWithinTolerance).toBe(true);
    expect(r.items[0]!.deviation.amount).toBe(0);
    expect(r.items[0]!.withinTolerance).toBe(true);
  });

  it('accepts a deviation exactly at the tolerance boundary', () => {
    // 1% of 250,000 = 2,500; actual 252,500 is exactly on the line -> within.
    const r = compareSoaItems(
      [{ itemKey: 'CEDING_COMMISSION', expected: usd(250_000), actual: usd(252_500) }],
      1,
    );
    expect(r.items[0]!.withinTolerance).toBe(true);
  });

  it('flags a deviation beyond tolerance (the DEVIATIONS branch)', () => {
    // Cedent reported 20% instead of 25%: 200,000 vs 250,000 -> -50,000 (20% off).
    const r = compareSoaItems(
      [{ itemKey: 'CEDING_COMMISSION', expected: usd(250_000), actual: usd(200_000) }],
      1,
    );
    expect(r.allWithinTolerance).toBe(false);
    expect(r.items[0]!.withinTolerance).toBe(false);
    expect(r.items[0]!.deviation.amount).toBe(usd(-50_000).amount);
  });

  it('with tolerance 0 only an exact match passes', () => {
    const off = compareSoaItems(
      [{ itemKey: 'BROKERAGE', expected: money(10_000, 'USD'), actual: money(10_001, 'USD') }],
      0,
    );
    expect(off.items[0]!.withinTolerance).toBe(false);
    const exact = compareSoaItems(
      [{ itemKey: 'BROKERAGE', expected: money(10_000, 'USD'), actual: money(10_000, 'USD') }],
      0,
    );
    expect(exact.items[0]!.withinTolerance).toBe(true);
  });

  it('treats expected 0 with actual 0 as within, expected 0 with actual non-zero as a deviation', () => {
    const r = compareSoaItems(
      [
        { itemKey: 'OVERRIDING_COMMISSION', expected: usd(0), actual: usd(0) },
        { itemKey: 'REINSTATEMENT_PREMIUM', expected: usd(0), actual: usd(5_000) },
      ],
      5,
    );
    expect(r.items[0]!.withinTolerance).toBe(true);
    expect(r.items[1]!.withinTolerance).toBe(false);
    expect(r.allWithinTolerance).toBe(false);
  });

  it('an empty item list verifies trivially', () => {
    expect(compareSoaItems([], 1).allWithinTolerance).toBe(true);
  });

  it('rejects a negative tolerance and cross-currency comparisons', () => {
    expect(() => compareSoaItems([], -1)).toThrow(RangeError);
    expect(() =>
      compareSoaItems([{ itemKey: 'X', expected: usd(100), actual: fromMajor(100, 'EUR') }], 1),
    ).toThrow();
  });
});
