import { describe, it, expect } from 'vitest';
import {
  SII_BSCR_MODULES,
  SII_BSCR_CORRELATION,
  aggregateStandardFormulaBscr,
} from './solvencyCorrelations.js';
import { aggregateScr } from './solvency2.js';

describe('Solvency II standard-formula correlations', () => {
  it('ships a square, symmetric matrix with a unit diagonal matching the module list', () => {
    const n = SII_BSCR_MODULES.length;
    expect(SII_BSCR_CORRELATION).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(SII_BSCR_CORRELATION[i]).toHaveLength(n);
      expect(SII_BSCR_CORRELATION[i]![i]).toBe(1);
      for (let j = 0; j < n; j++) {
        expect(SII_BSCR_CORRELATION[i]![j]).toBe(SII_BSCR_CORRELATION[j]![i]);
      }
    }
  });

  it('aggregateStandardFormulaBscr reuses aggregateScr over the standard matrix', () => {
    const charges = { market: 1000, default: 200, life: 0, health: 0, nonLife: 800 };
    const ordered = SII_BSCR_MODULES.map((m) => (charges as Record<string, number>)[m] ?? 0);
    const expected = aggregateScr(ordered, SII_BSCR_CORRELATION.map((r) => [...r]));
    const res = aggregateStandardFormulaBscr({ charges });
    expect(res.diversifiedBscr).toBeCloseTo(expected, 6);
    // Diversification benefit: BSCR is strictly below the naive sum of charges.
    expect(res.bscr).toBeLessThan(1000 + 200 + 800);
    // ...and at least as large as the largest standalone charge.
    expect(res.bscr).toBeGreaterThanOrEqual(1000);
  });

  it('adds intangible-asset risk in quadrature (zero correlation)', () => {
    const base = aggregateStandardFormulaBscr({ charges: { market: 300, nonLife: 400 } });
    const withIntangible = aggregateStandardFormulaBscr({
      charges: { market: 300, nonLife: 400 },
      intangibleAssetRisk: 120,
    });
    const expected = Math.sqrt(base.diversifiedBscr ** 2 + 120 ** 2);
    expect(withIntangible.bscr).toBeCloseTo(expected, 6);
  });

  it('a full matrix of ones reproduces simple addition (undiversified)', () => {
    const scrs = [100, 200, 300];
    const ones = [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ];
    expect(aggregateScr(scrs, ones)).toBeCloseTo(600, 6);
  });
});
