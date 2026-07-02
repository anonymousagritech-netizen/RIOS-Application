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

function DynamicField({ field, value, onChange }: { field: FieldDef; value: string; onChange: (v: string) => void }) {
  const content =
    field.type === 'select' ? (
      <FormField label={field.label} hint={field.hint} required={field.required}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {(field.options ?? []).map(opt).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </FormField>
    ) : field.type === 'textarea' ? (
      <FormField label={field.label} hint={field.hint} required={field.required}>
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
      />
    ) : (
      <TextField
        label={field.label}
        value={value}
        onChange={onChange}
        placeholder={field.placeholder}
        hint={field.hint}
        required={field.required}
      />
    );
  return field.fullWidth ? <div style={{ gridColumn: '1 / -1' }}>{content}</div> : content;
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
}: {
  groups: FieldGroup[];
  ctx: FormContext;
  values: FormValues;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      {visibleGroups(groups, ctx).map((g) => (
        <FormSection key={g.id} title={g.title} description={g.description}>
          {g.fields.map((f) => (
            <DynamicField key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => onChange(f.key, v)} />
          ))}
        </FormSection>
      ))}
    </>
  );
}
