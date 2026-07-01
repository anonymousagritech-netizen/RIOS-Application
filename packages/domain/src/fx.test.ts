import { describe, it, expect } from 'vitest';
import {
  convert, revalue, crossRate, revalueItem, revaluePortfolio, settle, netOpenExposure,
  type MonetaryItem,
} from './fx.js';
import { money, toMajor } from './money.js';

const usd = (major: number) => money(Math.round(major * 100), 'USD');
const eur = (major: number) => money(Math.round(major * 100), 'EUR');
const jpy = (major: number) => money(Math.round(major), 'JPY');

describe('fx.convert', () => {
  it('converts across same-precision currencies at the given rate', () => {
    const c = convert(eur(100), 'USD', 1.1);
    expect(c.to.currency).toBe('USD');
    expect(c.to.amount).toBe(11000); // 110.00
    expect(c.rate).toBe(1.1);
  });

  it('handles cross-precision pairs (EUR -> JPY)', () => {
    const c = convert(eur(100), 'JPY', 160); // 100 EUR * 160 = 16,000 JPY
    expect(c.to.currency).toBe('JPY');
    expect(c.to.amount).toBe(16000); // JPY has 0 minor units
  });

  it('is a no-op for same currency and rejects non-positive rates', () => {
    expect(convert(usd(50), 'USD', 5).to.amount).toBe(5000);
    expect(() => convert(eur(1), 'USD', 0)).toThrow(RangeError);
    expect(() => convert(eur(1), 'USD', -1)).toThrow(RangeError);
    expect(() => convert(eur(1), 'USD', Number.NaN)).toThrow(RangeError);
  });
});

describe('fx.crossRate', () => {
  it('triangulates through a common base', () => {
    // GBP/USD = 1.25, EUR/USD = 1.10  =>  GBP/EUR = 1.25 / 1.10
    expect(crossRate(1.25, 1.1)).toBeCloseTo(1.13636, 4);
    expect(() => crossRate(1.25, 0)).toThrow(RangeError);
  });
});

describe('fx.revalueItem (unrealized)', () => {
  it('gains on an asset when the foreign currency strengthens', () => {
    const item: MonetaryItem = { id: 'ar1', amount: eur(1000), bookedRate: 1.10 };
    const r = revalueItem(item, 'USD', 1.20);
    expect(r.atBooked.amount).toBe(110000); // 1,100.00
    expect(r.atCurrent.amount).toBe(120000); // 1,200.00
    expect(r.carryingDelta.amount).toBe(10000); // +100.00
    expect(r.gainLoss.amount).toBe(10000); // asset gain
  });

  it('inverts the P&L sign for a liability', () => {
    const item: MonetaryItem = { id: 'ap1', amount: eur(1000), bookedRate: 1.10, kind: 'liability' };
    const r = revalueItem(item, 'USD', 1.20);
    expect(r.carryingDelta.amount).toBe(10000); // carrying rises
    expect(r.gainLoss.amount).toBe(-10000); // but it is a loss on a payable
  });

  it('rejects negative magnitudes (direction is expressed via kind)', () => {
    expect(() => revalueItem({ id: 'x', amount: money(-100, 'EUR'), bookedRate: 1 }, 'USD', 1)).toThrow(RangeError);
  });
});

describe('fx.revaluePortfolio', () => {
  const items: MonetaryItem[] = [
    { id: 'eur-ar', amount: eur(1000), bookedRate: 1.10, kind: 'asset' },
    { id: 'eur-ap', amount: eur(400), bookedRate: 1.10, kind: 'liability' },
    { id: 'jpy-ar', amount: jpy(1_000_000), bookedRate: 0.0090, kind: 'asset' },
    { id: 'usd-ar', amount: usd(500), bookedRate: 1, kind: 'asset' }, // base currency, never revalues
  ];
  const rates = { EUR: 1.20, JPY: 0.0095 };
  const rev = revaluePortfolio(items, 'USD', rates);

  it('nets asset and liability P&L per currency and overall', () => {
    // EUR: asset +100.00, liability -40.00  => +60.00
    expect(rev.byCurrency.EUR!.gainLoss.amount).toBe(6000);
    // JPY: 1,000,000 * (0.0095 - 0.0090) = +500.00
    expect(rev.byCurrency.JPY!.gainLoss.amount).toBe(50000);
    // USD base item contributes zero FX P&L
    expect(rev.byCurrency.USD!.gainLoss.amount).toBe(0);
    expect(rev.netGainLoss.amount).toBe(6000 + 50000);
  });

  it('emits balanced GL postings that reconcile to zero', () => {
    const debit = rev.postings.filter((p) => p.side === 'debit').reduce((s, p) => s + p.amount.amount, 0);
    const credit = rev.postings.filter((p) => p.side === 'credit').reduce((s, p) => s + p.amount.amount, 0);
    expect(debit).toBe(credit);
    expect(rev.postings).toHaveLength(2);
    // net gain => debit the position, credit the gain account
    expect(rev.postings.find((p) => p.account === 'FX_REVALUATION_GAIN')?.side).toBe('credit');
  });

  it('produces a loss posting pair when the net movement is negative', () => {
    const loss = revaluePortfolio(
      [{ id: 'e', amount: eur(1000), bookedRate: 1.20, kind: 'asset' }],
      'USD',
      { EUR: 1.10 },
    );
    expect(loss.netGainLoss.amount).toBe(-10000);
    expect(loss.postings.find((p) => p.account === 'FX_REVALUATION_LOSS')?.side).toBe('debit');
    const debit = loss.postings.filter((p) => p.side === 'debit').reduce((s, p) => s + p.amount.amount, 0);
    const credit = loss.postings.filter((p) => p.side === 'credit').reduce((s, p) => s + p.amount.amount, 0);
    expect(debit).toBe(credit);
  });

  it('throws when a closing rate is missing', () => {
    expect(() => revaluePortfolio(items, 'USD', { EUR: 1.2 })).toThrow(RangeError); // JPY missing
  });
});

describe('fx.settle (realized)', () => {
  it('crystallises a realized gain/loss at the settlement rate', () => {
    const item: MonetaryItem = { id: 'ar1', amount: eur(1000), bookedRate: 1.10 };
    const s = settle(item, 'USD', 1.15);
    expect(s.atBooked.amount).toBe(110000);
    expect(s.atSettlement.amount).toBe(115000);
    expect(s.realized.amount).toBe(5000); // +50.00 realized gain
  });
});

describe('fx.netOpenExposure', () => {
  it('nets assets against liabilities per currency in the foreign currency', () => {
    const items: MonetaryItem[] = [
      { id: 'a', amount: eur(1000), bookedRate: 1.1, kind: 'asset' },
      { id: 'b', amount: eur(400), bookedRate: 1.1, kind: 'liability' },
    ];
    const net = netOpenExposure(items);
    expect(net.EUR!.amount).toBe(60000); // 600.00 net long EUR
    expect(toMajor(net.EUR!)).toBe(600);
  });
});

describe('fx.revalue (legacy balance helper)', () => {
  it('still returns booked/current/gainLoss for a bare balance', () => {
    const r = revalue(eur(1000), 'USD', 1.1, 1.2);
    expect(r.gainLoss.amount).toBe(10000);
  });
});
