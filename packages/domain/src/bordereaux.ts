/**
 * Bordereaux ingestion (brief §7.10, §9.6, §29.6).
 *
 * Pure, deterministic mapping + validation of premium and loss bordereaux. A
 * bordereau arrives as arbitrary source columns; a mapping spec projects those
 * onto canonical fields, each row is validated (amount present and positive,
 * loss date well-formed), amounts are quantised to integer minor units, and the
 * line total is reconciled against an optional declared control total. The
 * result feeds Financial Events (premium) or Claims (loss) downstream. The
 * domain core never touches I/O; the server orchestrates persistence.
 */

import { fromMajor } from './money.js';

export type BordereauKind = 'PREMIUM' | 'LOSS';

/** Canonical field -> source column name(s); the first present column wins. */
export interface BordereauMapping {
  amount?: string | string[];
  premium?: string | string[];
  loss?: string | string[];
  reference?: string | string[];
  policyRef?: string | string[];
  insured?: string | string[];
  periodStart?: string | string[];
  periodEnd?: string | string[];
  lossDate?: string | string[];
  paid?: string | string[];
  outstanding?: string | string[];
}

export interface MappedRow {
  lineNo: number;
  raw: Record<string, unknown>;
  fields: Record<string, unknown>;
  amountMinor: number | null;
  isValid: boolean;
  errors: string[];
}

export interface IngestInput {
  kind: BordereauKind;
  currency: string;
  rows: Record<string, unknown>[];
  mapping?: BordereauMapping;
  /** Declared header control total in major units; the line sum must match it. */
  controlTotalMajor?: number;
}

export interface BordereauResult {
  kind: BordereauKind;
  currency: string;
  rows: MappedRow[];
  validCount: number;
  invalidCount: number;
  totalMinor: number;
  controlTotalMinor?: number;
  varianceMinor: number;
  /** True when there is no control total, or the line sum equals it exactly. */
  reconciles: boolean;
  /** True only when every row is valid AND the control total reconciles. */
  accepted: boolean;
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function pick(raw: Record<string, unknown>, spec: string | string[] | undefined): unknown {
  if (spec === undefined) return undefined;
  const keys = Array.isArray(spec) ? spec : [spec];
  for (const k of keys) {
    if (present(raw[k])) return raw[k];
  }
  return undefined;
}

/**
 * Project source columns onto canonical fields. Original keys are preserved, so
 * a row that already uses canonical names needs no mapping; a mapping only
 * overrides a canonical field when its source column is present.
 */
export function applyMapping(raw: Record<string, unknown>, mapping: BordereauMapping): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [canon, spec] of Object.entries(mapping)) {
    const v = pick(raw, spec as string | string[]);
    if (v !== undefined) out[canon] = v;
  }
  return out;
}

/** Map and validate one bordereau row, resolving its amount to integer minor units. */
export function mapRow(
  raw: Record<string, unknown>,
  lineNo: number,
  kind: BordereauKind,
  currency: string,
  mapping?: BordereauMapping,
): MappedRow {
  const fields = mapping ? applyMapping(raw, mapping) : raw;
  const errors: string[] = [];
  const rawAmount = fields.amount ?? (kind === 'PREMIUM' ? fields.premium : fields.loss);
  let amountMinor: number | null = null;
  if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
    errors.push('amount missing or not positive');
  } else {
    amountMinor = fromMajor(rawAmount, currency).amount;
    if (amountMinor <= 0) errors.push('amount missing or not positive');
  }
  if (kind === 'LOSS' && fields.lossDate != null && typeof fields.lossDate !== 'string') {
    errors.push('lossDate must be a string date');
  }
  return { lineNo, raw, fields, amountMinor, isValid: errors.length === 0, errors };
}

/** Ingest a full bordereau: map, validate, total and reconcile against the control total. */
export function ingestBordereau(input: IngestInput): BordereauResult {
  const ccy = input.currency.toUpperCase();
  const rows = input.rows.map((r, i) => mapRow(r, i + 1, input.kind, ccy, input.mapping));
  const validCount = rows.filter((r) => r.isValid).length;
  const invalidCount = rows.length - validCount;
  const totalMinor = rows.reduce((acc, r) => (r.isValid && r.amountMinor ? acc + r.amountMinor : acc), 0);
  const controlTotalMinor =
    input.controlTotalMajor != null ? fromMajor(input.controlTotalMajor, ccy).amount : undefined;
  const varianceMinor = controlTotalMinor != null ? totalMinor - controlTotalMinor : 0;
  const reconciles = controlTotalMinor == null ? true : varianceMinor === 0;
  return {
    kind: input.kind,
    currency: ccy,
    rows,
    validCount,
    invalidCount,
    totalMinor,
    controlTotalMinor,
    varianceMinor,
    reconciles,
    accepted: invalidCount === 0 && reconciles,
  };
}

export interface PremiumEventDraft {
  eventType: 'INSTALMENT_PREMIUM';
  amountMinor: number;
  currency: string;
  reference: string | null;
}

/** Project the valid premium lines of an accepted bordereau into financial-event drafts. */
export function toPremiumEvents(result: BordereauResult): PremiumEventDraft[] {
  if (result.kind !== 'PREMIUM') return [];
  return result.rows
    .filter((r) => r.isValid && r.amountMinor != null)
    .map((r) => ({
      eventType: 'INSTALMENT_PREMIUM',
      amountMinor: r.amountMinor as number,
      currency: result.currency,
      reference: (r.fields.reference ?? r.fields.policyRef ?? null) as string | null,
    }));
}
