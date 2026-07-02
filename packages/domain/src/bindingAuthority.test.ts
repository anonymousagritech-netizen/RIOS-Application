import { describe, it, expect } from 'vitest';
import { checkBindingAuthority, type Authority } from './bindingAuthority.js';

const M = (major: number) => major * 100;

const grant: Authority = {
  lob: 'Property',
  territory: 'UK',
  maxLineMinor: M(1_000_000),
  maxAggregateMinor: M(5_000_000),
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  status: 'ACTIVE',
};

describe('binding authority check', () => {
  it('passes a within-limits, in-scope risk (no referral)', () => {
    const r = checkBindingAuthority({
      authority: grant, lob: 'Property', territory: 'UK',
      lineMinor: M(500_000), priorAggregateMinor: M(1_000_000), asOf: '2026-06-01',
    });
    expect(r.withinAuthority).toBe(true);
    expect(r.breaches).toEqual([]);
    expect(r.referralRequired).toBe(false);
  });

  it('flags a LINE breach when the single line exceeds the per-risk max', () => {
    const r = checkBindingAuthority({
      authority: grant, lob: 'Property', territory: 'UK',
      lineMinor: M(1_500_000), asOf: '2026-06-01',
    });
    expect(r.breaches).toContain('LINE');
    expect(r.withinAuthority).toBe(false);
    expect(r.referralRequired).toBe(true);
  });

  it('flags an AGGREGATE breach when consumed + line exceeds the cap', () => {
    const r = checkBindingAuthority({
      authority: grant, lob: 'Property', territory: 'UK',
      lineMinor: M(800_000), priorAggregateMinor: M(4_500_000), asOf: '2026-06-01',
    });
    expect(r.breaches).toContain('AGGREGATE');
    expect(r.referralRequired).toBe(true);
  });

  it('flags a LOB breach when the risk is outside the granted class', () => {
    const r = checkBindingAuthority({
      authority: grant, lob: 'Marine', territory: 'UK',
      lineMinor: M(100_000), asOf: '2026-06-01',
    });
    expect(r.breaches).toContain('LOB');
  });

  it('flags a TERRITORY breach when the risk is outside the granted territory', () => {
    const r = checkBindingAuthority({
      authority: grant, lob: 'Property', territory: 'France',
      lineMinor: M(100_000), asOf: '2026-06-01',
    });
    expect(r.breaches).toContain('TERRITORY');
  });

  it('flags EXPIRED when the as-of date is past the validity window', () => {
    const r = checkBindingAuthority({
      authority: grant, lob: 'Property', territory: 'UK',
      lineMinor: M(100_000), asOf: '2027-02-01',
    });
    expect(r.breaches).toContain('EXPIRED');
  });

  it('flags EXPIRED when the grant is suspended', () => {
    const r = checkBindingAuthority({
      authority: { ...grant, status: 'SUSPENDED' }, lob: 'Property', territory: 'UK',
      lineMinor: M(100_000), asOf: '2026-06-01',
    });
    expect(r.breaches).toContain('EXPIRED');
  });

  it('treats an unscoped grant (null lob/territory) as covering any class or territory', () => {
    const open: Authority = { ...grant, lob: null, territory: null };
    const r = checkBindingAuthority({
      authority: open, lob: 'Aviation', territory: 'Japan',
      lineMinor: M(100_000), asOf: '2026-06-01',
    });
    expect(r.withinAuthority).toBe(true);
  });

  it('reports every breached bound together', () => {
    const r = checkBindingAuthority({
      authority: grant, lob: 'Marine', territory: 'France',
      lineMinor: M(2_000_000), priorAggregateMinor: M(5_000_000), asOf: '2027-02-01',
    });
    expect(r.breaches.sort()).toEqual(['AGGREGATE', 'EXPIRED', 'LINE', 'LOB', 'TERRITORY']);
  });
});
