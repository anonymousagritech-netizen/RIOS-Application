/**
 * Natural-language search parsing - pure, deterministic, framework-free.
 *
 * Turns a free-text query ("bound cat treaties in 2026", "open claims for
 * Atlantic") into structured search intent: the residual search terms plus
 * detected filters (entity types, a status, a year). No LLM, no I/O - a
 * transparent keyword grammar so the same input always yields the same filters.
 */

export type SearchEntityType = 'treaty' | 'party' | 'claim' | 'statement' | 'broker' | 'cedent' | 'submission';

export interface ParsedSearch {
  terms: string;                 // residual free-text after filters are stripped
  types: SearchEntityType[];     // entity types to restrict to (empty = all)
  status: string | null;         // a status keyword, upper-cased
  year: number | null;           // a 4-digit year if present
  raw: string;
}

// Singular/plural keyword → canonical entity type.
const TYPE_WORDS: Record<string, SearchEntityType> = {
  treaty: 'treaty', treaties: 'treaty', contract: 'treaty', contracts: 'treaty',
  party: 'party', parties: 'party', counterparty: 'party',
  claim: 'claim', claims: 'claim', loss: 'claim', losses: 'claim',
  statement: 'statement', statements: 'statement', soa: 'statement',
  broker: 'broker', brokers: 'broker', intermediary: 'broker',
  cedent: 'cedent', cedents: 'cedent', reinsured: 'cedent',
  submission: 'submission', submissions: 'submission', quote: 'submission',
};

// Status keywords (order-insensitive), normalised to the DB's upper-case form.
const STATUS_WORDS: Record<string, string> = {
  bound: 'BOUND', active: 'ACTIVE', draft: 'DRAFT', expired: 'EXPIRED',
  open: 'OPEN', closed: 'CLOSED', settled: 'SETTLED', reserved: 'RESERVED',
  notified: 'NOTIFIED', pending: 'PENDING', approved: 'APPROVED',
};

// Noise words dropped from the residual terms.
const STOP = new Set(['in', 'for', 'the', 'a', 'an', 'of', 'with', 'and', 'on', 'to', 'show', 'me', 'find', 'all', 'list']);

/** Parse a natural-language query into structured search intent. */
export function parseSearchQuery(raw: string): ParsedSearch {
  const text = (raw ?? '').trim();
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);

  const types = new Set<SearchEntityType>();
  let status: string | null = null;
  let year: number | null = null;
  const residual: string[] = [];

  for (const tok of tokens) {
    const word = tok.replace(/[^a-z0-9]/g, '');
    if (!word) continue;
    if (TYPE_WORDS[word]) { types.add(TYPE_WORDS[word]); continue; }
    if (STATUS_WORDS[word] && status == null) { status = STATUS_WORDS[word]; continue; }
    if (/^\d{4}$/.test(word)) { const y = Number(word); if (y >= 1990 && y <= 2100) { year = y; continue; } }
    if (STOP.has(word)) continue;
    residual.push(word);
  }

  return { terms: residual.join(' '), types: [...types], status, year, raw: text };
}

/** A short human description of what the parser understood (for the UI). */
export function describeParsedSearch(p: ParsedSearch): string {
  const bits: string[] = [];
  if (p.status) bits.push(p.status.toLowerCase());
  if (p.types.length) bits.push(p.types.join('/'));
  else bits.push('everything');
  if (p.terms) bits.push(`matching "${p.terms}"`);
  if (p.year) bits.push(`in ${p.year}`);
  return `Searching ${bits.join(' ')}`.trim();
}
