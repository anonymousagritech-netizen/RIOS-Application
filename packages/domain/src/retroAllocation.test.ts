/**
 * Retro cession allocation engine unit tests (Tier-2 gap #10).
 *
 * Proves: rule matching (appliesTo + LOB/currency/date filters), quota-share
 * cession in integer minor units, largest-remainder distribution, the source-
 * amount cap when percentages sum past 100%, deterministic ordering, and input
 * validation. Pure domain - no DB.
 */

import { describe, it, expect } from 'vitest';
import { money } from './money.js';
import {
  allocateRetrocession,
  matchesRetroRule,
  type RetroAllocationRule,
  type RetroSourceEvent,
} from './retroAllocation.js';

const rule = (over: Partial<RetroAllocationRule> = {}): RetroAllocationRule => ({
  id: 'rule-1',
  retroContractId: 'retro-1',
  appliesTo: 'BOTH',
  method: 'QUOTA_SHARE',
  cessionPct: 25,
  priority: 100,
  ...over,
});

const premium = (amountMinor: number, over: Partial<RetroSourceEvent> = {}): RetroSourceEvent => ({
  kind: 'PREMIUM',
  amount: money(amountMinor, 'USD'),
  lineOfBusiness: 'PROPERTY',
  eventDate: '2026-03-15',
  ...over,
});

describe('matchesRetroRule', () => {
  it('matches on appliesTo: PREMIUM rule does not take claims, BOTH takes both', () => {
    const p = premium(1000);
    const c: RetroSourceEvent = { ...premium(1000), kind: 'CLAIM' };
    expect(matchesRetroRule(p, rule({ appliesTo: 'PREMIUM' }))).toBe(true);
    expect(matchesRetroRule(c, rule({ appliesTo: 'PREMIUM' }))).toBe(false);
    expect(matchesRetroRule(p, rule({ appliesTo: 'CLAIM' }))).toBe(false);
    expect(matchesRetroRule(c, rule({ appliesTo: 'CLAIM' }))).toBe(true);
    expect(matchesRetroRule(p, rule({ appliesTo: 'BOTH' }))).toBe(true);
    expect(matchesRetroRule(c, rule({ appliesTo: 'BOTH' }))).toBe(true);
  });

  it('filters by line of business', () => {
    expect(matchesRetroRule(premium(1000), rule({ filter: { lineOfBusiness: 'PROPERTY' } }))).toBe(true);
    expect(matchesRetroRule(premium(1000), rule({ filter: { lineOfBusiness: 'MARINE' } }))).toBe(false);
    expect(matchesRetroRule(premium(1000, { lineOfBusiness: null }), rule({ filter: { lineOfBusiness: 'PROPERTY' } }))).toBe(false);
  });

  it('filters by currency, case-insensitively on the rule side', () => {
    expect(matchesRetroRule(premium(1000), rule({ filter: { currency: 'usd' } }))).toBe(true);
    expect(matchesRetroRule(premium(1000), rule({ filter: { currency: 'EUR' } }))).toBe(false);
  });

  it('filters by inclusive event-date window, open-ended on either side', () => {
    expect(matchesRetroRule(premium(1000), rule({ filter: { periodStart: '2026-03-15' } }))).toBe(true);
    expect(matchesRetroRule(premium(1000), rule({ filter: { periodStart: '2026-03-16' } }))).toBe(false);
    expect(matchesRetroRule(premium(1000), rule({ filter: { periodEnd: '2026-03-15' } }))).toBe(true);
    expect(matchesRetroRule(premium(1000), rule({ filter: { periodEnd: '2026-03-14' } }))).toBe(false);
    expect(
      matchesRetroRule(premium(1000), rule({ filter: { periodStart: '2026-01-01', periodEnd: '2026-12-31' } })),
    ).toBe(true);
    // A dated window cannot match an event without a date.
    expect(matchesRetroRule(premium(1000, { eventDate: null }), rule({ filter: { periodStart: '2026-01-01' } }))).toBe(false);
  });
});

