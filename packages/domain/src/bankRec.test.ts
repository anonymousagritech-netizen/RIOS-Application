import { describe, it, expect } from 'vitest';
import { reconcileBank, type BankRecInput } from './bankRec.js';

describe('bankRec.reconcileBank', () => {
  it('matches on reference first, then amount + date tolerance', () => {
    const input: BankRecInput = {
      bookBalanceMinor: 100_000,
      bankBalanceMinor: 100_000,
      bookLines: [
        { id: 'b1', amountMinor: 50_000, date: '2026-01-10', reference: 'INV-1' },
        { id: 'b2', amountMinor: -20_000, date: '2026-01-12' },
      ],
      bankLines: [
        { id: 'k1', amountMinor: 50_000, date: '2026-01-11', reference: 'INV-1' },
        { id: 'k2', amountMinor: -20_000, date: '2026-01-14' }, // within 5-day tolerance
      ],
    };
    const r = reconcileBank(input);
    expect(r.matches).toHaveLength(2);
    expect(r.matches.find((m) => m.bookId === 'b1')?.bankId).toBe('k1');
    expect(r.unmatchedBook).toHaveLength(0);
    expect(r.unmatchedBank).toHaveLength(0);
    expect(r.reconciled).toBe(true);
    expect(r.differenceMinor).toBe(0);
  });

  it('surfaces deposits in transit and bank-only charges, and proves the identity', () => {
    // Book has a deposit (b2) not yet on the bank; bank has a charge (k2) not in the book.
    const input: BankRecInput = {
      bookBalanceMinor: 30_000,   // book already includes b2's +10,000
      bankBalanceMinor: 19_000,   // bank already includes k2 (-1,000)
      bookLines: [
        { id: 'b1', amountMinor: 20_000, date: '2026-02-01', reference: 'A' },
        { id: 'b2', amountMinor: 10_000, date: '2026-02-28' }, // deposit in transit
      ],
      bankLines: [
        { id: 'k1', amountMinor: 20_000, date: '2026-02-01', reference: 'A' },
        { id: 'k2', amountMinor: -1_000, date: '2026-02-27' }, // bank charge
      ],
    };
    const r = reconcileBank(input);
    expect(r.matches).toHaveLength(1);
    expect(r.unmatchedBook.map((l) => l.id)).toEqual(['b2']);
    expect(r.unmatchedBank.map((l) => l.id)).toEqual(['k2']);
    // adjustedBank = 21,000 + 10,000 = 31,000 ; adjustedBook = 30,000 + 1,000 = 31,000
    expect(r.differenceMinor).toBe(0);
    expect(r.reconciled).toBe(true);
  });

  it('reports a non-zero difference when balances do not tie', () => {
    const r = reconcileBank({
      bookBalanceMinor: 100_000,
      bankBalanceMinor: 95_000, // 5,000 unexplained
      bookLines: [{ id: 'b1', amountMinor: 40_000, reference: 'X' }],
      bankLines: [{ id: 'k1', amountMinor: 40_000, reference: 'X' }],
    });
    expect(r.matches).toHaveLength(1);
    expect(r.differenceMinor).toBe(-5_000);
    expect(r.reconciled).toBe(false);
  });

  it('does not match lines with equal amounts but conflicting references', () => {
    const r = reconcileBank({
      bookBalanceMinor: 0, bankBalanceMinor: 0,
      bookLines: [{ id: 'b1', amountMinor: 10_000, reference: 'AAA' }],
      bankLines: [{ id: 'k1', amountMinor: 10_000, reference: 'BBB' }],
    });
    expect(r.matches).toHaveLength(0);
    expect(r.unmatchedBook).toHaveLength(1);
    expect(r.unmatchedBank).toHaveLength(1);
  });
});
