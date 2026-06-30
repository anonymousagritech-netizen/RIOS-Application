/**
 * Field-level security - value masking (brief §14 - RLS/FLS). Pure helpers that
 * redact a field's value when the viewer lacks the permission its classification
 * requires. Complements row-level security (which hides whole rows) by hiding
 * sensitive *columns* (PII, bank details, identifiers) within a visible row. No
 * I/O: the server loads the row and the policies, calls applyMasking with the
 * caller's permissions, and returns the masked projection.
 */

export type MaskStrategy = 'redact' | 'partial' | 'hash' | 'none';

export interface FieldPolicy {
  field: string;
  /** Permission the viewer must hold to see the raw value. */
  requiredPermission: string;
  strategy: MaskStrategy;
}

const REDACTED = '••••••';

/** Deterministic, non-reversible short hash (djb2) for the 'hash' strategy. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Mask a single value per the strategy. Objects/arrays are fully redacted. */
export function maskValue(value: unknown, strategy: MaskStrategy): unknown {
  if (strategy === 'none' || value == null) return value;
  if (typeof value === 'object') return REDACTED; // never leak structure
  const s = String(value);
  switch (strategy) {
    case 'redact': return REDACTED;
    case 'hash': return `hash:${djb2(s)}`;
    case 'partial': {
      if (s.length <= 4) return REDACTED;
      return '•'.repeat(s.length - 4) + s.slice(-4);
    }
    default: return value;
  }
}

export interface MaskResult<T> {
  record: T;
  maskedFields: string[];
}

/**
 * Apply field policies to a record given the viewer's permissions. A field is
 * masked when the viewer lacks its requiredPermission (admin:manage always
 * sees raw values). Returns a shallow copy plus the list of masked fields.
 */
export function applyMasking<T extends Record<string, unknown>>(
  record: T,
  policies: FieldPolicy[],
  grantedPermissions: string[],
): MaskResult<T> {
  const granted = new Set(grantedPermissions ?? []);
  const isAdmin = granted.has('admin:manage');
  const out: Record<string, unknown> = { ...record };
  const maskedFields: string[] = [];
  for (const p of policies ?? []) {
    if (!(p.field in out)) continue;
    if (isAdmin || granted.has(p.requiredPermission)) continue;
    out[p.field] = maskValue(out[p.field], p.strategy);
    maskedFields.push(p.field);
  }
  return { record: out as T, maskedFields };
}
