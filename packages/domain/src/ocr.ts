/**
 * Document intelligence (brief §9.4 — OCR & document intelligence). Pure field
 * extraction from already-textual content: given labelled regex specs, pull
 * structured fields out of a document's text. Image/PDF OCR (pixels → text) is an
 * external engine; this module is the deterministic extraction layer over the
 * resulting text, and is unit-tested. No I/O.
 */

export interface FieldSpec {
  key: string;
  /** Regex (as a string) whose first capture group is the value. */
  pattern: string;
  /** Capture group index (default 1). */
  group?: number;
}

/** Extract each spec's field from `text`. Missing fields resolve to null. */
export function extractFields(text: string, specs: FieldSpec[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const spec of specs ?? []) {
    let value: string | null = null;
    try {
      const m = new RegExp(spec.pattern, 'i').exec(text ?? '');
      if (m) value = (m[spec.group ?? 1] ?? '').trim() || null;
    } catch {
      value = null;
    }
    out[spec.key] = value;
  }
  return out;
}

/** A default spec set for a premium bordereau / cover note text. */
export const BORDEREAUX_FIELDS: FieldSpec[] = [
  { key: 'policyNumber', pattern: 'policy(?:\\s*(?:no|number|#))?\\s*[:#]?\\s*([A-Z0-9-]+)' },
  { key: 'insured', pattern: 'insured\\s*[:#]?\\s*(.+)' },
  { key: 'premium', pattern: 'premium\\s*[:#]?\\s*[A-Z]{0,3}\\s*\\$?\\s*([0-9,]+(?:\\.[0-9]{2})?)' },
  { key: 'sumInsured', pattern: '(?:sum insured|tsi|limit)\\s*[:#]?\\s*[A-Z]{0,3}\\s*\\$?\\s*([0-9,]+(?:\\.[0-9]{2})?)' },
  { key: 'inception', pattern: '(?:inception|effective)\\s*(?:date)?\\s*[:#]?\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})' },
];

/** Completeness of an extraction: fraction of specs that matched. */
export function extractionConfidence(fields: Record<string, string | null>): number {
  const keys = Object.keys(fields ?? {});
  if (keys.length === 0) return 0;
  const hit = keys.filter((k) => fields[k] != null).length;
  return Math.round((hit / keys.length) * 100) / 100;
}
