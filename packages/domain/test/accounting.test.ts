import { describe, it, expect } from 'vitest';
import { fromMajor } from '../src/money.js';
import {
  buildStatement,
  reconcile,
  assertBalanced,
  signedAmount,
  UnbalancedPostingError,
  type FinancialEvent,
  type LedgerPosting,
} from '../src/accounting.js';

const ev = (
  id: string,
  type: FinancialEvent['type'],
  major: number,
  direction: FinancialEvent['direction'],
): FinancialEvent => ({
  id,
  contractId: 'C1',
  type,
  amount: fromMajor(major, 'USD'),
  direction,
  bookedAt: '2026-03-31',
});

describe('statement of account', () => {
  const events: FinancialEvent[] = [
    ev('e1', 'DEPOSIT_PREMIUM', 300_000, 'DR'), // cedent owes reinsurer
    ev('e2', 'CEDING_COMMISSION', 75_000, 'CR'), // reinsurer pays cedent
    ev('e3', 'PAID_LOSS', 120_000, 'CR'), // reinsurer pays loss
  ];

  it('signs events from the cedent perspective', () => {
    expect(signedAmount(events[0]!).amount).toBe(fromMajor(300_000, 'USD').amount);
    expect(signedAmount(events[1]!).amount).toBe(fromMajor(-75_000, 'USD').amount);
  });

  it('nets to the correct balance', () => {
    const stmt = buildStatement(events, 'USD');
    // 300,000 - 75,000 - 120,000 = 105,000 owed by cedent to reinsurer
    expect(stmt.balance.amount).toBe(fromMajor(105_000, 'USD').amount);
    expect(stmt.eventCount).toBe(3);
    expect(stmt.lines.length).toBe(3);
  });

  it('rejects mixed-currency netting', () => {
    const mixed = [...events, { ...ev('e4', 'TAX', 10, 'DR'), amount: fromMajor(10, 'EUR') }];
    expect(() => buildStatement(mixed, 'USD')).toThrow(/convert via FX/);
  });
});

describe('double-entry postings', () => {
  it('accepts a balanced posting', () => {
    const p: LedgerPosting = {
      sourceEventIds: ['e1'],
      legs: [
        { account: 'REINSURER_CONTROL', debit: fromMajor(300_000, 'USD'), credit: fromMajor(0, 'USD') },
        { account: 'CEDED_PREMIUM_INCOME', debit: fromMajor(0, 'USD'), credit: fromMajor(300_000, 'USD') },
      ],
    };
    expect(() => assertBalanced(p)).not.toThrow();
  });

  it('rejects an unbalanced posting', () => {
    const p: LedgerPosting = {
      sourceEventIds: ['e1'],
      legs: [
        { account: 'A', debit: fromMajor(300_000, 'USD'), credit: fromMajor(0, 'USD') },
        { account: 'B', debit: fromMajor(0, 'USD'), credit: fromMajor(250_000, 'USD') },
      ],
    };
    expect(() => assertBalanced(p)).toThrow(UnbalancedPostingError);
  });
});

describe('technical -> financial reconciliation (§7.6)', () => {
  it('reconciles the statement balance to the control account movement', () => {
    const events: FinancialEvent[] = [
      ev('e1', 'DEPOSIT_PREMIUM', 300_000, 'DR'),
      ev('e2', 'CEDING_COMMISSION', 75_000, 'CR'),
      ev('e3', 'PAID_LOSS', 120_000, 'CR'),
    ];
    const stmt = buildStatement(events, 'USD');

    const C = 'REINSURER_CONTROL';
    const postings: LedgerPosting[] = [
      {
        sourceEventIds: ['e1'],
        legs: [
          { account: C, debit: fromMajor(300_000, 'USD'), credit: fromMajor(0, 'USD') },
          { account: 'CEDED_PREMIUM', debit: fromMajor(0, 'USD'), credit: fromMajor(300_000, 'USD') },
        ],
      },
      {
        sourceEventIds: ['e2'],
        legs: [
          { account: 'COMMISSION_EXPENSE', debit: fromMajor(75_000, 'USD'), credit: fromMajor(0, 'USD') },
          { account: C, debit: fromMajor(0, 'USD'), credit: fromMajor(75_000, 'USD') },
        ],
      },
      {
        sourceEventIds: ['e3'],
        legs: [
          { account: 'LOSS_EXPENSE', debit: fromMajor(120_000, 'USD'), credit: fromMajor(0, 'USD') },
          { account: C, debit: fromMajor(0, 'USD'), credit: fromMajor(120_000, 'USD') },
        ],
      },
    ];

    const result = reconcile(stmt, postings, C);
    expect(result.reconciled).toBe(true);
    expect(result.difference.amount).toBe(0);
    expect(result.controlAccountMovement.amount).toBe(fromMajor(105_000, 'USD').amount);
  });

  it('flags an out-of-balance chain', () => {
    const events: FinancialEvent[] = [ev('e1', 'DEPOSIT_PREMIUM', 300_000, 'DR')];
    const stmt = buildStatement(events, 'USD');
    const C = 'REINSURER_CONTROL';
    const postings: LedgerPosting[] = [
      {
        sourceEventIds: ['e1'],
        legs: [
          { account: C, debit: fromMajor(250_000, 'USD'), credit: fromMajor(0, 'USD') }, // wrong!
          { account: 'CEDED_PREMIUM', debit: fromMajor(0, 'USD'), credit: fromMajor(250_000, 'USD') },
        ],
      },
    ];
    const result = reconcile(stmt, postings, C);
    expect(result.reconciled).toBe(false);
    expect(result.difference.amount).toBe(fromMajor(50_000, 'USD').amount);
  });
});
