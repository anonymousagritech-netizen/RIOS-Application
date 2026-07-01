import { describe, it, expect } from 'vitest';
import {
  recommendedClauses, missingInformation, attentionFlags, executiveSummary,
} from './underwritingAdvisor.js';

const M = (major: number) => major * 100;

describe('underwriting advisor', () => {
  it('recommends base + structure + line clauses without duplicates', () => {
    const clauses = recommendedClauses('CAT_XL', 'PROPERTY');
    const codes = clauses.map((c) => c.code);
    expect(codes).toContain('SANCTION');   // base
    expect(codes).toContain('HOURS');      // cat XL
    expect(codes).toContain('NATCAT');     // property
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('adds cyber-specific clauses for cyber business', () => {
    const codes = recommendedClauses('QUOTA_SHARE', 'CYBER').map((c) => c.code);
    expect(codes).toContain('CYBEREXC');
    expect(codes).toContain('COMM'); // quota-share commission
  });

  it('reports required-term and business gaps', () => {
    const gaps = missingInformation({ structure: 'CAT_XL', lineOfBusiness: 'PROPERTY', terms: {} });
    expect(gaps.some((g) => g.severity === 'required')).toBe(true);
    expect(gaps.some((g) => g.field === 'cedent')).toBe(true);
    expect(gaps.some((g) => g.field === 'period')).toBe(true);
  });

  it('flags a loss ratio over 100%', () => {
    const flags = attentionFlags({ lossRatioPct: 120, estPremiumMinor: M(1_000_000), limitMinor: M(10_000_000) });
    expect(flags.some((f) => f.code === 'LR_OVER_100' && f.severity === 'high')).toBe(true);
  });

  it('flags a thin rate on line', () => {
    const flags = attentionFlags({ estPremiumMinor: M(50_000), limitMinor: M(100_000_000) });
    expect(flags.some((f) => f.code === 'ROL_THIN')).toBe(true);
  });

  it('flags a new cedent relationship', () => {
    const flags = attentionFlags({ yearsWithCedent: 0 });
    expect(flags.some((f) => f.code === 'NEW_CEDENT')).toBe(true);
  });

  it('flags cat XL without a modelled return period', () => {
    const flags = attentionFlags({ catExposed: true, structure: 'CAT_XL', terms: {} });
    expect(flags.some((f) => f.code === 'NO_RETURN_PERIOD')).toBe(true);
    const ok = attentionFlags({ catExposed: true, structure: 'CAT_XL', terms: { returnPeriodYears: 100 } });
    expect(ok.some((f) => f.code === 'NO_RETURN_PERIOD')).toBe(false);
  });

  it('writes a readable executive summary', () => {
    const summary = executiveSummary({
      title: 'North Atlantic Property Cat XL', kind: 'TREATY', structure: 'CAT_XL', lineOfBusiness: 'PROPERTY',
      territory: 'US', cedentName: 'Acme Re', currency: 'USD', limitMinor: M(50_000_000), attachmentMinor: M(10_000_000),
      estPremiumMinor: M(5_000_000), lossRatioPct: 65, riskScore: 72, riskBand: 'ELEVATED', catExposed: true,
    });
    expect(summary).toContain('North Atlantic Property Cat XL');
    expect(summary).toContain('72/100');
    expect(summary.length).toBeGreaterThan(80);
  });
});
