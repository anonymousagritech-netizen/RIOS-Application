import { describe, it, expect } from 'vitest';
import { maskValue, applyMasking, type FieldPolicy } from '../src/masking.js';

describe('maskValue', () => {
  it('redacts, hashes and partially masks', () => {
    expect(maskValue('123456789', 'redact')).toBe('••••••');
    expect(maskValue('123456789', 'partial')).toBe('•••••6789');
    expect(maskValue('ab', 'partial')).toBe('••••••');      // too short → full redact
    expect(maskValue('secret', 'hash')).toMatch(/^hash:[0-9a-f]{8}$/);
    expect(maskValue('keep', 'none')).toBe('keep');
    expect(maskValue(null, 'redact')).toBe(null);
  });

  it('fully redacts objects regardless of strategy', () => {
    expect(maskValue({ naic: '12345' }, 'partial')).toBe('••••••');
  });

  it('is deterministic for hashing', () => {
    expect(maskValue('x', 'hash')).toBe(maskValue('x', 'hash'));
  });
});

describe('applyMasking', () => {
  const policies: FieldPolicy[] = [
    { field: 'identifiers', requiredPermission: 'pii:view', strategy: 'redact' },
    { field: 'taxId', requiredPermission: 'pii:view', strategy: 'partial' },
  ];

  it('masks fields when the viewer lacks the permission', () => {
    const r = applyMasking({ name: 'Acme', taxId: '987654321', identifiers: { lei: 'X' } }, policies, []);
    expect(r.record.name).toBe('Acme');
    expect(r.record.taxId).toBe('•••••4321');
    expect(r.record.identifiers).toBe('••••••');
    expect(r.maskedFields.sort()).toEqual(['identifiers', 'taxId']);
  });

  it('returns raw values when the viewer holds the permission', () => {
    const r = applyMasking({ taxId: '987654321' }, policies, ['pii:view']);
    expect(r.record.taxId).toBe('987654321');
    expect(r.maskedFields).toEqual([]);
  });

  it('admin:manage always sees raw values', () => {
    const r = applyMasking({ taxId: '987654321' }, policies, ['admin:manage']);
    expect(r.record.taxId).toBe('987654321');
    expect(r.maskedFields).toEqual([]);
  });
});