describe('allocateRetrocession: quota-share cession', () => {
  it('cedes exactly 25% of the gross in minor units and retains the rest', () => {
    const res = allocateRetrocession(premium(10_000_000), [rule()]);
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0]!.amount.amount).toBe(2_500_000);
    expect(res.allocations[0]!.retroContractId).toBe('retro-1');
    expect(res.totalCeded.amount).toBe(2_500_000);
    expect(res.retained.amount).toBe(7_500_000);
    expect(res.retained.currency).toBe('USD');
  });

  it('returns no allocations when nothing matches', () => {
    const res = allocateRetrocession(premium(10_000_000), [rule({ appliesTo: 'CLAIM' })]);
    expect(res.allocations).toHaveLength(0);
    expect(res.totalCeded.amount).toBe(0);
    expect(res.retained.amount).toBe(10_000_000);
  });

  it('supports fractional percentages at 4-decimal resolution', () => {
    // 12.5% of 1,000,001 = 125,000.125 → floor of exact total = 125,000
    const res = allocateRetrocession(premium(1_000_001), [rule({ cessionPct: 12.5 })]);
    expect(res.allocations[0]!.amount.amount).toBe(125_000);
    expect(res.retained.amount).toBe(875_001);
  });

  it('rounds a sub-minor-unit cession down to zero and keeps the zero line', () => {
    const res = allocateRetrocession(premium(1), [rule({ cessionPct: 10 })]);
    expect(res.allocations).toHaveLength(1);
    expect(res.allocations[0]!.amount.amount).toBe(0);
    expect(res.retained.amount).toBe(1);
  });
});

describe('allocateRetrocession: multiple rules, largest remainder, source cap', () => {
  it('each matching rule independently cedes its pct of the gross', () => {
    const rules = [
      rule({ id: 'a', retroContractId: 'retro-a', cessionPct: 20, priority: 10 }),
      rule({ id: 'b', retroContractId: 'retro-b', cessionPct: 30, priority: 20 }),
    ];
    const res = allocateRetrocession(premium(10_000_000), rules);
    expect(res.allocations.map((a) => a.amount.amount)).toEqual([2_000_000, 3_000_000]);
    expect(res.totalCeded.amount).toBe(5_000_000);
    expect(res.retained.amount).toBe(5_000_000);
  });

  it('distributes remainder minor units by largest remainder, never exceeding the source', () => {
    // 50% + 50% of 101: exact 50.5 each; total 101 → one line gets the extra unit.
    const rules = [
      rule({ id: 'a', cessionPct: 50, priority: 10 }),
      rule({ id: 'b', cessionPct: 50, priority: 20 }),
    ];
    const res = allocateRetrocession(premium(101), rules);
    expect(res.allocations.map((a) => a.amount.amount).sort((x, y) => x - y)).toEqual([50, 51]);
    expect(res.totalCeded.amount).toBe(101);
    expect(res.retained.amount).toBe(0);
    // Tie on remainder → earlier (priority) rule gets the extra unit.
    expect(res.allocations[0]!.ruleId).toBe('a');
    expect(res.allocations[0]!.amount.amount).toBe(51);
  });

  it('never allocates more than the source when percentages sum past 100%', () => {
    const rules = [
      rule({ id: 'a', cessionPct: 60, priority: 10 }),
      rule({ id: 'b', cessionPct: 60, priority: 20 }),
    ];
    const res = allocateRetrocession(premium(100), rules);
    expect(res.totalCeded.amount).toBe(100);
    expect(res.retained.amount).toBe(0);
    // The higher-priority rule keeps its full share; the lower-priority one is trimmed.
    expect(res.allocations.find((a) => a.ruleId === 'a')!.amount.amount).toBe(60);
    expect(res.allocations.find((a) => a.ruleId === 'b')!.amount.amount).toBe(40);
  });

  it('conservation: allocations + retained always equals the source exactly', () => {
    const rules = [
      rule({ id: 'a', cessionPct: 33.3333, priority: 1 }),
      rule({ id: 'b', cessionPct: 21.7, priority: 2 }),
      rule({ id: 'c', cessionPct: 7.09, priority: 3 }),
    ];
    for (const amt of [0, 1, 7, 99, 101, 12_345, 9_999_999, 10_000_001]) {
      const res = allocateRetrocession(premium(amt), rules);
      const sum = res.allocations.reduce((s, a) => s + a.amount.amount, 0);
      expect(sum).toBe(res.totalCeded.amount);
      expect(sum + res.retained.amount).toBe(amt);
      expect(sum).toBeLessThanOrEqual(amt);
    }
  });

  it('orders allocations by priority then rule id, deterministically', () => {
    const rules = [
      rule({ id: 'z', cessionPct: 10, priority: 50 }),
      rule({ id: 'a', cessionPct: 10, priority: 50 }),
      rule({ id: 'm', cessionPct: 10, priority: 10 }),
    ];
    const res = allocateRetrocession(premium(1000), rules);
    expect(res.allocations.map((a) => a.ruleId)).toEqual(['m', 'a', 'z']);
  });
});

