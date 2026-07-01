import { describe, it, expect } from 'vitest';
import { applyMapping, mapRow, ingestBordereau, toPremiumEvents } from './bordereaux.js';

describe('bordereaux.applyMapping', () => {
  it('projects source columns onto canonical fields, first present wins', () => {
    const raw = { 'Gross Prem': 1000, 'Policy No': 'P-1', blank: '' };
    const mapped = applyMapping(raw, { amount: ['Premium', 'Gross Prem'], policyRef: 'Policy No', reference: 'blank' });
    expect(mapped.amount).toBe(1000);
    expect(mapped.policyRef).toBe('P-1');
    expect(mapped.reference).toBeUndefined(); // blank string is treated as absent
    expect(mapped['Gross Prem']).toBe(1000); // originals preserved
  });
});

describe('bordereaux.mapRow validation', () => {
  it('accepts a positive premium and quantises to minor units', () => {
    const r = mapRow({ amount: 1000 }, 1, 'PREMIUM', 'USD');
    expect(r.isValid).toBe(true);
    expect(r.amountMinor).toBe(100000);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects a missing or non-positive amount with the canonical message', () => {
    expect(mapRow({}, 1, 'PREMIUM', 'USD').errors).toContain('amount missing or not positive');
    expect(mapRow({ amount: 0 }, 1, 'PREMIUM', 'USD').errors).toContain('amount missing or not positive');
    expect(mapRow({ amount: -5 }, 1, 'PREMIUM', 'USD').errors).toContain('amount missing or not positive');
    expect(mapRow({ amount: 'x' }, 1, 'PREMIUM', 'USD').errors).toContain('amount missing or not positive');
  });

  it('reads premium/loss aliases by kind', () => {
    expect(mapRow({ premium: 10 }, 1, 'PREMIUM', 'USD').amountMinor).toBe(1000);
    expect(mapRow({ loss: 25 }, 1, 'LOSS', 'USD').amountMinor).toBe(2500);
    // wrong alias for the kind does not resolve
    expect(mapRow({ loss: 10 }, 1, 'PREMIUM', 'USD').isValid).toBe(false);
  });

  it('validates loss date shape for loss bordereaux', () => {
    expect(mapRow({ loss: 10, lossDate: 12345 }, 1, 'LOSS', 'USD').errors).toContain('lossDate must be a string date');
    expect(mapRow({ loss: 10, lossDate: '2026-01-01' }, 1, 'LOSS', 'USD').isValid).toBe(true);
  });

  it('applies a mapping before validating', () => {
    const r = mapRow({ 'Loss Amt': 500, DOL: '2026-03-02' }, 1, 'LOSS', 'USD', { loss: 'Loss Amt', lossDate: 'DOL' });
    expect(r.isValid).toBe(true);
    expect(r.amountMinor).toBe(50000);
  });
});

describe('bordereaux.ingestBordereau', () => {
  const rows = [{ amount: 1000 }, { amount: 2500 }];

  it('totals valid lines and accepts a clean file with no control total', () => {
    const res = ingestBordereau({ kind: 'PREMIUM', currency: 'USD', rows });
    expect(res.validCount).toBe(2);
    expect(res.invalidCount).toBe(0);
    expect(res.totalMinor).toBe(350000);
    expect(res.reconciles).toBe(true);
    expect(res.accepted).toBe(true);
  });

  it('rejects when any line is invalid', () => {
    const res = ingestBordereau({ kind: 'PREMIUM', currency: 'USD', rows: [{ amount: 1000 }, { amount: -1 }] });
    expect(res.invalidCount).toBe(1);
    expect(res.accepted).toBe(false);
  });

  it('reconciles the line sum against a declared control total', () => {
    const ok = ingestBordereau({ kind: 'PREMIUM', currency: 'USD', rows, controlTotalMajor: 3500 });
    expect(ok.controlTotalMinor).toBe(350000);
    expect(ok.varianceMinor).toBe(0);
    expect(ok.reconciles).toBe(true);
    expect(ok.accepted).toBe(true);
  });

  it('rejects a valid-but-out-of-balance file (control total mismatch)', () => {
    const bad = ingestBordereau({ kind: 'PREMIUM', currency: 'USD', rows, controlTotalMajor: 4000 });
    expect(bad.invalidCount).toBe(0); // every line is individually valid...
    expect(bad.varianceMinor).toBe(350000 - 400000); // ...but the file does not tie out
    expect(bad.reconciles).toBe(false);
    expect(bad.accepted).toBe(false);
  });
});

describe('bordereaux.toPremiumEvents', () => {
  it('drafts financial events from valid premium lines only', () => {
    const res = ingestBordereau({
      kind: 'PREMIUM',
      currency: 'USD',
      rows: [{ amount: 1000, reference: 'R1' }, { amount: 0 }, { amount: 500, policyRef: 'P9' }],
    });
    const events = toPremiumEvents(res);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventType: 'INSTALMENT_PREMIUM', amountMinor: 100000, reference: 'R1' });
    expect(events[1]).toMatchObject({ amountMinor: 50000, reference: 'P9' });
    // loss bordereaux produce no premium events
    expect(toPremiumEvents(ingestBordereau({ kind: 'LOSS', currency: 'USD', rows: [{ loss: 10 }] }))).toHaveLength(0);
  });
});
