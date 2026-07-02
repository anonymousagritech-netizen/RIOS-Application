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

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement engine (0071): applyFieldSecurity
//
// A second, opt-in masking vocabulary used by the enforced field_security_policy
// store. Kept separate from the legacy applyMasking/maskValue above so existing
// callers stay byte-identical. Strategies: FULL → '••••', PARTIAL → last 4 kept,
// HASH → sha256, REDACT → null. A field is masked only when the viewer lacks the
// policy's min_permission (admin:manage always clears).
// ─────────────────────────────────────────────────────────────────────────────

export type FieldSecurityStrategy = 'FULL' | 'PARTIAL' | 'HASH' | 'REDACT';

export interface FieldSecurityPolicy {
  entity: string;
  field: string;
  maskStrategy: FieldSecurityStrategy;
  /** Permission the viewer must hold to see the raw value. */
  minPermission: string;
  active?: boolean;
}

const FULL_MASK = '••••';

function rotr(n: number, b: number): number {
  return ((n >>> b) | (n << (32 - b))) >>> 0;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-8 encode a string to a byte array (pure; no Buffer/TextEncoder). */
function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = s.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

/** Deterministic, non-reversible SHA-256 hex digest (pure JS). */
export function sha256Hex(input: string): string {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  const w = new Uint32Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = ((bytes[i + t * 4]! << 24) | (bytes[i + t * 4 + 1]! << 16) | (bytes[i + t * 4 + 2]! << 8) | bytes[i + t * 4 + 3]!) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Mask a single value per a field-security strategy. Null/undefined pass through. */
export function maskField(value: unknown, strategy: FieldSecurityStrategy): unknown {
  if (value == null) return value;
  switch (strategy) {
    case 'REDACT':
      return null;
    case 'FULL':
      return FULL_MASK;
    case 'HASH':
      return `sha256:${sha256Hex(typeof value === 'object' ? JSON.stringify(value) : String(value))}`;
    case 'PARTIAL': {
      if (typeof value === 'object') return FULL_MASK; // never leak structure
      const s = String(value);
      if (s.length <= 4) return FULL_MASK;
      return FULL_MASK + s.slice(-4);
    }
    default:
      return value;
  }
}

/** Does the viewer clear this policy (holds min_permission, or is a super-admin)? */
function cleared(policy: FieldSecurityPolicy, granted: Set<string>): boolean {
  return granted.has('admin:manage') || granted.has(policy.minPermission);
}

/**
 * Fields of `entity` that WOULD be masked for a viewer with these permissions,
 * independent of any specific row. Drives the /effective endpoint.
 */
export function maskedFieldsFor(
  entity: string,
  policies: FieldSecurityPolicy[],
  grantedPermissions: string[],
): { field: string; maskStrategy: FieldSecurityStrategy; minPermission: string }[] {
  const granted = new Set(grantedPermissions ?? []);
  return (policies ?? [])
    .filter((p) => p.entity === entity && p.active !== false && !cleared(p, granted))
    .map((p) => ({ field: p.field, maskStrategy: p.maskStrategy, minPermission: p.minPermission }));
}

/**
 * Apply active field-security policies to a row (or array of rows) for the given
 * entity and viewer permissions. Returns the same shape as the input with every
 * configured-and-uncleared field masked per its strategy. Behaviour-preserving:
 * with no matching active policy the row is returned structurally unchanged
 * (a shallow copy with identical values). Pure - no I/O.
 */
export function applyFieldSecurity<T extends Record<string, unknown>>(
  entity: string,
  input: T,
  policies: FieldSecurityPolicy[],
  grantedPermissions: string[],
): T;
export function applyFieldSecurity<T extends Record<string, unknown>>(
  entity: string,
  input: T[],
  policies: FieldSecurityPolicy[],
  grantedPermissions: string[],
): T[];
export function applyFieldSecurity<T extends Record<string, unknown>>(
  entity: string,
  input: T | T[],
  policies: FieldSecurityPolicy[],
  grantedPermissions: string[],
): T | T[] {
  const granted = new Set(grantedPermissions ?? []);
  const relevant = (policies ?? []).filter(
    (p) => p.entity === entity && p.active !== false && !cleared(p, granted),
  );
  const maskRow = (row: T): T => {
    if (relevant.length === 0) return row;
    let copy: Record<string, unknown> | null = null;
    for (const p of relevant) {
      if (!(p.field in row)) continue;
      if (!copy) copy = { ...row };
      copy[p.field] = maskField((row as Record<string, unknown>)[p.field], p.maskStrategy);
    }
    return (copy ?? row) as T;
  };
  return Array.isArray(input) ? input.map(maskRow) : maskRow(input);
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
