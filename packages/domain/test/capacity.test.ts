import { describe, it, expect } from 'vitest';
import { utilisation, utilisationBand, totalSpendMinor, type CostLine } from '../src/capacity.js';

describe('utilisation', () => {
  it('computes used over provisioned', () => {
    expect(utilisation(21, 32)).toBeCloseTo(0.65625, 6);
    expect(utilisation(0, 10)).toBe(0);
    expect(utilisation(5, 0)).toBe(0);    // nothing provisioned
    expect(utilisation(5, null)).toBe(0);
  });

  it('bands the fraction', () => {
    expect(utilisationBand(0.2)).toBe('idle');
    expect(utilisationBand(0.6)).toBe('normal');
    expect(utilisationBand(0.9)).toBe('high');
    expect(utilisationBand(1.3)).toBe('over');
  });
});

describe('total spend', () => {
  it('sums cost lines', () => {
    const lines: CostLine[] = [{ category: 'a', amountMinor: 100 }, { category: 'b', amountMinor: 250 }];
    expect(totalSpendMinor(lines)).toBe(350);
    expect(totalSpendMinor([])).toBe(0);
  });
});
