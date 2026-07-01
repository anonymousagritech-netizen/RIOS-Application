import { describe, it, expect } from 'vitest';
import { layerRateOnLine, layerPremiumFromRol, priceLayer, treatyLayerBook } from './treatyLayer.js';
const M = (n: number) => n * 100;
describe('treaty layers', () => {
  it('computes rate on line both ways', () => {
    expect(layerRateOnLine(M(1_500_000), M(10_000_000))).toBe(15);
    expect(layerPremiumFromRol(M(10_000_000), 15)).toBe(M(1_500_000));
  });
  it('prices a layer with derived RoL and reinstated limit', () => {
    const l = priceLayer({ attachmentMinor: M(10_000_000), limitMinor: M(20_000_000), premiumMinor: M(3_000_000), reinstatements: 2 });
    expect(l.rolPct).toBe(15);
    expect(l.topMinor).toBe(M(30_000_000));
    expect(l.reinstatedLimitMinor).toBe(M(60_000_000)); // limit × 3
  });
  it('treats null reinstatements as unlimited (reinstated = limit)', () => {
    const l = priceLayer({ attachmentMinor: 0, limitMinor: M(5_000_000), rolPct: 10, reinstatements: null });
    expect(l.premiumMinor).toBe(M(500_000));
    expect(l.reinstatedLimitMinor).toBe(M(5_000_000));
  });
  it('rolls a tower into programme analytics', () => {
    const book = treatyLayerBook([
      { attachmentMinor: M(10_000_000), limitMinor: M(20_000_000), premiumMinor: M(3_000_000), reinstatements: 1 },
      { attachmentMinor: M(30_000_000), limitMinor: M(50_000_000), rolPct: 8, reinstatements: 1 },
    ]);
    expect(book.layerCount).toBe(2);
    expect(book.totalLimitMinor).toBe(M(70_000_000));
    expect(book.programmeTopMinor).toBe(M(80_000_000));
    expect(book.totalPremiumMinor).toBe(M(3_000_000) + M(4_000_000)); // 8% of 50m = 4m
    // weighted RoL = 7m / 70m = 10%
    expect(book.weightedRolPct).toBe(10);
  });
});
