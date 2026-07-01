/**
 * Data import: column mapping, type coercion and validation (brief §17).
 *
 * A reusable, pure engine behind bordereaux ingestion and any bulk load: map
 * source columns to target fields, coerce to typed values (including money in
 * integer minor units and ISO dates), validate against per-field rules, and
 * return the clean rows alongside a precise, per-cell error report. No I/O; the
 * server reads the file and persists the valid rows.
 */

export type FieldType = 'string' | 'number' | 'integerMinor' | 'date' | 'boolean' | 'currency' | 'enum';

export interface FieldMapping {
  /** Target field name in the mapped output. */
  target: string;
  /** Source column header to read from. */
  source: string;
  type: FieldType;
  required?: boolean;
  /** Allowed values for `enum`/`currency` (currency also enforces ISO-4217 shape). */
  allowed?: string[];
  /** Inclusive numeric bounds for `number`/`integerMinor` (major units for the latter). */
  min?: number;
  max?: number;
  /** Minor units for `integerMinor` (default 2). */
  minorUnits?: number;
  /** Regex the raw string must fully match, for `string`. */
  pattern?: string;
}

export interface MappingSpec {
  fields: FieldMapping[];
}

export interface RowError {
  /** 1-based source row number. */
  row: number;
  field: string;
  message: string;
}

export interface ImportResult {
  rows: Record<string, unknown>[];
  errors: RowError[];
  summary: { total: number; valid: number; invalid: number };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function coerce(field: FieldMapping, raw: unknown): { value?: unknown; error?: string } {
  const s = typeof raw === 'string' ? raw.trim() : raw;
  switch (field.type) {
    case 'string': {
      const str = String(s);
      if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(str)) {
        return { error: `does not match ${field.pattern}` };
      }
      return { value: str };
    }
    case 'number':
    case 'integerMinor': {
      const n = typeof s === 'number' ? s : Number(String(s).replace(/,/g, ''));
      if (!Number.isFinite(n)) return { error: `is not a number` };
      if (field.min !== undefined && n < field.min) return { error: `below minimum ${field.min}` };
      if (field.max !== undefined && n > field.max) return { error: `above maximum ${field.max}` };
      if (field.type === 'number') return { value: n };
      const scale = 10 ** (field.minorUnits ?? 2);
      return { value: Math.round(n * scale) };
    }
    case 'boolean': {
      const t = String(s).toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(t)) return { value: true };
      if (['false', '0', 'no', 'n'].includes(t)) return { value: false };
      return { error: `is not a boolean` };
    }
    case 'date': {
      const str = String(s);
      if (!ISO_DATE.test(str)) return { error: `is not an ISO date (YYYY-MM-DD)` };
      const d = new Date(str + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) return { error: `is not a valid date` };
      return { value: str };
    }
    case 'currency': {
      const c = String(s).toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) return { error: `is not a 3-letter currency code` };
      if (field.allowed && !field.allowed.includes(c)) return { error: `not an allowed currency` };
      return { value: c };
    }
    case 'enum': {
      const v = String(s);
      if (!field.allowed || !field.allowed.includes(v)) {
        return { error: `not one of ${(field.allowed ?? []).join(', ')}` };
      }
      return { value: v };
    }
    default:
      return { error: `unknown field type` };
  }
}

/**
 * Map and validate a set of source rows against a mapping spec. Every cell error
 * is collected (a row with any error is excluded from `rows` but all of its
 * errors are reported), so an operator can fix a whole file in one pass.
 */
export function mapAndValidate(sourceRows: Record<string, unknown>[], spec: MappingSpec): ImportResult {
  const rows: Record<string, unknown>[] = [];
  const errors: RowError[] = [];

  sourceRows.forEach((src, i) => {
    const rowNo = i + 1;
    const mapped: Record<string, unknown> = {};
    let rowOk = true;

    for (const field of spec.fields) {
      const raw = src[field.source];
      if (isBlank(raw)) {
        if (field.required) {
          errors.push({ row: rowNo, field: field.target, message: 'is required' });
          rowOk = false;
        }
        continue;
      }
      const { value, error } = coerce(field, raw);
      if (error) {
        errors.push({ row: rowNo, field: field.target, message: error });
        rowOk = false;
      } else {
        mapped[field.target] = value;
      }
    }

    if (rowOk) rows.push(mapped);
  });

  return {
    rows,
    errors,
    summary: { total: sourceRows.length, valid: rows.length, invalid: sourceRows.length - rows.length },
  };
}
