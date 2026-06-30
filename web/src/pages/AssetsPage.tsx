import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { formatMoney, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './workspace.module.css';

/* ---------------- Types ---------------- */
interface Asset {
  id: string;
  tag: string;
  name: string;
  category: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  purchaseDate: string | null;
  valueMinor: number | null;
  currency: string | null;
  status: string;
}
interface AssetsResponse { assets: Asset[]; }

interface License {
  id: string;
  name: string;
  vendor: string | null;
  seatsTotal: number;
  seatsUsed: number;
  seatsAvailable: number;
  expiryDate: string | null;
  costMinor: number | null;
  currency: string | null;
  status: string;
  expiringSoon: boolean;
}
interface LicensesResponse { licenses: License[]; }

interface Entitlement {
  id: string;
  featureKey: string;
  isEnabled: boolean;
  plan: string | null;
  limitValue: number | null;
  createdAt: string;
}
interface EntitlementsResponse { entitlements: Entitlement[]; }

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  employeeNo: string;
}
interface EmployeesResponse { employees: Employee[]; }

/* ---------------- Data hooks ---------------- */
function useAssets(status: string) {
  return useQuery({
    queryKey: ['assets', 'list', status],
    queryFn: () => api<AssetsResponse>(`/api/assets${qs({ status: status || undefined })}`),
  });
}
function useLicenses() {
  return useQuery({
    queryKey: ['assets', 'licenses'],
    queryFn: () => api<LicensesResponse>('/api/licenses'),
  });
}
function useEntitlements() {
  return useQuery({
    queryKey: ['assets', 'entitlements'],
    queryFn: () => api<EntitlementsResponse>('/api/entitlements'),
  });
}
function useEmployees(enabled: boolean) {
  return useQuery({
    queryKey: ['hr', 'employees'],
    queryFn: () => api<EmployeesResponse>('/api/hr/employees'),
    enabled,
  });
}

interface CreateAssetBody {
  tag: string;
  name: string;
  category?: string;
  assignedTo?: string;
  purchaseDate?: string;
  value?: number;
  currency?: string;
}
function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAssetBody) => api('/api/assets', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  });
}
function useAssignAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; employeeId: string }) =>
      api(`/api/assets/${v.id}/assign`, { body: { employeeId: v.employeeId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets'] }),
  });
}

interface CreateLicenseBody {
  name: string;
  vendor?: string;
  seatsTotal: number;
  expiryDate?: string;
  cost?: number;
  currency?: string;
}
function useCreateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLicenseBody) => api('/api/licenses', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets', 'licenses'] }),
  });
}

interface UpsertEntitlementBody { isEnabled: boolean; plan?: string; limitValue?: number; }
function useUpsertEntitlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { featureKey: string; body: UpsertEntitlementBody }) =>
      api(`/api/entitlements/${encodeURIComponent(v.featureKey)}`, { method: 'PUT', body: v.body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assets', 'entitlements'] }),
  });
}

/* ---------------- Constants ---------------- */
const ASSET_STATUSES = ['', 'available', 'in_use', 'retired'];
const TABS = [
  { id: 'assets', label: 'Assets' },
  { id: 'licenses', label: 'Licenses' },
  { id: 'entitlements', label: 'Entitlements' },
];

export function AssetsPage() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState('assets');
  const canWrite = hasPermission('asset:write');

  return (
    <>
      <PageHeader
        title="Assets & entitlements"
        description="Hardware and software inventory, seat utilisation, and per-tenant feature entitlements toggled without a deploy."
        actions={
          canWrite
            ? <Badge color="green">asset:write granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'assets' && <AssetsTab canWrite={canWrite} />}
        {tab === 'licenses' && <LicensesTab canWrite={canWrite} />}
        {tab === 'entitlements' && <EntitlementsTab canWrite={canWrite} />}
      </Card>
    </>
  );
}

