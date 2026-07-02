/**
 * Dynamic Form Engine.
 *
 * Forms in RIOS are metadata-driven, never hard-coded layouts. A form is a list
 * of FieldGroups; each group and each field carries an optional `when(ctx)`
 * predicate, so the same schema renders different fields depending on context -
 * line of business, treaty type, workflow stage, user role, country or company
 * configuration. The engine renders through the shared Form primitives, so every
 * adaptive form inherits the same look, spacing and accessibility.
 *
 * Values live in a flat Record keyed by field key; `collectVisibleValues` returns
 * only the fields that are currently visible, so switching context never persists
 * stale fields from a branch the user navigated away from.
 */
import { useState } from 'react';
import { FormSection, FormField, TextField, Input, Select, Textarea } from '../components/Form';

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'textarea';

export interface SelectOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type?: FieldType; // default 'text'
  options?: (string | SelectOption)[];
  placeholder?: string;
  hint?: string;
  required?: boolean;
  fullWidth?: boolean;
  /** Field is rendered only when this predicate passes (default: always). */
  when?: (ctx: FormContext) => boolean;

  // --- Declarative validation (all optional, checked in order below) ---
  /** Minimum numeric value (type 'number'); the trimmed value must parse to >= min. */
  min?: number;
  /** Maximum numeric value (type 'number'); the trimmed value must parse to <= max. */
  max?: number;
  /** Maximum length of the (trimmed) string value. */
  maxLength?: number;
  /** Regex the (trimmed) value must match, with the message shown when it does not. */
  pattern?: { re: RegExp; message: string };
  /**
   * Custom, cross-field validator. Runs last (after required/range/pattern) and
   * always runs even when the value is empty, so a field can be conditionally
   * required based on other values. Return a message to fail, or undefined to pass.
   */
  validate?: (value: string, ctx: FormContext, values: FormValues) => string | undefined;
}

export interface FieldGroup {
  id: string;
  title?: string;
  description?: string;
  /** Group is rendered only when this predicate passes (default: always). */
  when?: (ctx: FormContext) => boolean;
  fields: FieldDef[];
}

/**
 * The context a form adapts to. Open-ended so a company-configuration flag or a
 * custom dimension can drive visibility without changing the engine.
 */
export interface FormContext {
  lob?: string; // a haystack of the LOB code + label, matched case-insensitively
  structure?: string; // PROPORTIONAL | NON_PROPORTIONAL
  type?: string; // QUOTA_SHARE | CAT_XL | ...
  product?: string;
  stage?: string; // workflow stage
  role?: string; // user role
  country?: string;
  [k: string]: unknown;
}

export type FormValues = Record<string, string>;

const opt = (o: string | SelectOption): SelectOption => (typeof o === 'string' ? { value: o, label: o } : o);

function visibleGroups(groups: FieldGroup[], ctx: FormContext): FieldGroup[] {
  return groups
    .filter((g) => !g.when || g.when(ctx))
    .map((g) => ({ ...g, fields: g.fields.filter((f) => !f.when || f.when(ctx)) }))
    .filter((g) => g.fields.length > 0);
}

/** Keys of every field currently visible for the given schema + context. */
export function visibleKeys(groups: FieldGroup[], ctx: FormContext): string[] {
  return visibleGroups(groups, ctx).flatMap((g) => g.fields.map((f) => f.key));
}

/** Trimmed, non-empty values for the fields currently visible (for persistence). */
export function collectVisibleValues(groups: FieldGroup[], ctx: FormContext, values: FormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of visibleKeys(groups, ctx)) {
    const v = values[key];
    if (v != null && String(v).trim()) out[key] = String(v).trim();
  }
  return out;
}

/**
 * Validate a single field against its declarative rules. Checks run in a fixed
 * order and short-circuit on the first failure: required → number range →
 * maxLength → pattern → custom `validate`. Non-required empty values skip the
 * value-shape checks (nothing to constrain) but still run `validate`, so a field
 * can be made conditionally required from other values. Returns the error message
 * or undefined when the field is valid.
 */
