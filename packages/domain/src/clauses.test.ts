import { describe, it, expect } from 'vitest';
import { indexLayer, indexedRecovery, hoursClauseOccurrences, type DatedLoss } from './clauses.js';
import { money } from './money.js';

const usd = (major: number) => money(Math.round(major * 100), 'USD');

describe('clauses.indexLayer', () => {
  it('FULL index clause scales attachment and limit by settlement/base', () => {
    const r = indexLayer({ attachment: usd(1_000_000), limit: usd(4_000_000), baseIndex: 100, settlementIndex: 120 });
    expect(r.indexFactor).toBeCloseTo(1.2, 6);
    expect(r.indexedAttachment.amount).toBe(usd(1_200_000).amount);
    expect(r.indexedLimit.amount).toBe(usd(4_800_000).amount);
  });

  it('FRANCHISE does not index until inflation breaches the threshold', () => {
    const below = indexLayer({ attachment: usd(1_000_000), limit: usd(1_000_000), baseIndex: 100, settlementIndex: 108, clause: 'FRANCHISE', franchisePct: 10 });
    expect(below.indexFactor).toBe(1); // 8% < 10% => no indexation
    const above = indexLayer({ attachment: usd(1_000_000), limit: usd(1_000_000), baseIndex: 100, settlementIndex: 115, clause: 'FRANCHISE', franchisePct: 10 });
    expect(above.indexFactor).toBeCloseTo(1.15, 6); // breached => full indexation
  });

  it('SEVERE_INFLATION only indexes inflation above the franchise', () => {
    // 25% inflation, 10% franchise => indexed portion = 15% => factor 1.15
    const r = indexLayer({ attachment: usd(1_000_000), limit: usd(1_000_000), baseIndex: 100, settlementIndex: 125, clause: 'SEVERE_INFLATION', franchisePct: 10 });
    expect(r.indexFactor).toBeCloseTo(1.15, 6);
  });

  it('rejects non-positive indices', () => {
    expect(() => indexLayer({ attachment: usd(1), limit: usd(1), baseIndex: 0, settlementIndex: 1 })).toThrow(RangeError);
  });
});

describe('clauses.indexedRecovery', () => {
  it('recovers excess of the indexed attachment, capped at the indexed limit', () => {
    // indexed attach 1.2m, limit 4.8m; loss 3m => recovery 1.8m
    const r = indexedRecovery(usd(3_000_000), { attachment: usd(1_000_000), limit: usd(4_000_000), baseIndex: 100, settlementIndex: 120 });
    expect(r.recovery.amount).toBe(usd(1_800_000).amount);
    // loss below indexed attachment => zero
    expect(indexedRecovery(usd(1_000_000), { attachment: usd(1_000_000), limit: usd(4_000_000), baseIndex: 100, settlementIndex: 120 }).recovery.amount).toBe(0);
  });
});

describe('clauses.hoursClauseOccurrences', () => {
  const losses: DatedLoss[] = [
    { at: 0, amount: usd(100) },
    { at: 40, amount: usd(200) },   // within 72h of t=0
    { at: 71, amount: usd(150) },   // within 72h of t=0
    { at: 200, amount: usd(300) },  // new occurrence
    { at: 260, amount: usd(120) },  // within 72h of t=200
  ];

  it('groups losses into occurrences bounded by the hours window', () => {
    const occ = hoursClauseOccurrences(losses, 72);
    expect(occ).toHaveLength(2);
    expect(occ[0]!.lossCount).toBe(3);
    expect(occ[0]!.total.amount).toBe(usd(450).amount); // 100+200+150
    expect(occ[1]!.total.amount).toBe(usd(420).amount); // 300+120
    expect(occ[0]!.endAt).toBe(71);
  });

  it('handles empty input and rejects a non-positive window', () => {
    expect(hoursClauseOccurrences([], 72)).toEqual([]);
    expect(() => hoursClauseOccurrences(losses, 0)).toThrow(RangeError);
  });
});
