import { describe, it, expect } from 'vitest';
import { hasActiveHold, retentionVerdict, ageInDays, type LegalHold } from '../src/retention.js';

describe('legal holds', () => {
  const holds: LegalHold[] = [
    { entityType: 'claim', active: true },                 // covers all claims
    { entityType: 'party', entityId: 'p-1', active: true }, // covers one party
    { active: false },                                      // inactive global
  ];

  it('matches scoped and global holds', () => {
    expect(hasActiveHold(holds, 'claim', 'anything')).toBe(true);
    expect(hasActiveHold(holds, 'party', 'p-1')).toBe(true);
    expect(hasActiveHold(holds, 'party', 'p-2')).toBe(false);
    expect(hasActiveHold(holds, 'contract')).toBe(false);
  });

  it('treats an unscoped active hold as global', () => {
    expect(hasActiveHold([{ active: true }], 'contract', 'c-9')).toBe(true);
  });
});

describe('retention verdict', () => {
  it('is eligible only once aged out and not on hold', () => {
    expect(retentionVerdict(400, 365, false)).toMatchObject({ eligible: true, reason: 'eligible' });
    expect(retentionVerdict(100, 365, false)).toMatchObject({ eligible: false, reason: 'within_retention' });
  });

  it('lets a legal hold override an aged-out record', () => {
    const v = retentionVerdict(1000, 365, true);
    expect(v.eligible).toBe(false);
    expect(v.reason).toBe('legal_hold');
  });
});

describe('age in days', () => {
  it('computes whole days and never goes negative', () => {
    const day = 86_400_000;
    expect(ageInDays(0, 10 * day)).toBe(10);
    expect(ageInDays(5 * day, 5 * day)).toBe(0);
    expect(ageInDays(10 * day, 5 * day)).toBe(0); // future record → 0, not negative
  });
});
