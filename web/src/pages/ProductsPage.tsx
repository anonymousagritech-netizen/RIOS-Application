/**
 * Product lifecycle management (brief §14 - insurance-product factory). Lists
 * versioned insurance products with their lifecycle state and the actions
 * available from that state (computed from the same workflow definition the
 * server enforces), and drives transitions. This page is also the product
 * *studio*: a metadata-driven authoring surface that captures the full product
 * definition the API accepts (code, name, line of business and an adaptive
 * structure/terms definition) and creates versions. Because the API has no
 * in-place update - POST always mints the next DRAFT version for a code - editing
 * an existing product opens it pre-filled and saves as a new version.
 * Authoring/transitions need product:write.
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, CheckCircle2, PauseCircle, Archive, Plus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCodeLists } from '../lib/queries';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormSection, FormField, Input, Select, TextField } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import {
  DynamicForm, validateForm, collectVisibleValues,
  type FieldGroup, type FormContext, type FormValues,
} from '../lib/formEngine';
import { formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './ProductsPage.module.css';

interface Action { event: string; to: string; label?: string }
interface Product {
  id: string; code: string; name: string; lineOfBusiness?: string | null; version: number;
  status: string; definition: Record<string, unknown>; updatedAt?: string | null; actions: Action[];
}

const STATUS_COLOR: Record<string, 'slate' | 'green' | 'amber' | 'gray'> = {
  DRAFT: 'slate', ACTIVE: 'green', SUSPENDED: 'amber', RETIRED: 'gray',
};

/* Product bases drive the adaptive definition below. Kept as a code list (not a
 * hard-coded enum in the query path) - values match the seed definitions. */
const BASES = [
  { code: 'PROPORTIONAL', label: 'Proportional' },
  { code: 'NON_PROPORTIONAL', label: 'Non-proportional (excess of loss)' },
  { code: 'PARAMETRIC', label: 'Parametric (index trigger)' },
  { code: 'ILW', label: 'Industry loss warranty' },
];

/**
 * The adaptive product definition. Groups reshape against the selected basis, so
 * a quota-share product never shows attachment/limit and a parametric product
 * only shows its trigger. Rendered through the shared DynamicForm engine.
 */
const DEFINITION_GROUPS: FieldGroup[] = [
  {
    id: 'proportional', title: 'Proportional terms',
    when: (c) => c.structure === 'PROPORTIONAL',
    fields: [
      { key: 'proportionalType', label: 'Proportional type', type: 'select', required: true,
        options: [{ value: 'QUOTA_SHARE', label: 'Quota share' }, { value: 'SURPLUS', label: 'Surplus' }] },
      { key: 'cededShare', label: 'Ceded share (0–1)', type: 'number', min: 0, max: 1, hint: 'e.g. 0.4 for a 40% quota share' },
      { key: 'maxCession', label: 'Max cession (lines)', type: 'number', min: 0, hint: 'Surplus lines, if applicable' },
    ],
  },
  {
    id: 'np', title: 'Excess-of-loss terms',
    when: (c) => c.structure === 'NON_PROPORTIONAL',
    fields: [
      { key: 'npType', label: 'Excess-of-loss type', type: 'select', required: true,
        options: [
          { value: 'PER_RISK_XL', label: 'Per-risk XL' }, { value: 'CAT_XL', label: 'Catastrophe XL' },
          { value: 'AGG_XL', label: 'Aggregate XL' }, { value: 'STOP_LOSS', label: 'Stop loss' },
        ] },
      { key: 'reinstatements', label: 'Reinstatements', type: 'number', min: 0, placeholder: 'e.g. 2' },
      { key: 'attachmentMajor', label: 'Attachment (major units)', type: 'number', min: 0, placeholder: 'e.g. 1000000' },
      { key: 'limitMajor', label: 'Limit / cover (major units)', type: 'number', min: 0, placeholder: 'e.g. 4000000' },
    ],
  },
  {
    id: 'parametric', title: 'Parametric trigger',
    when: (c) => c.structure === 'PARAMETRIC',
    fields: [
      { key: 'indexName', label: 'Index / trigger', required: true, placeholder: 'e.g. Cat-in-a-box wind speed (kt)' },
      { key: 'triggerValue', label: 'Trigger threshold', type: 'number', placeholder: 'e.g. 120' },
      { key: 'payoutMajor', label: 'Payout at trigger (major units)', type: 'number', min: 0, placeholder: 'e.g. 10000000' },
    ],
  },
  {
    id: 'ilw', title: 'Industry loss warranty',
    when: (c) => c.structure === 'ILW',
    fields: [
      { key: 'industryTriggerMajor', label: 'Industry loss trigger (major units)', type: 'number', min: 0, required: true, placeholder: 'e.g. 20000000000' },
      { key: 'ownRetentionMajor', label: 'Own loss retention (major units)', type: 'number', min: 0, placeholder: 'e.g. 5000000' },
      { key: 'limitMajor', label: 'Limit (major units)', type: 'number', min: 0, placeholder: 'e.g. 10000000' },
    ],
  },
  {
    id: 'notes', title: 'Description',
    fields: [
      { key: 'description', label: 'Product description', type: 'textarea', fullWidth: true,
        placeholder: 'Optional narrative describing cover, scope and intent.' },
    ],
  },
];

