import { describe, it, expect } from 'vitest';
import {
  money,
  fromMajor,
  toMajor,
  add,
  subtract,
  multiply,
  percentOf,
  allocate,
  sum,
  minorUnitsFor,
  MoneyError,
} from '../src/money.js';

describe('money construction', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(10.5, 'USD')).toThrow(MoneyError);
  });

  it('converts to/from major units respecting currency precision', () => {
    expect(fromMajor(1234.56, 'USD').amount).toBe(123456);
    expect(fromMajor(1234.56, 'JPY').amount).toBe(1235); // JPY has 0 minor units
    expect(minorUnitsFor('BHD')).toBe(3);
    expect(fromMajor(1.234, 'BHD').amount).toBe(1234);
    expect(toMajor(money(123456, 'USD'))).toBeCloseTo(1234.56);
  });
});

describe('money arithmetic', () => {
  it('adds and subtracts same-currency amounts', () => {
    expect(add(money(100, 'USD'), money(250, 'USD')).amount).toBe(350);
    expect(subtract(money(100, 'USD'), money(250, 'USD')).amount).toBe(-150);
  });

  it('refuses cross-currency arithmetic', () => {
    expect(() => add(money(100, 'USD'), money(100, 'EUR'))).toThrow(/Currency mismatch/);
  });

  it('multiplies by a rate with explicit rounding', () => {
    // 100.00 USD * 2.5% = 2.50
    expect(percentOf(money(10000, 'USD'), 2.5).amount).toBe(250);
    // half-up rounding: 12345 * 0.5 = 6172.5 -> 6173
    expect(multiply(money(12345, 'USD'), 0.5, 'half-up').amount).toBe(6173);
    expect(multiply(money(12345, 'USD'), 0.5, 'down').amount).toBe(6172);
    expect(multiply(money(12345, 'USD'), 0.5, 'half-even').amount).toBe(6172);
  });
});

describe('allocate (penny-perfect)', () => {
  it('never loses or invents minor units', () => {
    const parts = allocate(money(1000, 'USD'), [1, 1, 1]); // 10.00 / 3
    expect(parts.map((p) => p.amount)).toEqual([334, 333, 333]);
    expect(sum(parts).amount).toBe(1000);
  });

  it('allocates by weight and reconciles exactly', () => {
    const parts = allocate(money(100001, 'USD'), [30, 50, 20]);
    expect(sum(parts).amount).toBe(100001);
  });

  it('handles negative amounts', () => {
    const parts = allocate(money(-1000, 'USD'), [1, 1, 1]);
    expect(sum(parts).amount).toBe(-1000);
  });
});
