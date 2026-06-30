import { useState } from 'react';
import { ShoppingCart, ClipboardList, Store } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, Input, Select, TextField, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, titleCase } from '../lib/format';
import { api, qs, ApiError } from '../lib/api';
import shared from './shared.module.css';

/* ---------------- Types ---------------- */
interface Vendor {
  id: string;
  code: string;
  name: string;
  category: string | null;
  email: string | null;
  partyId: string | null;
  status: string;
}
interface Requisition {
  id: string;
  reference: string;
  departmentId: string | null;
  requestedBy: string | null;
  description: string;
  currency: string;
  totalMinor: number;
  status: string;
}
interface PurchaseOrder {
  id: string;
  reference: string;
  vendorId: string;
  requisitionId: string | null;
  currency: string;
  totalMinor: number;
  orderDate: string | null;
  status: string;
  vendorName: string | null;
}
interface OrderLine {
  id: string;
  lineNo: number;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  currency: string;
}
interface PurchaseOrderDetail extends PurchaseOrder {
  createdBy: string | null;
  lines: OrderLine[];
}

/* ---------------- Data hooks (local) ---------------- */
function useVendors() {
  return useQuery({
    queryKey: ['procurement', 'vendors'],
    queryFn: () => api<{ vendors: Vendor[] }>('/api/procurement/vendors'),
  });
}
function useRequisitions(params: { status?: string }) {
  return useQuery({
    queryKey: ['procurement', 'requisitions', params],
    queryFn: () => api<{ requisitions: Requisition[] }>(`/api/procurement/requisitions${qs(params)}`),
  });
}
function useOrders(params: { status?: string; vendorId?: string }) {
  return useQuery({
    queryKey: ['procurement', 'orders', params],
    queryFn: () => api<{ orders: PurchaseOrder[] }>(`/api/procurement/orders${qs(params)}`),
  });
}
function useOrder(id: string | undefined) {
  return useQuery({
    queryKey: ['procurement', 'order', id],
    queryFn: () => api<PurchaseOrderDetail>(`/api/procurement/orders/${id}`),
    enabled: !!id,
  });
}
function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; category?: string; email?: string }) =>
      api<{ id: string; code: string }>('/api/procurement/vendors', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['procurement', 'vendors'] }),
  });
}
function useCreateRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { description: string; currency?: string; total?: number }) =>
      api<{ id: string; reference: string; status: string }>('/api/procurement/requisitions', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] }),
  });
}
function useSubmitRequisition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ id: string; status: string }>(`/api/procurement/requisitions/${id}/submit`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['procurement', 'requisitions'] }),
  });
}
function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      vendorId: string; currency?: string;
      lines: { description: string; quantity: number; unitPrice: number }[];
    }) => api<{ id: string; reference: string; totalMinor: number }>('/api/procurement/orders', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['procurement', 'orders'] }),
  });
}
function useTransitionOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api<{ id: string; status: string }>(`/api/procurement/orders/${id}/transition`, { body: { to } }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['procurement', 'orders'] });
      qc.invalidateQueries({ queryKey: ['procurement', 'order', vars.id] });
    },
  });
}

const TABS = [
  { id: 'orders', label: 'Purchase Orders' },
  { id: 'requisitions', label: 'Requisitions' },
  { id: 'vendors', label: 'Vendors' },
];

const PO_TRANSITIONS: Record<string, string[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['received', 'cancelled'],
  received: ['closed'],
  closed: [],
  cancelled: [],
};
const PO_STATUSES = ['draft', 'issued', 'received', 'closed', 'cancelled'];
const REQ_STATUSES = ['draft', 'submitted'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'];

export function ProcurementPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('procurement:write');
  const [tab, setTab] = useState('orders');

  return (
    <>
      <PageHeader
        title="Procurement"
        description="Vendors, purchase requisitions and purchase orders."
      />

      <Card padded={false}>
        <div style={{ padding: '0 var(--space-4)' }}>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
        </div>
        <div style={{ padding: 'var(--space-5)' }}>
          {tab === 'orders' && <OrdersTab canWrite={canWrite} />}
          {tab === 'requisitions' && <RequisitionsTab canWrite={canWrite} />}
          {tab === 'vendors' && <VendorsTab canWrite={canWrite} />}
        </div>
      </Card>
    </>
  );
}

