/**
 * Legal-entity consolidation unit tests. Proves: intercompany balances are
 * eliminated (and net to zero when they mirror), non-intercompany accounts are
 * aggregated line-by-line across entities, the group trial balance stays
 * balanced, and the simple minority-interest model applies the non-controlling
 * share of a subsidiary's net assets when ownership < 100. Integer minor units.
 */

import { describe, it, expect } from 'vitest';
import {
  consolidate,
  entityNetAssetsMinor,
  type ConsolidationEntity,
  type ConsolidationInput,
} from './consolidation.js';

// Parent (group) - wholly owned. Holds an intercompany receivable (1100) on the
// subsidiary of 1,000,000, plus real cash and income.
const parent: ConsolidationEntity = {
  entityId: 'PARENT',
  ownershipPct: 100,
  accounts: [
    { code: '1000', type: 'asset', debitMinor: 5_000_000, creditMinor: 0 }, // cash
    { code: '1100', type: 'asset', debitMinor: 1_000_000, creditMinor: 0 }, // intercompany receivable
    { code: '4000', type: 'income', debitMinor: 0, creditMinor: 6_000_000 }, // income
  ],
};

// Subsidiary - 80% owned. Holds the mirror intercompany payable (2100) of
// 1,000,000, plus real cash and expense.
const sub: ConsolidationEntity = {
  entityId: 'SUB',
  ownershipPct: 80,
  accounts: [
    { code: '1000', type: 'asset', debitMinor: 3_000_000, creditMinor: 0 }, // cash
    { code: '2100', type: 'liability', debitMinor: 0, creditMinor: 1_000_000 }, // intercompany payable
    { code: '5100', type: 'expense', debitMinor: 2_000_000, creditMinor: 0 }, // expense
    { code: '3000', type: 'equity', debitMinor: 0, creditMinor: 4_000_000 }, // share capital
  ],
};

const baseInput: ConsolidationInput = {
  currency: 'USD',
  groupEntityId: 'PARENT',
  entities: [parent, sub],
  intercompanyAccounts: ['1100', '2100'],
};

describe('legal-entity consolidation', () => {
  it('eliminates intercompany balances and keeps them out of the consolidated TB', () => {
    const r = consolidate(baseInput);
    const codes = r.consolidated.map((a) => a.code);
    expect(codes).not.toContain('1100');
    expect(codes).not.toContain('2100');
    // Two elimination entries recorded (one per entity leg).
    expect(r.eliminations.map((e) => e.accountCode).sort()).toEqual(['1100', '2100']);
    // Receivable (+1,000,000) and payable (-1,000,000) mirror, so eliminations net to zero.
    expect(r.eliminationNetMinor).toBe(0);
    expect(r.eliminationsBalanced).toBe(true);
  });

  it('aggregates non-intercompany accounts line-by-line across entities', () => {
    const r = consolidate(baseInput);
    const cash = r.consolidated.find((a) => a.code === '1000')!;
    expect(cash.debitMinor).toBe(5_000_000 + 3_000_000); // both entities' cash
    const income = r.consolidated.find((a) => a.code === '4000')!;
    expect(income.creditMinor).toBe(6_000_000);
    const expense = r.consolidated.find((a) => a.code === '5100')!;
    expect(expense.debitMinor).toBe(2_000_000);
  });

  it('keeps the consolidated group trial balance balanced', () => {
    const r = consolidate(baseInput);
    // Debits: cash 8,000,000 + expense 2,000,000 = 10,000,000.
    // Credits: income 6,000,000 + equity 4,000,000 = 10,000,000.
    expect(r.totalDebitsMinor).toBe(10_000_000);
    expect(r.totalCreditsMinor).toBe(10_000_000);
    expect(r.balanced).toBe(true);
  });

  it('applies the simple minority-interest model when ownership < 100', () => {
    const r = consolidate(baseInput);
    // Subsidiary standalone net assets = assets - liabilities
    //   assets: cash 3,000,000 (intercompany 2100 is a liability)
    //   liabilities: intercompany payable 1,000,000
    //   net assets = 3,000,000 - 1,000,000 = 2,000,000
    expect(entityNetAssetsMinor(sub)).toBe(2_000_000);
    const mi = r.minorityInterest.find((m) => m.entityId === 'SUB')!;
    expect(mi.netAssetsMinor).toBe(2_000_000);
    // 20% non-controlling share = 400,000.
    expect(mi.minorityInterestMinor).toBe(400_000);
    expect(r.minorityInterestMinor).toBe(400_000);
    // The wholly-owned parent contributes no minority interest.
    expect(r.minorityInterest.some((m) => m.entityId === 'PARENT')).toBe(false);
  });

  it('reports non-zero elimination net when intercompany balances do not mirror', () => {
    const skewed: ConsolidationInput = {
      ...baseInput,
      entities: [
        parent,
        { ...sub, accounts: sub.accounts.map((a) => (a.code === '2100' ? { ...a, creditMinor: 750_000 } : a)) },
      ],
    };
    const r = consolidate(skewed);
    // +1,000,000 receivable eliminated against -750,000 payable => net +250,000 remains flagged.
    expect(r.eliminationNetMinor).toBe(250_000);
    expect(r.eliminationsBalanced).toBe(false);
  });

  it('rounds the minority share to whole minor units', () => {
    const odd: ConsolidationEntity = {
      entityId: 'ODD',
      ownershipPct: 66,
      accounts: [{ code: '1000', type: 'asset', debitMinor: 1_000_001, creditMinor: 0 }],
    };
    const r = consolidate({ currency: 'USD', groupEntityId: 'PARENT', entities: [parent, odd], intercompanyAccounts: [] });
    const mi = r.minorityInterest.find((m) => m.entityId === 'ODD')!;
    // 34% of 1,000,001 = 340,000.34 -> rounds to 340,000.
    expect(mi.minorityInterestMinor).toBe(Math.round((1_000_001 * 34) / 100));
    expect(mi.minorityInterestMinor).toBe(340_000);
  });
});
