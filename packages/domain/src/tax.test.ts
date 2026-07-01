import { describe, it, expect } from 'vitest';
import { computeLevies, withholdingTax, federalExciseTax, grossUp, type Levy } from './tax.js';

describe('tax.computeLevies', () => {
  it('charges each flat levy on the base and reconciles lines to total', () => {
    const levies: Levy[] = [
      { code: 'IPT', rate: 0.05 },
      { code: 'STAMP', rate: 0.01 },
    ];
    const r = computeLevies(1_000_000, levies); // base 10,000.00
    expect(r.lines.map((l) => l.amountMinor)).toEqual([50_000, 10_000]);
    expect(r.totalLevyMinor).toBe(60_000);
    expect(r.grossInclusiveMinor).toBe(1_060_000);
  });

  it('charges a compound levy on the base plus prior lines (cascading)', () => {
    const levies: Levy[] = [
      { code: 'IPT', rate: 0.10 },
      { code: 'STAMP', rate: 0.10, compound: true }, // on base + IPT
    ];
    const r = computeLevies(1_000_000, levies);
    expect(r.lines[0]!.amountMinor).toBe(100_000); // IPT on 1,000,000
    expect(r.lines[1]!.amountMinor).toBe(110_000); // STAMP on 1,100,000
    expect(r.totalLevyMinor).toBe(210_000);
  });
});

describe('tax.withholdingTax', () => {
  it('withholds at source and returns the net remitted', () => {
    const r = withholdingTax(1_000_000, 0.15);
    expect(r.taxMinor).toBe(150_000);
    expect(r.netMinor).toBe(850_000);
  });
});

describe('tax.federalExciseTax', () => {
  it('applies 1% by default to reinsurance premium', () => {
    const r = federalExciseTax({ premiumMinor: 10_000_000 });
    expect(r.taxableMinor).toBe(10_000_000);
    expect(r.fetMinor).toBe(100_000); // 1%
  });

  it('reduces the taxable base by the treaty exemption', () => {
    const r = federalExciseTax({ premiumMinor: 10_000_000, treatyExemptFraction: 1 });
    expect(r.taxableMinor).toBe(0);
    expect(r.fetMinor).toBe(0); // fully waived under an income-tax treaty
    const partial = federalExciseTax({ premiumMinor: 10_000_000, treatyExemptFraction: 0.5, ratePct: 1 });
    expect(partial.taxableMinor).toBe(5_000_000);
    expect(partial.fetMinor).toBe(50_000);
  });
});

describe('tax.grossUp', () => {
  it('grosses up a net amount so that gross - tax equals the net exactly', () => {
    const r = grossUp(850_000, 0.15);
    expect(r.grossMinor).toBe(1_000_000);
    expect(r.grossMinor - r.taxMinor).toBe(850_000);
  });
});