/* ---------------- Assets ---------------- */
function AssetsTab({ canWrite }: { canWrite: boolean }) {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useAssets(status);
  const [creating, setCreating] = useState(false);
  const [assignTarget, setAssignTarget] = useState<Asset | null>(null);

  const rows = data?.assets ?? [];

  const columns: Column<Asset>[] = useMemo(() => {
    const cols: Column<Asset>[] = [
      { key: 'tag', header: 'Tag', sortValue: (a) => a.tag, render: (a) => <span className={shared.cellRef}>{a.tag}</span> },
      { key: 'name', header: 'Name', sortValue: (a) => a.name, render: (a) => <span className={shared.cellMain}>{a.name}</span> },
      { key: 'category', header: 'Category', sortValue: (a) => a.category ?? '', render: (a) => a.category ? titleCase(a.category) : <span className={shared.cellSub}>—</span> },
      { key: 'assignee', header: 'Assignee', sortValue: (a) => a.assigneeName ?? '', render: (a) => a.assigneeName ?? <span className={shared.cellSub}>Unassigned</span> },
      { key: 'status', header: 'Status', sortValue: (a) => a.status, render: (a) => <StatusPill status={a.status} /> },
      { key: 'value', header: 'Value', align: 'right', sortValue: (a) => a.valueMinor ?? 0, render: (a) => <span className={shared.money}>{a.valueMinor != null ? formatMoney(a.valueMinor, a.currency ?? 'USD') : '—'}</span> },
    ];
    if (canWrite) {
      cols.push({
        key: 'action', header: '', align: 'right',
        render: (a) => <Button size="sm" variant="secondary" onClick={() => setAssignTarget(a)}>Assign</Button>,
      });
    }
    return cols;
  }, [canWrite]);

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            {ASSET_STATUSES.map((s) => <option key={s} value={s}>{s ? titleCase(s) : 'All'}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} asset{rows.length === 1 ? '' : 's'}</span>
        {canWrite && <Button size="sm" variant="primary" onClick={() => setCreating(true)} icon={<span aria-hidden>+</span>}>New asset</Button>}
      </div>
      <Table
        columns={columns}
        rows={data?.assets}
        loading={isLoading}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No assets" message="No assets match the current filter." icon="▤" />}
      />
      <NewAssetModal open={creating} onClose={() => setCreating(false)} />
      <AssignModal asset={assignTarget} onClose={() => setAssignTarget(null)} />
    </>
  );
}

function NewAssetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateAsset();
  const [tag, setTag] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTag(''); setName(''); setCategory(''); setPurchaseDate('');
    setValue(''); setCurrency('USD'); setError(null);
  };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!tag.trim() || !name.trim()) { setError('Tag and name are required.'); return; }
    const body: CreateAssetBody = { tag: tag.trim(), name: name.trim() };
    if (category.trim()) body.category = category.trim();
    if (purchaseDate) body.purchaseDate = purchaseDate;
    if (value) {
      const n = Number(value);
      if (Number.isNaN(n) || n < 0) { setError('Enter a non-negative value in major units.'); return; }
      body.value = n;
      body.currency = currency;
    }
    try {
      await create.mutateAsync(body);
      toast.success(`Added asset “${name}”`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the asset.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New asset"
      description="Register a hardware or tracked asset for this tenant."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!tag.trim() || !name.trim()}>Create asset</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Tag" value={tag} onChange={setTag} required placeholder="e.g. LAP-0012" />
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. MacBook Pro 16" />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Category" value={category} onChange={setCategory} placeholder="e.g. laptop" />
          <TextField label="Purchase date" type="date" value={purchaseDate} onChange={setPurchaseDate} />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Value" hint="Major units (optional)">
            <Input type="number" min="0" step="any" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 2500" />
          </FormField>
          <FormField label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} placeholder="USD" />
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function AssignModal({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const toast = useToast();
  const assign = useAssignAsset();
  const { data, isLoading } = useEmployees(!!asset);
  const [employeeId, setEmployeeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const employees = data?.employees ?? [];
  const close = () => { setEmployeeId(''); setError(null); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!asset) return;
    if (!employeeId) { setError('Select an employee.'); return; }
    try {
      await assign.mutateAsync({ id: asset.id, employeeId });
      toast.success('Asset assigned');
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not assign the asset.');
    }
  };

  return (
    <Modal
      open={!!asset}
      onClose={close}
      title="Assign asset"
      description={asset ? `${asset.tag} · ${asset.name}` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={assign.isPending} disabled={!employeeId}>Assign</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Employee" required hint={isLoading ? 'Loading employees…' : undefined}>
          <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={isLoading}>
            <option value="">Select an employee…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.firstName} {emp.lastName} ({emp.employeeNo})
              </option>
            ))}
          </Select>
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Licenses ---------------- */
function LicensesTab({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading } = useLicenses();
  const [creating, setCreating] = useState(false);
  const rows = data?.licenses ?? [];

  const columns: Column<License>[] = [
    { key: 'name', header: 'Name', sortValue: (l) => l.name, render: (l) => <span className={shared.cellMain}>{l.name}</span> },
    { key: 'vendor', header: 'Vendor', sortValue: (l) => l.vendor ?? '', render: (l) => l.vendor ?? <span className={shared.cellSub}>—</span> },
    { key: 'seats', header: 'Seats', align: 'right', sortValue: (l) => l.seatsUsed, render: (l) => <span className={shared.money}>{l.seatsUsed} / {l.seatsTotal}</span> },
    { key: 'available', header: 'Available', align: 'right', sortValue: (l) => l.seatsAvailable, render: (l) => <span className={shared.money}>{l.seatsAvailable}</span> },
    {
      key: 'expiry', header: 'Expiry', sortValue: (l) => l.expiryDate ?? '',
      render: (l) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {formatDate(l.expiryDate)}
          {l.expiringSoon && <Badge color="amber">Expiring soon</Badge>}
        </span>
      ),
    },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <CardHeader title="Software licenses" subtitle="Seat utilisation and renewal windows." />
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} license{rows.length === 1 ? '' : 's'}</span>
        {canWrite && <Button size="sm" variant="primary" onClick={() => setCreating(true)} icon={<span aria-hidden>+</span>}>New license</Button>}
      </div>
      <Table
        columns={columns}
        rows={data?.licenses}
        loading={isLoading}
        rowKey={(l) => l.id}
        empty={<EmptyState title="No licenses" message="Register a software license to track seats." icon="◇" />}
      />
      <NewLicenseModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NewLicenseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateLicense();
  const [name, setName] = useState('');
  const [vendor, setVendor] = useState('');
  const [seatsTotal, setSeatsTotal] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [cost, setCost] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName(''); setVendor(''); setSeatsTotal(''); setExpiryDate('');
    setCost(''); setCurrency('USD'); setError(null);
  };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    const seats = Number(seatsTotal);
    if (!seatsTotal || Number.isNaN(seats) || seats < 0 || !Number.isInteger(seats)) {
      setError('Enter a non-negative whole number of seats.');
      return;
    }
    const body: CreateLicenseBody = { name: name.trim(), seatsTotal: seats };
    if (vendor.trim()) body.vendor = vendor.trim();
    if (expiryDate) body.expiryDate = expiryDate;
    if (cost) {
      const n = Number(cost);
      if (Number.isNaN(n) || n < 0) { setError('Enter a non-negative cost in major units.'); return; }
      body.cost = n;
      body.currency = currency;
    }
    try {
      await create.mutateAsync(body);
      toast.success(`Added license “${name}”`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the license.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New license"
      description="Track a software license and its seat allocation."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim() || !seatsTotal.trim()}>Create license</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Figma Enterprise" />
          <TextField label="Vendor" value={vendor} onChange={setVendor} placeholder="e.g. Figma Inc." />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Seats" required>
            <Input type="number" min="0" step="1" value={seatsTotal} onChange={(e) => setSeatsTotal(e.target.value)} placeholder="e.g. 50" />
          </FormField>
          <TextField label="Expiry date" type="date" value={expiryDate} onChange={setExpiryDate} />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Cost" hint="Major units (optional)">
            <Input type="number" min="0" step="any" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 12000" />
          </FormField>
          <FormField label="Currency">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} placeholder="USD" />
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Entitlements ---------------- */
function EntitlementsTab({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading } = useEntitlements();
  const toast = useToast();
  const upsert = useUpsertEntitlement();
  const [adding, setAdding] = useState(false);

  const rows = data?.entitlements ?? [];

  const toggle = async (ent: Entitlement) => {
    try {
      await upsert.mutateAsync({
        featureKey: ent.featureKey,
        body: { isEnabled: !ent.isEnabled, plan: ent.plan ?? undefined, limitValue: ent.limitValue ?? undefined },
      });
      toast.success(`${ent.isEnabled ? 'Disabled' : 'Enabled'} ${ent.featureKey}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the entitlement.');
    }
  };

  const columns: Column<Entitlement>[] = useMemo(() => {
    const cols: Column<Entitlement>[] = [
      { key: 'featureKey', header: 'Feature key', sortValue: (e) => e.featureKey, render: (e) => <span className={shared.cellRef}>{e.featureKey}</span> },
      { key: 'plan', header: 'Plan', sortValue: (e) => e.plan ?? '', render: (e) => e.plan ? titleCase(e.plan) : <span className={shared.cellSub}>—</span> },
      { key: 'limit', header: 'Limit', align: 'right', sortValue: (e) => e.limitValue ?? -1, render: (e) => e.limitValue != null ? e.limitValue : <span className={shared.cellSub}>—</span> },
      {
        key: 'state', header: 'State',
        render: (e) => (
          <StatusPill
            status={e.isEnabled ? 'ENABLED' : 'DISABLED'}
            label={e.isEnabled ? 'Enabled' : 'Disabled'}
            metaColors={{ ENABLED: 'green', DISABLED: 'slate' }}
          />
        ),
      },
    ];
    if (canWrite) {
      cols.push({
        key: 'action', header: '', align: 'right',
        render: (e) => (
          <Button
            size="sm"
            variant={e.isEnabled ? 'secondary' : 'primary'}
            onClick={() => toggle(e)}
            loading={upsert.isPending && upsert.variables?.featureKey === e.featureKey}
          >
            {e.isEnabled ? 'Disable' : 'Enable'}
          </Button>
        ),
      });
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, upsert.isPending, upsert.variables]);

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <CardHeader title="Feature entitlements" subtitle="Toggle a feature per tenant instantly — no deployment required." />
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} feature{rows.length === 1 ? '' : 's'}</span>
        {canWrite && <Button size="sm" variant="primary" onClick={() => setAdding(true)} icon={<span aria-hidden>+</span>}>Add entitlement</Button>}
      </div>
      <Table
        columns={columns}
        rows={data?.entitlements}
        loading={isLoading}
        rowKey={(e) => e.featureKey}
        empty={<EmptyState title="No entitlements" message="Add a feature entitlement to control access per tenant." icon="⚑" />}
      />
      <AddEntitlementModal open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function AddEntitlementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const upsert = useUpsertEntitlement();
  const [featureKey, setFeatureKey] = useState('');
  const [enabled, setEnabled] = useState('true');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setFeatureKey(''); setEnabled('true'); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!featureKey.trim()) { setError('Feature key is required.'); return; }
    try {
      await upsert.mutateAsync({ featureKey: featureKey.trim(), body: { isEnabled: enabled === 'true' } });
      toast.success(`Saved entitlement “${featureKey.trim()}”`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the entitlement.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add entitlement"
      description="Define a feature flag for this tenant — it takes effect immediately."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={upsert.isPending} disabled={!featureKey.trim()}>Save entitlement</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <TextField label="Feature key" value={featureKey} onChange={setFeatureKey} required placeholder="e.g. advanced_analytics" />
        <FormField label="Initial state">
          <Select value={enabled} onChange={(e) => setEnabled(e.target.value)}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </Select>
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
