/**
 * Underwriting document intelligence - pure, deterministic, framework-free.
 *
 * A submission's data room holds slips, statements of value (SOV), loss runs,
 * wordings, emails and financials. This module describes those document kinds and
 * provides:
 *
 *   - DOCUMENT_KINDS       the catalog (kind → label, expected extracted fields)
 *   - extractDocument      a deterministic "AI extraction" stub that returns the
 *                          structured fields a kind should yield, with confidence
 *   - nextVersion          version-chain helper (v1, v2 … on supersede)
 *   - signatureDigest      a content digest for a lightweight digital signature
 *
 * `extractDocument` is intentionally a stub with a stable interface: real OCR /
 * ML extraction (AWS Textract, Azure Document Intelligence, an in-house model)
 * plugs in behind the same signature without changing callers. This mirrors the
 * cat-model adapter pattern - build the seam now, connect the vendor later
 * (docs/open-questions.md).
 */

export type DocumentKind = 'SLIP' | 'SOV' | 'LOSS_RUN' | 'WORDING' | 'FINANCIALS' | 'EMAIL' | 'BORDEREAU' | 'OTHER';

export interface DocumentKindSpec {
  kind: DocumentKind;
  label: string;
  /** Field keys a good extraction of this kind should surface. */
  expects: string[];
  blurb: string;
}

export const DOCUMENT_KINDS: DocumentKindSpec[] = [
  { kind: 'SLIP', label: 'Slip / submission', expects: ['insured', 'period', 'limit', 'premium'], blurb: 'The broker slip presenting the risk.' },
  { kind: 'SOV', label: 'Statement of values', expects: ['totalInsuredValue', 'locationCount', 'topLocation', 'occupancy'], blurb: 'Schedule of insured locations and values.' },
  { kind: 'LOSS_RUN', label: 'Loss run', expects: ['asOfDate', 'claimCount', 'incurred', 'largestLoss'], blurb: 'Historical claims experience.' },
  { kind: 'WORDING', label: 'Policy wording', expects: ['form', 'exclusions', 'territory'], blurb: 'Contract wording / clauses.' },
  { kind: 'FINANCIALS', label: 'Financials', expects: ['revenue', 'assets', 'ratingAgency'], blurb: 'Cedent financial statements.' },
  { kind: 'EMAIL', label: 'Correspondence', expects: ['from', 'subject', 'date'], blurb: 'Email / negotiation thread.' },
  { kind: 'BORDEREAU', label: 'Bordereau', expects: ['period', 'rowCount', 'premium', 'claims'], blurb: 'Premium / claims bordereau.' },
  { kind: 'OTHER', label: 'Other', expects: [], blurb: 'Uncategorised document.' },
];

const KIND_BY = new Map(DOCUMENT_KINDS.map((k) => [k.kind, k]));
export function documentKindSpec(kind: string): DocumentKindSpec {
  return KIND_BY.get(kind as DocumentKind) ?? KIND_BY.get('OTHER')!;
}

/** Guess a document kind from its file name (used to pre-select on upload). */
export function inferKind(name: string): DocumentKind {
  const n = name.toLowerCase();
  if (/(^|[_\-. ])sov([_\-. ]|$)|statement.?of.?value|schedule/.test(n)) return 'SOV';
  if (/loss.?run|claims?.?(experience|history|listing)/.test(n)) return 'LOSS_RUN';
  if (/wording|policy|clause/.test(n)) return 'WORDING';
  if (/financial|balance|annual.?report|10-?k/.test(n)) return 'FINANCIALS';
  if (/bordereau|bdx/.test(n)) return 'BORDEREAU';
  if (/\.eml$|\.msg$|email|re:|fw:/.test(n)) return 'EMAIL';
  if (/slip|submission|placement|quote/.test(n)) return 'SLIP';
  return 'OTHER';
}

export interface ExtractedField { key: string; value: string; confidence: number; }
export interface ExtractionResult {
  kind: DocumentKind;
  fields: ExtractedField[];
  /** Overall confidence 0..1 averaged across fields. */
  confidence: number;
  /** Which expected fields the extractor could not populate. */
  unresolved: string[];
  provider: string;
}

/**
 * Deterministic extraction stub. Given a document kind and name it returns the
 * fields that kind is expected to yield, marking those it cannot infer from the
 * name as unresolved (low confidence). A real provider returns the same shape.
 * Deterministic so tests are stable (no clock/random).
 */
export function extractDocument(kind: DocumentKind, name: string, provider = 'mock-ocr'): ExtractionResult {
  const spec = documentKindSpec(kind);
  const seed = hash(name);
  const fields: ExtractedField[] = [];
  const unresolved: string[] = [];
  spec.expects.forEach((key, i) => {
    // A stub can't read the file; it can only mark the field as "to be verified".
    // Confidence is a stable pseudo-value derived from the name + field index so
    // the UI can show a realistic mixed-confidence extraction.
    const conf = ((seed + i * 37) % 100) / 100;
    if (conf < 0.35) { unresolved.push(key); return; }
    fields.push({ key, value: '(pending verification)', confidence: round2(conf) });
  });
  const confidence = fields.length ? round2(fields.reduce((a, f) => a + f.confidence, 0) / fields.length) : 0;
  return { kind, fields, confidence, unresolved, provider };
}

/** Next version number given the current highest version in a chain. */
export function nextVersion(currentMax: number | null | undefined): number {
  return (currentMax ?? 0) + 1;
}

/** A deterministic content digest for a lightweight signature/seal. Not a
 *  cryptographic signature - a real e-signature integration replaces this. */
export function signatureDigest(parts: Array<string | number | null | undefined>): string {
  const s = parts.map((p) => String(p ?? '')).join('|');
  return `sha-${(hash(s) >>> 0).toString(16).padStart(8, '0')}`;
}

// --- internals ---
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
function round2(v: number): number { return Math.round(v * 100) / 100; }
