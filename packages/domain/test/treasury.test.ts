import { describe, it, expect } from 'vitest';
import {
  accruedInterest,
  unrealisedPnl,
  valueHolding,
  portfolioSummary,
  type Holding,
} from '../src/treasury.js';
import { computeLevies, withholdingTax, type Levy } from '../src/tax.js';

describe('treasury / investments', () => {
  it('accrues simple interest on a fixed-income holding', () => {
    // 1,000,000 minor @ 4.5% for 365 days = 45,000
    expect(accruedInterest(1_000_000, 0.045, 365)).toBe(45_000);
    // half a year ≈ 22,500
    expect(accruedInterest(1_000_000, 0.045, 182)).toBe(Math.round((1_000_000 * 0.045 * 182) / 365));
    expect(accruedInterest(1_000_000, 0.045, 0)).toBe(0);
  });

  it('computes unrealised P&L as market minus book', () => {
    expect(unrealisedPnl(1_050_000, 1_000_000)).toBe(50_000);
    expect(unrealisedPnl(980_000, 1_000_000)).toBe(-20_000);
  });

  it('values a single bond holding with accrual', () => {
    const h: Holding = { instrumentType: 'BOND', currency: 'USD', faceValueMinor: 1_000_000, bookValueMinor: 990_000, marketValueMinor: 1_010_000, couponRate: 0.05 };
    const v = valueHolding(h, 365);
    expect(v.unrealisedMinor).toBe(20_000);
    expect(v.accruedInterestMinor).toBe(50_000);
  });

  it('rolls a single-currency portfolio up with a book-weighted yield', () => {
    const holdings: Holding[] = [
      { instrumentType: 'BOND', currency: 'USD', faceValueMinor: 1_000_000, bookValueMinor: 1_000_000, marketValueMinor: 1_020_000, couponRate: 0.04 },
      { instrumentType: 'BOND', currency: 'USD', faceValueMinor: 3_000_000, bookValueMinor: 3_000_000, marketValueMinor: 2_940_000, couponRate: 0.06 },
      { instrumentType: 'CASH', currency: 'USD', faceValueMinor: 0, bookValueMinor: 500_000, marketValueMinor: 500_000 },
    ];
    const s = portfolioSummary(holdings);
    expect(s.count).toBe(3);
    expect(s.bookValueMinor).toBe(4_500_000);
    expect(s.marketValueMinor).toBe(4_460_000);
    expect(s.unrealisedMinor).toBe(-40_000);
    // Book-weighted coupon: (0.04·1m + 0.06·3m) / 4m = 0.055
    expect(s.bookYield).toBeCloseTo(0.055, 10);
  });

  it('refuses to sum a mixed-currency portfolio', () => {
    const mixed: Holding[] = [
      { instrumentType: 'CASH', currency: 'USD', faceValueMinor: 0, bookValueMinor: 100, marketValueMinor: 100 },
      { instrumentType: 'CASH', currency: 'EUR', faceValueMinor: 0, bookValueMinor: 100, marketValueMinor: 100 },
    ];
    expect(() => portfolioSummary(mixed)).toThrow(/single currency/);
  });
});

describe('taxes & levies', () => {
  const levies: Levy[] = [
    { code: 'PREM_TAX', name: 'Premium tax', rate: 0.05 },
    { code: 'STAMP', name: 'Stamp duty', rate: 0.005 },
    { code: 'FET', name: 'Federal excise tax', rate: 0.01 },
  ];

  it('computes a levy stack whose total equals the sum of the lines', () => {
    const r = computeLevies(1_000_000, levies);
    expect(r.lines.map((l) => l.amountMinor)).toEqual([50_000, 5_000, 10_000]);
    expect(r.totalLevyMinor).toBe(65_000);
    expect(r.grossInclusiveMinor).toBe(1_065_000);
    // reconciliation: total === Σ lines
    expect(r.totalLevyMinor).toBe(r.lines.reduce((a, l) => a + l.amountMinor, 0));
  });

  it('withholds tax at source and returns the net', () => {
    expect(withholdingTax(1_000_000, 0.15)).toEqual({ taxMinor: 150_000, netMinor: 850_000 });
    expect(withholdingTax(1_000_000, 0)).toEqual({ taxMinor: 0, netMinor: 1_000_000 });
  });
});