export function validateField(field: FieldDef, value: string, ctx: FormContext, values: FormValues): string | undefined {
  const v = (value ?? '').trim();
  if (field.required && !v) return `${field.label} is required`;
  if (v) {
    if (field.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) return `${field.label} must be a number`;
      if (field.min != null && n < field.min) return `${field.label} must be at least ${field.min}`;
      if (field.max != null && n > field.max) return `${field.label} must be at most ${field.max}`;
    }
    if (field.maxLength != null && v.length > field.maxLength) return `${field.label} must be ${field.maxLength} characters or fewer`;
    if (field.pattern && !field.pattern.re.test(v)) return field.pattern.message;
  }
  return field.validate?.(v, ctx, values);
}

/**
 * Validate every field currently VISIBLE for the given schema + context, reusing
 * the engine's own visibility logic so hidden branches never block a submit.
 * Returns a key→message map containing only the fields that failed.
 */
export function validateForm(groups: FieldGroup[], ctx: FormContext, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const g of visibleGroups(groups, ctx)) {
    for (const f of g.fields) {
      const err = validateField(f, values[f.key] ?? '', ctx, values);
      if (err) errors[f.key] = err;
    }
  }
  return errors;
}

function DynamicField({ field, value, onChange, error, onBlur }: { field: FieldDef; value: string; onChange: (v: string) => void; error?: string; onBlur?: () => void }) {
  const content =
    field.type === 'select' ? (
      <FormField label={field.label} hint={field.hint} required={field.required} error={error}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {(field.options ?? []).map(opt).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </FormField>
    ) : field.type === 'textarea' ? (
      <FormField label={field.label} hint={field.hint} required={field.required} error={error}>
        <Textarea value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      </FormField>
    ) : field.type === 'number' || field.type === 'date' ? (
      <TextField
        label={field.label}
        type={field.type}
        value={value}
        onChange={onChange}
        placeholder={field.placeholder}
        hint={field.hint}
        required={field.required}
        error={error}
      />
    ) : (
      <TextField
        label={field.label}
        value={value}
        onChange={onChange}
        placeholder={field.placeholder}
        hint={field.hint}
        required={field.required}
        error={error}
      />
    );
  // Wrap in a div carrying the blur handler (React's onBlur bubbles from the
  // inner control) so inline errors light up on blur without touching the Form
  // primitives. The wrapper is also where fullWidth spans the grid.
  return (
    <div style={field.fullWidth ? { gridColumn: '1 / -1' } : undefined} onBlur={onBlur}>
      {content}
    </div>
  );
}

/**
 * Render a metadata-driven form. Groups/fields whose `when` predicate fails for
 * the current context are omitted entirely, so the form reshapes as context
 * changes. `values`/`onChange` own a flat key→string map.
 */
export function DynamicForm({
  groups,
  ctx,
  values,
  onChange,
  showAllErrors = false,
}: {
  groups: FieldGroup[];
  ctx: FormContext;
  values: FormValues;
  onChange: (key: string, value: string) => void;
  /**
   * Force every visible field's error to show regardless of touched state -
   * a parent sets this on submit to surface all outstanding errors at once.
   * Default false: errors appear per field only after it has been blurred.
   */
  showAllErrors?: boolean;
}) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const errors = validateForm(groups, ctx, values);
  const markTouched = (key: string) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  return (
    <>
      {visibleGroups(groups, ctx).map((g) => (
        <FormSection key={g.id} title={g.title} description={g.description}>
          {g.fields.map((f) => (
            <DynamicField
              key={f.key}
              field={f}
              value={values[f.key] ?? ''}
              onChange={(v) => onChange(f.key, v)}
              error={showAllErrors || touched[f.key] ? errors[f.key] : undefined}
              onBlur={() => markTouched(f.key)}
            />
          ))}
        </FormSection>
      ))}
    </>
  );
}
