import { describe, it, expect } from 'vitest';
import {
  STRUCTURES, LINES_OF_BUSINESS, getStructure, getLine,
  modelFieldsFor, validateTerms, modelCatalog,
} from './underwritingModels.js';

describe('underwriting model catalog', () => {
  it('exposes structures and lines with unique, stable keys', () => {
    const sKeys = STRUCTURES.map((s) => s.key);
    const lKeys = LINES_OF_BUSINESS.map((l) => l.key);
    expect(new Set(sKeys).size).toBe(sKeys.length);
    expect(new Set(lKeys).size).toBe(lKeys.length);
    expect(sKeys).toContain('CAT_XL');
    expect(lKeys).toContain('AGRICULTURE');
  });

  it('every field key within a structure/line is unique', () => {
    for (const s of STRUCTURES) {
      const keys = s.fields.map((f) => f.key);
      expect(new Set(keys).size, `dup in ${s.key}`).toBe(keys.length);
    }
    for (const l of LINES_OF_BUSINESS) {
      const keys = l.fields.map((f) => f.key);
      expect(new Set(keys).size, `dup in ${l.key}`).toBe(keys.length);
    }
  });

  it('select fields always carry options', () => {
    for (const model of [...STRUCTURES, ...LINES_OF_BUSINESS]) {
      for (const f of model.fields) {
        if (f.type === 'select') expect(f.options?.length, `${model.key}.${f.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('resolves structures and lines by key', () => {
    expect(getStructure('QUOTA_SHARE')?.basis).toBe('PROPORTIONAL');
    expect(getStructure('PER_RISK_XL')?.basis).toBe('NON_PROPORTIONAL');
    expect(getLine('PROPERTY')?.catExposed).toBe(true);
    expect(getStructure('NOPE')).toBeUndefined();
    expect(getLine(null)).toBeUndefined();
  });

  it('combines structure + line fields', () => {
    const fields = modelFieldsFor('CAT_XL', 'PROPERTY');
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('peril');            // from structure
    expect(keys).toContain('totalInsuredValueMinor'); // from line
  });

  it('flags missing required terms', () => {
    const bad = validateTerms('CAT_XL', 'PROPERTY', { peril: 'Earthquake' });
    expect(bad.ok).toBe(false);
    expect(bad.missing).toContain('attachmentMinor');
    expect(bad.missing).toContain('limitMinor');
    expect(bad.missing).toContain('totalInsuredValueMinor');
  });

  it('passes when all required terms present and ignores reserved keys', () => {
    const good = validateTerms('CAT_XL', 'PROPERTY', {
      attachmentMinor: 1000, limitMinor: 5000, peril: 'Windstorm',
      totalInsuredValueMinor: 999, capacityUtilPct: 40, notes: 'ok',
    });
    expect(good.ok).toBe(true);
    expect(good.missing).toHaveLength(0);
    expect(good.unknown).toHaveLength(0);
  });

  it('reports unknown (off-model) keys informationally', () => {
    const v = validateTerms('QUOTA_SHARE', 'PROPERTY', { cessionPct: 30, totalInsuredValueMinor: 1000, bogus: 1 });
    expect(v.unknown).toContain('bogus');
    expect(v.ok).toBe(true); // unknown keys don't fail validation
  });

  it('serves a catalog snapshot', () => {
    const cat = modelCatalog();
    expect(cat.structures.length).toBe(STRUCTURES.length);
    expect(cat.lines.length).toBe(LINES_OF_BUSINESS.length);
  });
});