/* ---------------- Purchase Orders tab ---------------- */
function OrdersTab({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; to: string } | null>(null);

  const { data, isLoading } = useOrders({ status: status || undefined });
  const transition = useTransitionOrder();
  const rows = data?.orders ?? [];

  const runTransition = async (id: string, to: string) => {
    try {
      const res = await transition.mutateAsync({ id, to });
      toast.success(`Purchase order ${titleCase(res.status)}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Transition failed.');
    } finally {
      setConfirm(null);
    }
  };

  const onTransitionClick = (id: string, to: string) => {
    if (to === 'issued' || to === 'cancelled') setConfirm({ id, to });
    else runTransition(id, to);
  };

  const columns: Column<PurchaseOrder>[] = [
    { key: 'reference', header: 'Reference', sortValue: (o) => o.reference, render: (o) => <span className={shared.cellRef}>{o.reference}</span> },
    { key: 'vendor', header: 'Vendor', sortValue: (o) => o.vendorName ?? '', render: (o) => <span className={shared.cellMain}>{o.vendorName ?? '-'}</span> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (o) => o.totalMinor, render: (o) => <span className={shared.money}>{formatMoney(o.totalMinor, o.currency)}</span> },
    { key: 'status', header: 'Status', sortValue: (o) => o.status, render: (o) => <StatusPill status={o.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (o) => {
        const next = PO_TRANSITIONS[o.status] ?? [];
        if (!canWrite || next.length === 0) return <span className={shared.cellSub}>-</span>;
        return (
          <div className={shared.toolbar} style={{ justifyContent: 'flex-end' }}>
            {next.map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === 'cancelled' ? 'danger' : 'secondary'}
                loading={transition.isPending && confirm?.id === o.id && confirm?.to === to}
                onClick={(e) => { e.stopPropagation(); onTransitionClick(o.id, to); }}
              >
                {titleCase(to)}
              </Button>
            ))}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className={shared.toolbar} style={{ marginBottom: 'var(--space-4)' }}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All</option>
            {PO_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} order{rows.length === 1 ? '' : 's'}</span>
        {canWrite && (
          <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New PO</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.orders}
        loading={isLoading}
        rowKey={(o) => o.id}
        onRowClick={(o) => setSelectedId((cur) => (cur === o.id ? null : o.id))}
        empty={<EmptyState title="No purchase orders" message="No purchase orders match the current filter." icon={<ShoppingCart size={16} />} />}
      />

      {selectedId && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <OrderLines id={selectedId} />
        </div>
      )}

      <NewOrderModal open={showNew} onClose={() => setShowNew(false)} />

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && runTransition(confirm.id, confirm.to)}
        loading={transition.isPending}
        destructive={confirm?.to === 'cancelled'}
        title={confirm?.to === 'cancelled' ? 'Cancel purchase order?' : 'Issue purchase order?'}
        confirmLabel={confirm ? `Yes, ${titleCase(confirm.to)}` : 'Confirm'}
        message={
          confirm?.to === 'cancelled'
            ? 'Cancelling the purchase order stops its lifecycle. This cannot be undone.'
            : 'Issuing commits this purchase order to the vendor.'
        }
      />
    </>
  );
}

function OrderLines({ id }: { id: string }) {
  const { data, isLoading } = useOrder(id);
  const lines = data?.lines ?? [];

  const columns: Column<OrderLine>[] = [
    { key: 'lineNo', header: '#', sortValue: (l) => l.lineNo, render: (l) => l.lineNo },
    { key: 'description', header: 'Description', render: (l) => <span className={shared.cellMain}>{l.description}</span> },
    { key: 'quantity', header: 'Qty', align: 'right', sortValue: (l) => l.quantity, render: (l) => l.quantity },
    { key: 'unitPrice', header: 'Unit price', align: 'right', render: (l) => <span className={shared.money}>{formatMoney(l.unitPriceMinor, l.currency)}</span> },
    { key: 'lineTotal', header: 'Line total', align: 'right', render: (l) => <span className={shared.money}>{formatMoney(l.lineTotalMinor, l.currency)}</span> },
  ];

  if (isLoading) return <PageLoader label="Loading lines…" />;

  return (
    <>
      <CardHeader
        title={`Lines - ${data?.reference ?? ''}`}
        subtitle={data ? `${data.vendorName ?? 'Vendor'} · ${formatMoney(data.totalMinor, data.currency)} · ${titleCase(data.status)}` : undefined}
      />
      <Table
        columns={columns}
        rows={lines}
        rowKey={(l) => l.id}
        empty={<EmptyState title="No lines" message="This purchase order has no lines." />}
        skeletonRows={3}
      />
    </>
  );
}

interface DraftLine { description: string; quantity: string; unitPrice: string; }

function NewOrderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateOrder();
  const { data } = useVendors();
  const vendors = data?.vendors ?? [];

  const [vendorId, setVendorId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [lines, setLines] = useState<DraftLine[]>([{ description: '', quantity: '1', unitPrice: '' }]);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setVendorId(''); setCurrency('USD'); setLines([{ description: '', quantity: '1', unitPrice: '' }]); setError(null);
  };

  const updateLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { description: '', quantity: '1', unitPrice: '' }]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  const totalMajor = lines.reduce((sum, l) => {
    const q = Number(l.quantity);
    const p = Number(l.unitPrice);
    if (Number.isNaN(q) || Number.isNaN(p)) return sum;
    return sum + q * p;
  }, 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!vendorId) { setError('Select a vendor.'); return; }
    const parsed: { description: string; quantity: number; unitPrice: number }[] = [];
    for (const l of lines) {
      const q = Number(l.quantity);
      const p = Number(l.unitPrice);
      if (!l.description.trim()) { setError('Every line needs a description.'); return; }
      if (Number.isNaN(q) || q <= 0) { setError('Every line needs a quantity greater than zero.'); return; }
      if (Number.isNaN(p) || p < 0) { setError('Every line needs a valid unit price.'); return; }
      parsed.push({ description: l.description, quantity: q, unitPrice: p });
    }
    try {
      const res = await create.mutateAsync({ vendorId, currency, lines: parsed });
      toast.success(`Purchase order ${res.reference} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the purchase order.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New purchase order"
      description="Raise a purchase order against a vendor. Unit prices are entered in major currency units."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!vendorId}>Create PO</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Vendor" required>
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select a vendor…</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.code} - {v.name}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </FormField>
        </div>

        <FormField label="Lines">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 0.7fr 1fr auto', gap: 'var(--space-2)', alignItems: 'center' }}>
                <Input
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                  aria-label={`Line ${i + 1} description`}
                />
                <Input
                  type="number" min="0" step="any"
                  placeholder="Qty"
                  value={l.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  aria-label={`Line ${i + 1} quantity`}
                />
                <Input
                  type="number" min="0" step="any"
                  placeholder="Unit price"
                  value={l.unitPrice}
                  onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                  aria-label={`Line ${i + 1} unit price`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeLine(i)}
                  disabled={lines.length <= 1}
                  aria-label={`Remove line ${i + 1}`}
                >
                  ×
                </Button>
              </div>
            ))}
            <div className={shared.toolbar}>
              <Button variant="subtle" size="sm" onClick={addLine} icon={<span aria-hidden>+</span>}>Add line</Button>
              <div className={shared.spacer} />
              <span className={shared.cellSub}>Total</span>
              <span className={shared.money} style={{ fontWeight: 'var(--weight-semibold)' }}>
                {formatMoney(Math.round(totalMajor * 100), currency)}
              </span>
            </div>
          </div>
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Requisitions tab ---------------- */
function RequisitionsTab({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);
  const { data, isLoading } = useRequisitions({ status: status || undefined });
  const submitReq = useSubmitRequisition();
  const rows = data?.requisitions ?? [];

  const runSubmit = async (id: string) => {
    try {
      const res = await submitReq.mutateAsync(id);
      toast.success(`Requisition ${titleCase(res.status)}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not submit the requisition.');
    }
  };

  const columns: Column<Requisition>[] = [
    { key: 'reference', header: 'Reference', sortValue: (r) => r.reference, render: (r) => <span className={shared.cellRef}>{r.reference}</span> },
    { key: 'description', header: 'Description', sortValue: (r) => r.description, render: (r) => <span className={shared.cellMain}>{r.description}</span> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (r) => r.totalMinor, render: (r) => <span className={shared.money}>{formatMoney(r.totalMinor, r.currency)}</span> },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) =>
        canWrite && r.status === 'draft' ? (
          <Button size="sm" variant="secondary" loading={submitReq.isPending} onClick={() => runSubmit(r.id)}>Submit</Button>
        ) : (
          <span className={shared.cellSub}>-</span>
        ),
    },
  ];

  return (
    <>
      <div className={shared.toolbar} style={{ marginBottom: 'var(--space-4)' }}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All</option>
            {REQ_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} requisition{rows.length === 1 ? '' : 's'}</span>
        {canWrite && (
          <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New requisition</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.requisitions}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No requisitions" message="No requisitions match the current filter." icon={<ClipboardList size={16} />} />}
      />

      <NewRequisitionModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewRequisitionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateRequisition();
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [total, setTotal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setDescription(''); setCurrency('USD'); setTotal(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!description.trim()) { setError('Enter a description.'); return; }
    const amount = total ? Number(total) : undefined;
    if (amount !== undefined && (Number.isNaN(amount) || amount < 0)) { setError('Enter a valid total.'); return; }
    try {
      const res = await create.mutateAsync({ description, currency, total: amount });
      toast.success(`Requisition ${res.reference} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the requisition.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New requisition"
      description="Raise a purchase requisition. Total is entered in major currency units."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!description.trim()}>Create requisition</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Description" required>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Office laptops for the underwriting team" rows={3} />
        </FormField>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </FormField>
          <FormField label="Total (major units)">
            <Input type="number" min="0" step="any" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="e.g. 12000" />
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Vendors tab ---------------- */
function VendorsTab({ canWrite }: { canWrite: boolean }) {
  const [showNew, setShowNew] = useState(false);
  const { data, isLoading } = useVendors();
  const rows = data?.vendors ?? [];

  const columns: Column<Vendor>[] = [
    { key: 'code', header: 'Code', sortValue: (v) => v.code, render: (v) => <span className={shared.cellRef}>{v.code}</span> },
    { key: 'name', header: 'Vendor', sortValue: (v) => v.name, render: (v) => <span className={shared.cellMain}>{v.name}</span> },
    { key: 'category', header: 'Category', sortValue: (v) => v.category ?? '', render: (v) => v.category ?? '-' },
    { key: 'email', header: 'Email', sortValue: (v) => v.email ?? '', render: (v) => v.email ?? '-' },
    { key: 'status', header: 'Status', align: 'right', sortValue: (v) => v.status, render: (v) => <StatusPill status={v.status} /> },
  ];

  return (
    <>
      <div className={shared.toolbar} style={{ marginBottom: 'var(--space-4)' }}>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} vendor{rows.length === 1 ? '' : 's'}</span>
        {canWrite && (
          <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New vendor</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.vendors}
        loading={isLoading}
        rowKey={(v) => v.id}
        empty={<EmptyState title="No vendors" message="Add a vendor to raise purchase orders." icon={<Store size={16} />} />}
      />

      <NewVendorModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewVendorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateVendor();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setCode(''); setName(''); setCategory(''); setEmail(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !name.trim()) { setError('Code and name are required.'); return; }
    try {
      const res = await create.mutateAsync({
        code,
        name,
        category: category || undefined,
        email: email || undefined,
      });
      toast.success(`Vendor ${res.code} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the vendor.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New vendor"
      description="Register a vendor for procurement."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!code.trim() || !name.trim()}>Create vendor</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Code" value={code} onChange={setCode} required placeholder="e.g. ACME" />
          <TextField label="Category" value={category} onChange={setCategory} placeholder="e.g. IT services" />
        </div>
        <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Acme Supplies Ltd" />
        <TextField label="Email" value={email} onChange={setEmail} type="email" placeholder="contact@acme.example" />
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
