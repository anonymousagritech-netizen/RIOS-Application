import { describe, it, expect } from 'vitest';
import { parseSearchQuery, describeParsedSearch } from './nlSearch.js';

describe('natural-language search parsing', () => {
  it('extracts types, status and year, leaving residual terms', () => {
    const p = parseSearchQuery('bound cat treaties in 2026');
    expect(p.types).toEqual(['treaty']);
    expect(p.status).toBe('BOUND');
    expect(p.year).toBe(2026);
    expect(p.terms).toBe('cat');
  });

  it('handles multiple types and drops noise words', () => {
    const p = parseSearchQuery('show me all open claims and statements for Atlantic');
    expect(p.types.sort()).toEqual(['claim', 'statement']);
    expect(p.status).toBe('OPEN');
    expect(p.terms).toBe('atlantic');
  });

  it('a plain name search yields no filters, just terms', () => {
    const p = parseSearchQuery('Helvetia Re');
    expect(p.types).toEqual([]);
    expect(p.status).toBeNull();
    expect(p.year).toBeNull();
    expect(p.terms).toBe('helvetia re');
  });

  it('only the first status wins; invalid years ignored', () => {
    const p = parseSearchQuery('draft bound treaties 1200');
    expect(p.status).toBe('DRAFT');
    expect(p.year).toBeNull();
    // The second status word can't be applied, so it falls through to the terms.
    expect(p.terms).toBe('bound 1200');
  });

  it('describeParsedSearch summarises the intent', () => {
    expect(describeParsedSearch(parseSearchQuery('bound treaties 2026'))).toContain('bound');
    expect(describeParsedSearch(parseSearchQuery('bound treaties 2026'))).toContain('2026');
    expect(describeParsedSearch(parseSearchQuery(''))).toContain('everything');
  });
});
