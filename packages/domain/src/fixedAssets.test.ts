import { describe, it, expect } from 'vitest';
import { depreciationSchedule, netBookValue, disposal, type AssetInput } from './fixedAssets.js';

describe('fixedAssets.depreciationSchedule (straight-line)', () => {
  const asset: AssetInput = { costMinor: 1_000_000, residualMinor: 100_000, usefulLifeYears: 3 };

  it('spreads cost minus residual evenly and ties to the total', () => {
    const s = depreciationSchedule(asset);
    expect(s).toHaveLength(3);
    const total = s.reduce((a, r) => a + r.depreciationMinor, 0);
    expect(total).toBe(900_000); // cost - residual
    expect(s[s.length - 1]!.closingNbvMinor).toBe(100_000); // ends at residual
    expect(s[0]!.depreciationMinor).toBe(300_000);
  });

  it('absorbs rounding in the final year so the schedule ties exactly', () => {
    const s = depreciationSchedule({ costMinor: 1_000_000, residualMinor: 0, usefulLifeYears: 3 });
    const total = s.reduce((a, r) => a + r.depreciationMinor, 0);
    expect(total).toBe(1_000_000);
    // 1,000,000 / 3 => 333,333 each, final year 333,334
    expect(s[0]!.depreciationMinor).toBe(333_333);
    expect(s[2]!.depreciationMinor).toBe(333_334);
    expect(s[2]!.closingNbvMinor).toBe(0);
  });
});

describe('fixedAssets.depreciationSchedule (reducing-balance)', () => {
  it('applies the rate to the opening NBV and clears to residual in the final year', () => {
    const s = depreciationSchedule({ costMinor: 1_000_000, residualMinor: 100_000, usefulLifeYears: 3, method: 'REDUCING_BALANCE', decliningRate: 0.25 });
    expect(s[0]!.depreciationMinor).toBe(250_000); // 25% of 1,000,000
    expect(s[1]!.depreciationMinor).toBe(187_500); // 25% of 750,000
    // never below residual; final year ends exactly at residual
    expect(s[s.length - 1]!.closingNbvMinor).toBe(100_000);
    s.forEach((r) => expect(r.closingNbvMinor).toBeGreaterThanOrEqual(100_000));
  });
});

describe('fixedAssets.netBookValue & disposal', () => {
  const asset: AssetInput = { costMinor: 1_000_000, residualMinor: 100_000, usefulLifeYears: 3 };

  it('returns cost at year 0 and the closing NBV thereafter', () => {
    expect(netBookValue(asset, 0)).toBe(1_000_000);
    expect(netBookValue(asset, 1)).toBe(700_000);
    expect(netBookValue(asset, 3)).toBe(100_000);
  });

  it('computes a gain or loss on disposal vs carrying amount', () => {
    const gain = disposal(asset, 1, 800_000); // NBV 700k, proceeds 800k
    expect(gain.nbvMinor).toBe(700_000);
    expect(gain.gainLossMinor).toBe(100_000);
    const loss = disposal(asset, 1, 600_000);
    expect(loss.gainLossMinor).toBe(-100_000);
  });
});
