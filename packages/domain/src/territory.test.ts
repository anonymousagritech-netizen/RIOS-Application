import { describe, it, expect } from 'vitest';
import { territoryBook, territoryRiskScore, territoryBand, gradeRank } from './territory.js';

describe('territory risk analytics', () => {
  it('territoryBand maps scores to severity bands', () => {
    expect(territoryBand(90)).toBe('SEVERE');
    expect(territoryBand(70)).toBe('HIGH');
    expect(territoryBand(50)).toBe('ELEVATED');
    expect(territoryBand(30)).toBe('MODERATE');
    expect(territoryBand(10)).toBe('LOW');
    expect(territoryBand(-5)).toBe('LOW');
    expect(territoryBand(200)).toBe('SEVERE');
  });

  it('territoryRiskScore anchors on grade and lifts with PML and share', () => {
    const low = territoryRiskScore({ riskGrade: 'LOW', pmlRatioPct: 0, sharePct: 0 });
    const severe = territoryRiskScore({ riskGrade: 'SEVERE', pmlRatioPct: 40, sharePct: 30 });
    expect(low).toBeLessThan(severe);
    expect(severe).toBeGreaterThan(75);
    // Missing grade falls back to a neutral anchor.
    expect(territoryRiskScore({ pmlRatioPct: 0, sharePct: 0 })).toBeCloseTo(24, 0);
  });

  it('territoryBook rolls TIV/PML, share, peak and high-risk count', () => {
    const book = territoryBook([
      { code: 'US-FL', name: 'Florida', tivMinor: 60_000_000_00, pmlMinor: 18_000_000_00, itemCount: 8, riskGrade: 'SEVERE' },
      { code: 'GB-LN', name: 'London', tivMinor: 20_000_000_00, pmlMinor: 2_000_000_00, itemCount: 2, riskGrade: 'MODERATE' },
    ]);
    expect(book.territoryCount).toBe(2);
    expect(book.totalTivMinor).toBe(80_000_000_00);
    expect(book.totalItems).toBe(10);
    // Peak is the largest TIV territory, sorted first.
    expect(book.peakTivCode).toBe('US-FL');
    expect(book.rows[0]!.code).toBe('US-FL');
    expect(book.rows[0]!.sharePct).toBe(75);
    // FL PML ratio = 18/60 = 30%.
    expect(book.rows[0]!.pmlRatioPct).toBe(30);
    // Severe + high share => banded HIGH or SEVERE.
    expect(book.highRiskCount).toBeGreaterThanOrEqual(1);
    // Book PML ratio = 20/80 = 25%.
    expect(book.bookPmlRatioPct).toBe(25);
  });

  it('empty book is safe', () => {
    const book = territoryBook([]);
    expect(book.totalTivMinor).toBe(0);
    expect(book.peakTivCode).toBeNull();
    expect(book.bookPmlRatioPct).toBe(0);
  });

  it('gradeRank orders grades by severity', () => {
    expect(gradeRank('LOW')).toBeLessThan(gradeRank('SEVERE'));
    expect(gradeRank(null)).toBe(-1);
  });
});
