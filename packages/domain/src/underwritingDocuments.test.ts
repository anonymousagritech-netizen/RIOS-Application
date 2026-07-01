import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_KINDS, documentKindSpec, inferKind, extractDocument, nextVersion, signatureDigest,
} from './underwritingDocuments.js';

describe('underwriting documents', () => {
  it('exposes a kind catalog with unique kinds', () => {
    const kinds = DOCUMENT_KINDS.map((k) => k.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(documentKindSpec('SOV').expects).toContain('totalInsuredValue');
    expect(documentKindSpec('NOPE').kind).toBe('OTHER');
  });

  it('infers document kind from the file name', () => {
    expect(inferKind('Acme_SOV_2026.xlsx')).toBe('SOV');
    expect(inferKind('loss run 5yr.pdf')).toBe('LOSS_RUN');
    expect(inferKind('policy wording v3.docx')).toBe('WORDING');
    expect(inferKind('bordereau_q1.csv')).toBe('BORDEREAU');
    expect(inferKind('RE: quote slip.eml')).toBe('EMAIL');
    expect(inferKind('random.bin')).toBe('OTHER');
  });

  it('extracts a stable, kind-appropriate field set', () => {
    const a = extractDocument('SOV', 'Acme_SOV_2026.xlsx');
    const b = extractDocument('SOV', 'Acme_SOV_2026.xlsx');
    expect(a).toEqual(b); // deterministic
    expect(a.provider).toBe('mock-ocr');
    // Every field/unresolved key belongs to the kind's expected set.
    const expected = documentKindSpec('SOV').expects;
    for (const f of a.fields) expect(expected).toContain(f.key);
    for (const u of a.unresolved) expect(expected).toContain(u);
    expect(a.fields.length + a.unresolved.length).toBe(expected.length);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
  });

  it('versions a chain', () => {
    expect(nextVersion(null)).toBe(1);
    expect(nextVersion(3)).toBe(4);
  });

  it('produces a stable signature digest', () => {
    const d1 = signatureDigest(['sub-1', 'v1', 'user-a']);
    const d2 = signatureDigest(['sub-1', 'v1', 'user-a']);
    const d3 = signatureDigest(['sub-1', 'v2', 'user-a']);
    expect(d1).toBe(d2);
    expect(d1).not.toBe(d3);
    expect(d1).toMatch(/^sha-[0-9a-f]{8}$/);
  });
});
