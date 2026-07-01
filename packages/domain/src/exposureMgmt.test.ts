import { describe, it, expect } from 'vitest';
import { aggregateExposure, exposureSummary, exposureHeatmap } from './exposureMgmt.js';

const M = (major: number) => major * 100;
const items = [
  { country: 'US', cresta: 'US-FL', peril: 'Windstorm', lineOfBusiness: 'PROPERTY', tivMinor: M(100), pmlMinor: M(20) },
  { country: 'US', cresta: 'US-FL', peril: 'Windstorm', lineOfBusiness: 'PROPERTY', tivMinor: M(50), pmlMinor: M(10) },
  { country: 'JP', cresta: 'JP-TK', peril: 'Earthquake', lineOfBusiness: 'PROPERTY', tivMinor: M(80), pmlMinor: M(30) },
  { country: 'GB', cresta: 'GB-LN', peril: 'Flood', lineOfBusiness: 'MARINE_CARGO', tivMinor: M(20), pmlMinor: M(5) },
];

describe('exposure management', () => {
  it('aggregates by dimension, largest first, with share', () => {
    const byCountry = aggregateExposure(items, 'country');
    expect(byCountry[0]!.key).toBe('US');
    expect(byCountry[0]!.tivMinor).toBe(M(150));
    expect(byCountry[0]!.items).toBe(2);
    expect(byCountry[0]!.sharePct).toBe(60); // 150 of 250
  });

  it('summarises with the peak accumulation zone', () => {
    const s = exposureSummary(items);
    expect(s.totalTivMinor).toBe(M(250));
    expect(s.totalPmlMinor).toBe(M(65));
    expect(s.itemCount).toBe(4);
    expect(s.peakZone?.key).toBe('US-FL'); // uses CRESTA
    expect(s.concentrationPct).toBe(60);
    expect(s.byPeril[0]!.key).toBe('US-FL' === s.peakZone?.key ? 'Windstorm' : s.byPeril[0]!.key);
  });

  it('falls back to country when no CRESTA present', () => {
    const noCresta = items.map((i) => ({ ...i, cresta: null }));
    const s = exposureSummary(noCresta);
    expect(s.peakZone?.key).toBe('US');
  });

  it('builds a peril × country heatmap', () => {
    const hm = exposureHeatmap(items, 'peril', 'country');
    expect(hm.rows).toContain('Windstorm');
    expect(hm.cols).toContain('US');
    const cell = hm.cells.find((c) => c.row === 'Windstorm' && c.col === 'US');
    expect(cell?.tivMinor).toBe(M(150));
  });
});