/* Definition keys that carry numbers (everything else stays a string). */
const NUMERIC_KEYS = new Set([
  'cededShare', 'maxCession', 'reinstatements', 'attachmentMajor', 'limitMajor',
  'triggerValue', 'payoutMajor', 'industryTriggerMajor', 'ownRetentionMajor',
]);

/* ---------------- Local data hooks ---------------- */
function useProducts() {
  return useQuery({ queryKey: ['products'], queryFn: () => api<{ products: Product[] }>('/api/products') });
}

function useSaveProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; lineOfBusiness?: string; definition: Record<string, unknown> }) =>
      api<{ id: string; version: number; status: string }>('/api/products', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

function useTransition() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, event }: { id: string; event: string }) => api(`/api/products/${id}/transition`, { body: { event } }),
    onSuccess: () => { toast.success('Lifecycle updated'); qc.invalidateQueries({ queryKey: ['products'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Transition refused'),
  });
}

/* ---------------- Page ---------------- */
export function ProductsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('product:write');
  const q = useProducts();
  const transition = useTransition();
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);

  if (q.isLoading) return <PageLoader label="Loading products…" />;

  const products = q.data?.products ?? [];
  const active = products.filter((p) => p.status === 'ACTIVE').length;
  const suspended = products.filter((p) => p.status === 'SUSPENDED').length;
  const retired = products.filter((p) => p.status === 'RETIRED').length;

  const cols: Column<Product>[] = [
    { key: 'code', header: 'Code', render: (p) => <span className={shared.cellRef}>{p.code}</span> },
    { key: 'name', header: 'Product', render: (p) => <span className={shared.cellMain}>{p.name}</span> },
    { key: 'lob', header: 'Line', render: (p) => p.lineOfBusiness ? titleCase(p.lineOfBusiness) : '-' },
    { key: 'basis', header: 'Basis', render: (p) => {
      const b = String((p.definition as { basis?: string })?.basis ?? '');
      return b ? titleCase(b) : '-';
    } },
    { key: 'version', header: 'Ver', align: 'right', render: (p) => `v${p.version}` },
    { key: 'status', header: 'Lifecycle', render: (p) => <Badge color={STATUS_COLOR[p.status] ?? 'slate'}>{titleCase(p.status)}</Badge> },
    { key: 'updated', header: 'Updated', render: (p) => p.updatedAt ? formatDateTime(p.updatedAt) : '-' },
    {
      key: 'act', header: '', align: 'right',
      render: (p) => canWrite && p.actions.length ? (
        <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          {p.actions.map((a) => (
            <Button key={a.event} size="sm" variant={a.event === 'retire' || a.event === 'discard' ? 'ghost' : 'primary'}
              onClick={() => transition.mutate({ id: p.id, event: a.event })} loading={transition.isPending}>
              {a.label ?? titleCase(a.event)}
            </Button>
          ))}
        </div>
      ) : null,
    },
  ];

  return (
    <div className={shared.stack}>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Products' }]}
        title="Products"
        description="The insurance-product factory - versioned definitions driven through a lifecycle the server enforces."
        actions={canWrite ? (
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New product</Button>
        ) : <Badge color="slate">read-only</Badge>}
      />

      <div className={shared.kpiRow}>
        <KpiCard label="Products" value={products.length} loading={q.isLoading} icon={<Boxes size={20} />} accent="var(--primary)" />
        <KpiCard label="Active" value={active} loading={q.isLoading} icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" />
        <KpiCard label="Suspended" value={suspended} loading={q.isLoading} icon={<PauseCircle size={20} />} accent="var(--accent-orange)" />
        <KpiCard label="Retired" value={retired} loading={q.isLoading} icon={<Archive size={20} />} accent="var(--accent-violet)" />
      </div>

      <Card padded={false}>
        <div className={styles.cardPad}>
          <CardHeader title="Insurance products"
            subtitle={canWrite ? 'DRAFT → ACTIVE → (SUSPENDED ↔ ACTIVE) → RETIRED · click a row to edit as a new version' : 'DRAFT → ACTIVE → (SUSPENDED ↔ ACTIVE) → RETIRED'} />
        </div>
        <Table columns={cols} rows={products} rowKey={(p) => p.id}
          onRowClick={canWrite ? (p) => setEditing(p) : undefined}
          empty={<EmptyState title="No products" message="No insurance products defined." icon={<Boxes size={16} />} />} />
      </Card>

      {creating && <ProductEditor open onClose={() => setCreating(false)} />}
      {editing && <ProductEditor open product={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/* ---------------- Product editor (create / new version) ---------------- */
function ProductEditor({ open, onClose, product }: { open: boolean; onClose: () => void; product?: Product }) {
  const toast = useToast();
  const save = useSaveProduct();
  const { data: codeLists } = useCodeLists();
  const lobOptions = codeLists?.lists?.line_of_business ?? [];
  const isEdit = !!product;

  const def = (product?.definition ?? {}) as Record<string, unknown>;
  const [code, setCode] = useState(product?.code ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [lineOfBusiness, setLineOfBusiness] = useState(product?.lineOfBusiness ?? '');
  const [structure, setStructure] = useState(String(def.basis ?? 'PROPORTIONAL'));
  // Seed the adaptive definition values from the existing product (as strings).
  const [values, setValues] = useState<FormValues>(() => {
    const seed: FormValues = {};
    for (const [k, v] of Object.entries(def)) {
      if (k === 'basis' || v == null) continue;
      seed[k] = String(v);
    }
    return seed;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ctx = useMemo<FormContext>(() => {
    const label = lobOptions.find((o) => o.code === lineOfBusiness)?.label ?? '';
    return { structure, lob: `${lineOfBusiness} ${label}` };
  }, [structure, lineOfBusiness, lobOptions]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !name.trim()) { setShowErrors(true); setError('Code and name are required.'); return; }
    const fieldErrors = validateForm(DEFINITION_GROUPS, ctx, values);
    if (Object.keys(fieldErrors).length) { setShowErrors(true); setError('Fix the highlighted fields before saving.'); return; }

    // Only the fields visible for this basis survive, so switching basis never
    // persists stale terms from a branch the author navigated away from.
    const details = collectVisibleValues(DEFINITION_GROUPS, ctx, values);
    const definition: Record<string, unknown> = { basis: structure };
    for (const [k, v] of Object.entries(details)) {
      definition[k] = NUMERIC_KEYS.has(k) && !Number.isNaN(Number(v)) ? Number(v) : v;
    }

    try {
      const res = await save.mutateAsync({
        code: code.trim(), name: name.trim(),
        lineOfBusiness: lineOfBusiness || undefined, definition,
      });
      toast.success(isEdit ? `${code} saved as v${res.version} (DRAFT)` : `Product ${code} created (v${res.version}, DRAFT)`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the product.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={isEdit ? `Edit ${product!.code}` : 'New product'}
      description={isEdit
        ? 'Products are versioned and immutable in place - saving creates the next DRAFT version for this code.'
        : 'Define the product: identification, line of business and an adaptive structure that reshapes by basis. New products start in DRAFT.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!code.trim() || !name.trim()}>
            {isEdit ? 'Save as new version' : 'Create product'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification">
          {isEdit ? (
            <FormField label="Product code" hint="Locked - a new version is minted for this code.">
              <Input value={code} disabled readOnly />
            </FormField>
          ) : (
            <TextField label="Product code" value={code} onChange={setCode} required
              placeholder="e.g. PROP-CAT-XL" hint="Unique per tenant; versions share the code." />
          )}
          <FormField label="Line of business">
            <Select value={lineOfBusiness} onChange={(e) => setLineOfBusiness(e.target.value)}>
              <option value="">Unspecified</option>
              {lobOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </Select>
          </FormField>
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Product name" value={name} onChange={setName} required
              placeholder="e.g. Property Catastrophe XL" />
          </div>
          <FormField label="Basis" required hint="Reshapes the terms captured below.">
            <Select value={structure} onChange={(e) => setStructure(e.target.value)}>
              {BASES.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <DynamicForm
          groups={DEFINITION_GROUPS}
          ctx={ctx}
          values={values}
          onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
          showAllErrors={showErrors}
        />

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