describe('allocateRetrocession: surplus cession', () => {
  // A surplus rule: retention line of $10,000 (1,000,000 minor) with 9 lines of
  // capacity (max ceded = 9,000,000 above the retention).
  const surplus = (over: Partial<RetroAllocationRule> = {}): RetroAllocationRule =>
    rule({ method: 'SURPLUS', cessionPct: undefined, retentionMinor: 1_000_000, maxLines: 9, ...over });

  it('cedes nothing when the source is at or below the retention line', () => {
    const res = allocateRetrocession(premium(1_000_000), [surplus()]);
    expect(res.allocations[0]!.amount.amount).toBe(0);
    expect(res.retained.amount).toBe(1_000_000);
    expect(res.allocations[0]!.method).toBe('SURPLUS');
  });

  it('cedes the whole surplus above the retention when within capacity', () => {
    // source 5,000,000; retention 1,000,000; surplus 4,000,000 (< capacity 9,000,000).
    const res = allocateRetrocession(premium(5_000_000), [surplus()]);
    expect(res.allocations[0]!.amount.amount).toBe(4_000_000);
    expect(res.totalCeded.amount).toBe(4_000_000);
    expect(res.retained.amount).toBe(1_000_000);
    // Realised share = 4,000,000 / 5,000,000 = 80%.
    expect(res.allocations[0]!.cessionPct).toBe(80);
  });

  it('caps the cession at retention × maxLines of capacity', () => {
    // source 20,000,000; retention 1,000,000; capacity 9,000,000 → ceded 9,000,000.
    const res = allocateRetrocession(premium(20_000_000), [surplus()]);
    expect(res.allocations[0]!.amount.amount).toBe(9_000_000);
    expect(res.retained.amount).toBe(11_000_000);
    expect(res.totalCeded.amount).toBeLessThanOrEqual(20_000_000);
  });

  it('conservation: surplus allocation never exceeds the source', () => {
    for (const amt of [0, 1, 999_999, 1_000_000, 1_000_001, 4_500_000, 10_000_000, 50_000_000]) {
      const res = allocateRetrocession(premium(amt), [surplus()]);
      const sum = res.allocations.reduce((s, a) => s + a.amount.amount, 0);
      expect(sum).toBe(res.totalCeded.amount);
      expect(sum + res.retained.amount).toBe(amt);
      expect(sum).toBeLessThanOrEqual(amt);
    }
  });
});

