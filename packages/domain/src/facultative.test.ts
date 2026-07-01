import { describe, it, expect } from 'vitest';
import { facPlacement, bestQuote, averageQuotedRate } from './facultative.js';

describe('facultative placement & quotes', () => {
  it('rolls placement lines and flags completeness', () => {
    const partial = facPlacement([
      { writtenPct: 60, signedPct: 50, premiumMinor: 500_00 },
      { writtenPct: 40, signedPct: 30, premiumMinor: 300_00 },
    ]);
    expect(partial.writtenPct).toBe(100);
    expect(partial.signedPct).toBe(80);
    expect(partial.shortfallPct).toBe(20);
    expect(partial.status).toBe('PARTIAL');
    expect(partial.premiumMinor).toBe(800_00);

    const complete = facPlacement([{ writtenPct: 100, signedPct: 100, premiumMinor: 1000 }]);
    expect(complete.status).toBe('COMPLETE');
    expect(complete.shortfallPct).toBe(0);

    const over = facPlacement([{ writtenPct: 80, signedPct: 70, premiumMinor: 0 }, { writtenPct: 60, signedPct: 50, premiumMinor: 0 }]);
    expect(over.signedPct).toBe(120);
    expect(over.oversubscribedPct).toBe(20);
    expect(over.status).toBe('OVERSUBSCRIBED');

    expect(facPlacement([]).status).toBe('UNPLACED');
  });

  it('bestQuote picks the lowest rate and ignores dead quotes', () => {
    const q = bestQuote([
      { id: 'a', ratePct: 2.5, sharePct: 50, premiumMinor: 100, status: 'QUOTED' },
      { id: 'b', ratePct: 1.8, sharePct: 40, premiumMinor: 90, status: 'QUOTED' },
      { id: 'c', ratePct: 0.5, sharePct: 30, premiumMinor: 10, status: 'DECLINED' },
    ]);
    expect(q?.id).toBe('b');
    expect(bestQuote([{ sharePct: 10, premiumMinor: 5, status: 'EXPIRED' }])).toBeNull();
  });

  it('averageQuotedRate averages only live rated quotes', () => {
    expect(averageQuotedRate([
      { sharePct: 10, premiumMinor: 1, ratePct: 2, status: 'QUOTED' },
      { sharePct: 10, premiumMinor: 1, ratePct: 4, status: 'QUOTED' },
      { sharePct: 10, premiumMinor: 1, ratePct: 100, status: 'DECLINED' },
    ])).toBe(3);
    expect(averageQuotedRate([])).toBe(0);
  });
});