describe('allocateRetrocession: XL layer cession', () => {
  // XL layer: $40,000 xs $10,000 (limit 4,000,000 minor, attachment 1,000,000 minor).
  const xl = (over: Partial<RetroAllocationRule> = {}): RetroAllocationRule =>
    rule({ method: 'XL', cessionPct: undefined, attachmentMinor: 1_000_000, limitMinor: 4_000_000, ...over });

  it('cedes nothing when the source is at or below the attachment', () => {
    const res = allocateRetrocession(premium(1_000_000), [xl()]);
    expect(res.allocations[0]!.amount.amount).toBe(0);
    expect(res.retained.amount).toBe(1_000_000);
    expect(res.allocations[0]!.method).toBe('XL');
  });

  it('cedes the excess above the attachment while inside the limit', () => {
    // source 3,000,000; attachment 1,000,000 → excess 2,000,000 (< limit 4,000,000).
    const res = allocateRetrocession(premium(3_000_000), [xl()]);
    expect(res.allocations[0]!.amount.amount).toBe(2_000_000);
    expect(res.retained.amount).toBe(1_000_000);
  });

  it('caps the cession at the layer limit for a large source', () => {
    // source 10,000,000; attachment 1,000,000; excess 9,000,000 capped to limit 4,000,000.
    const res = allocateRetrocession(premium(10_000_000), [xl()]);
    expect(res.allocations[0]!.amount.amount).toBe(4_000_000);
    expect(res.retained.amount).toBe(6_000_000);
  });

  it('conservation: XL allocation never exceeds the source', () => {
    for (const amt of [0, 1, 999_999, 1_000_000, 1_000_001, 4_999_999, 5_000_000, 5_000_001, 100_000_000]) {
      const res = allocateRetrocession(premium(amt), [xl()]);
      const sum = res.allocations.reduce((s, a) => s + a.amount.amount, 0);
      expect(sum).toBe(res.totalCeded.amount);
      expect(sum + res.retained.amount).toBe(amt);
      expect(sum).toBeLessThanOrEqual(amt);
    }
  });

  it('mixes methods across rules and still caps the combined total at the source', () => {
    const rules = [
      rule({ id: 'qs', method: 'QUOTA_SHARE', cessionPct: 50, priority: 10 }),
      rule({ id: 'xl', method: 'XL', cessionPct: undefined, attachmentMinor: 0, limitMinor: 4_000_000, priority: 20 }),
    ];
    // QS 50% of 6,000,000 = 3,000,000; XL 0 xs 0 up to 4,000,000 = 4,000,000;
    // combined 7,000,000 > source 6,000,000 → trimmed to 6,000,000.
    const res = allocateRetrocession(premium(6_000_000), rules);
    expect(res.totalCeded.amount).toBe(6_000_000);
    expect(res.retained.amount).toBe(0);
    // Higher-priority QS keeps its full 3,000,000; the XL line is trimmed.
    expect(res.allocations.find((a) => a.ruleId === 'qs')!.amount.amount).toBe(3_000_000);
    expect(res.allocations.find((a) => a.ruleId === 'xl')!.amount.amount).toBe(3_000_000);
  });
});

describe('allocateRetrocession: validation', () => {
  it('rejects cessionPct outside (0, 100]', () => {
    expect(() => allocateRetrocession(premium(1000), [rule({ cessionPct: 0 })])).toThrow(RangeError);
    expect(() => allocateRetrocession(premium(1000), [rule({ cessionPct: -5 })])).toThrow(RangeError);
    expect(() => allocateRetrocession(premium(1000), [rule({ cessionPct: 100.01 })])).toThrow(RangeError);
    expect(() => allocateRetrocession(premium(1000), [rule({ cessionPct: 100 })])).not.toThrow();
  });

  it('rejects surplus/XL rules missing their required params', () => {
    expect(() => allocateRetrocession(premium(1000), [rule({ method: 'SURPLUS', cessionPct: undefined })])).toThrow(RangeError);
    expect(() => allocateRetrocession(premium(1000), [rule({ method: 'SURPLUS', cessionPct: undefined, retentionMinor: 0, maxLines: 9 })])).toThrow(RangeError);
    expect(() => allocateRetrocession(premium(1000), [rule({ method: 'XL', cessionPct: undefined })])).toThrow(RangeError);
    expect(() => allocateRetrocession(premium(1000), [rule({ method: 'XL', cessionPct: undefined, attachmentMinor: 0, limitMinor: 0 })])).toThrow(RangeError);
  });

  it('rejects unsupported methods and negative source amounts', () => {
    expect(() =>
      allocateRetrocession(premium(1000), [rule({ method: 'BOGUS' as unknown as 'QUOTA_SHARE' })]),
    ).toThrow(RangeError);
    expect(() => allocateRetrocession(premium(-1), [rule()])).toThrow();
  });

  it('keeps the source currency on every output', () => {
    const res = allocateRetrocession(
      { kind: 'CLAIM', amount: money(1_000_000, 'JPY'), lineOfBusiness: null, eventDate: '2026-01-01' },
      [rule({ appliesTo: 'CLAIM' })],
    );
    expect(res.allocations[0]!.amount.currency).toBe('JPY');
    expect(res.retained.currency).toBe('JPY');
  });
});
