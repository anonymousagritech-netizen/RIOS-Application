import { BadgeCheck, FileText, HardDrive, Key, Package, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { formatMoney, formatDate, formatNumber, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './workspace.module.css';
import css from './AssetsPage.module.css';

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

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY'];
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
  const [createSignal, setCreateSignal] = useState(0);
  const canWrite = hasPermission('asset:write');

  const assets = useAssets('');
  const licenses = useLicenses();
  const entitlements = useEntitlements();

  const assetCount = assets.data?.assets.length ?? 0;
  const inUse = (assets.data?.assets ?? []).filter((a) => a.status === 'in_use').length;
  const seatsUsed = (licenses.data?.licenses ?? []).reduce((acc, l) => acc + l.seatsUsed, 0);
  const seatsTotal = (licenses.data?.licenses ?? []).reduce((acc, l) => acc + l.seatsTotal, 0);
  const enabledFeatures = (entitlements.data?.entitlements ?? []).filter((e) => e.isEnabled).length;

  const createLabel = tab === 'licenses' ? 'New license' : tab === 'entitlements' ? 'Add entitlement' : 'New asset';

  return (
    <>
      <PageHeader
        title="Assets & entitlements"
        description="Hardware and software inventory, seat utilisation, and per-tenant feature entitlements toggled without a deploy."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Assets & entitlements' }]}
        actions={
          canWrite
            ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreateSignal((n) => n + 1)}>{createLabel}</Button>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <div className={css.page}>
        <div className={css.kpis}>
          <KpiCard label="Assets" value={formatNumber(assetCount)} hint="Tracked hardware items" icon={<Package size={20} />} accent="var(--primary)" loading={assets.isLoading} />
          <KpiCard label="In use" value={formatNumber(inUse)} hint="Currently assigned" icon={<HardDrive size={20} />} accent="var(--accent-emerald)" loading={assets.isLoading} />
          <KpiCard label="License seats" value={`${formatNumber(seatsUsed)} / ${formatNumber(seatsTotal)}`} hint="Used of total" icon={<Key size={20} />} accent="var(--accent-violet)" loading={licenses.isLoading} />
          <KpiCard label="Features enabled" value={formatNumber(enabledFeatures)} hint="Active entitlements" icon={<BadgeCheck size={20} />} accent="var(--accent-cyan)" loading={entitlements.isLoading} />
        </div>

        <Card padded={false}>
          <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
          {tab === 'assets' && <AssetsTab canWrite={canWrite} createSignal={createSignal} />}
          {tab === 'licenses' && <LicensesTab canWrite={canWrite} createSignal={createSignal} />}
          {tab === 'entitlements' && <EntitlementsTab canWrite={canWrite} createSignal={createSignal} />}
        </Card>
      </div>
    </>
  );
}

/* ---------------- Assets ---------------- */
function AssetsTab({ canWrite, createSignal }: { canWrite: boolean; createSignal: number }) {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useAssets(status);
  const [creating, setCreating] = useState(false);
  const [assignTarget, setAssignTarget] = useState<Asset | null>(null);

  useEffect(() => { if (createSignal > 0 && canWrite) setCreating(true); }, [createSignal, canWrite]);

  const rows = data?.assets ?? [];

  const columns: Column<Asset>[] = useMemo(() => {
    const cols: Column<Asset>[] = [
      { key: 'tag', header: 'Tag', sortValue: (a) => a.tag, render: (a) => <span className={shared.cellRef}>{a.tag}</span> },
      { key: 'name', header: 'Name', sortValue: (a) => a.name, render: (a) => <span className={shared.cellMain}>{a.name}</span> },
      { key: 'category', header: 'Category', sortValue: (a) => a.category ?? '', render: (a) => a.category ? titleCase(a.category) : <span className={shared.cellSub}>-</span> },
      { key: 'assignee', header: 'Assignee', sortValue: (a) => a.assigneeName ?? '', render: (a) => a.assigneeName ?? <span className={shared.cellSub}>Unassigned</span> },
      { key: 'status', header: 'Status', sortValue: (a) => a.status, render: (a) => <StatusPill status={a.status} /> },
      { key: 'value', header: 'Value', align: 'right', sortValue: (a) => a.valueMinor ?? 0, render: (a) => <span className={shared.money}>{a.valueMinor != null ? formatMoney(a.valueMinor, a.currency ?? 'USD') : '-'}</span> },
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
      <div className={`${shared.toolbar} ${css.toolbarPad}`}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            {ASSET_STATUSES.map((s) => <option key={s} value={s}>{s ? titleCase(s) : 'All'}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} asset{rows.length === 1 ? '' : 's'}</span>
      </div>
      <Table
        columns={columns}
        rows={data?.assets}
        loading={isLoading}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No assets" message="No assets match the current filter." icon={<Package size={16} />} />}
      />
      <NewAssetModal open={creating} onClose={() => setCreating(false)} />
      <AssignModal asset={assignTarget} onClose={() => setAssignTarget(null)} />
    </>
  );
}

function NewAssetModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateAsset();
  const { data: empData, isLoading: loadingEmployees } = useEmployees(open);
  const employees = empData?.employees ?? [];
  const [tag, setTag] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTag(''); setName(''); setCategory(''); setAssignedTo(''); setPurchaseDate('');
    setValue(''); setCurrency('USD'); setError(null);
  };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!tag.trim() || !name.trim()) { setError('Tag and name are required.'); return; }
    const body: CreateAssetBody = { tag: tag.trim(), name: name.trim() };
    if (category.trim()) body.category = category.trim();
    if (assignedTo) body.assignedTo = assignedTo;
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
      size="lg"
      title="New asset"
      description="Register a hardware or tracked asset: identification, assignment and purchase detail."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!tag.trim() || !name.trim()}>Create asset</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification">
          <TextField label="Tag" value={tag} onChange={setTag} required placeholder="e.g. LAP-0012" hint="Unique asset tag / barcode" />
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. MacBook Pro 16" />
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Category" value={category} onChange={setCategory} placeholder="e.g. laptop, monitor, phone" />
          </div>
        </FormSection>

        <FormSection title="Assignment" description="Optionally assign the asset to an employee on creation.">
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField label="Assigned to" hint={loadingEmployees ? 'Loading employees…' : 'Leave unassigned to keep the asset available'}>
              <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} disabled={loadingEmployees}>
                <option value="">Unassigned</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.firstName} {emp.lastName} ({emp.employeeNo})</option>
                ))}
              </Select>
            </FormField>
          </div>
        </FormSection>

        <FormSection title="Purchase & value">
          <TextField label="Purchase date" type="date" value={purchaseDate} onChange={setPurchaseDate} />
          <FormField label="Value" hint="Major units (optional)">
            <Input type="number" min="0" step="any" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 2500" />
          </FormField>
          <FormField label="Currency">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </FormField>
        </FormSection>

        {error && <p className={css.error} role="alert">{error}</p>}
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
      <form onSubmit={submit} className={css.form}>
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
        {error && <p className={css.error} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Licenses ---------------- */
function LicensesTab({ canWrite, createSignal }: { canWrite: boolean; createSignal: number }) {
  const { data, isLoading } = useLicenses();
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (createSignal > 0 && canWrite) setCreating(true); }, [createSignal, canWrite]);
  const rows = data?.licenses ?? [];

  const columns: Column<License>[] = [
    { key: 'name', header: 'Name', sortValue: (l) => l.name, render: (l) => <span className={shared.cellMain}>{l.name}</span> },
    { key: 'vendor', header: 'Vendor', sortValue: (l) => l.vendor ?? '', render: (l) => l.vendor ?? <span className={shared.cellSub}>-</span> },
    { key: 'seats', header: 'Seats', align: 'right', sortValue: (l) => l.seatsUsed, render: (l) => <span className={shared.money}>{l.seatsUsed} / {l.seatsTotal}</span> },
    { key: 'available', header: 'Available', align: 'right', sortValue: (l) => l.seatsAvailable, render: (l) => <span className={shared.money}>{l.seatsAvailable}</span> },
    {
      key: 'expiry', header: 'Expiry', sortValue: (l) => l.expiryDate ?? '',
      render: (l) => (
        <span className={css.expiryCell}>
          {formatDate(l.expiryDate)}
          {l.expiringSoon && <Badge color="amber">Expiring soon</Badge>}
        </span>
      ),
    },
  ];

  return (
    <>
      <div className={`${shared.toolbar} ${css.toolbarPad}`}>
        <CardHeader title="Software licenses" subtitle="Seat utilisation and renewal windows." />
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} license{rows.length === 1 ? '' : 's'}</span>
      </div>
      <Table
        columns={columns}
        rows={data?.licenses}
        loading={isLoading}
        rowKey={(l) => l.id}
        empty={<EmptyState title="No licenses" message="Register a software license to track seats." icon={<FileText size={16} />} />}
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
      size="lg"
      title="New license"
      description="Track a software license: vendor, seat allocation and renewal window."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim() || !seatsTotal.trim()}>Create license</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification">
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Figma Enterprise" />
          <TextField label="Vendor" value={vendor} onChange={setVendor} placeholder="e.g. Figma Inc." />
        </FormSection>

        <FormSection title="Seats & renewal">
          <FormField label="Seats" required hint="Total seats provisioned">
            <Input type="number" min="0" step="1" value={seatsTotal} onChange={(e) => setSeatsTotal(e.target.value)} placeholder="e.g. 50" />
          </FormField>
          <TextField label="Expiry date" type="date" value={expiryDate} onChange={setExpiryDate} hint="Renewal / expiry (optional)" />
        </FormSection>

        <FormSection title="Cost">
          <FormField label="Cost" hint="Major units (optional)">
            <Input type="number" min="0" step="any" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="e.g. 12000" />
          </FormField>
          <FormField label="Currency">
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </FormField>
        </FormSection>

        {error && <p className={css.error} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Entitlements ---------------- */
function EntitlementsTab({ canWrite, createSignal }: { canWrite: boolean; createSignal: number }) {
  const { data, isLoading } = useEntitlements();
  const toast = useToast();
  const upsert = useUpsertEntitlement();
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (createSignal > 0 && canWrite) setAdding(true); }, [createSignal, canWrite]);

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
      { key: 'plan', header: 'Plan', sortValue: (e) => e.plan ?? '', render: (e) => e.plan ? titleCase(e.plan) : <span className={shared.cellSub}>-</span> },
      { key: 'limit', header: 'Limit', align: 'right', sortValue: (e) => e.limitValue ?? -1, render: (e) => e.limitValue != null ? e.limitValue : <span className={shared.cellSub}>-</span> },
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
      <div className={`${shared.toolbar} ${css.toolbarPad}`}>
        <CardHeader title="Feature entitlements" subtitle="Toggle a feature per tenant instantly - no deployment required." />
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} feature{rows.length === 1 ? '' : 's'}</span>
      </div>
      <Table
        columns={columns}
        rows={data?.entitlements}
        loading={isLoading}
        rowKey={(e) => e.featureKey}
        empty={<EmptyState title="No entitlements" message="Add a feature entitlement to control access per tenant." icon={<BadgeCheck size={16} />} />}
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
  const [plan, setPlan] = useState('');
  const [limitValue, setLimitValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setFeatureKey(''); setEnabled('true'); setPlan(''); setLimitValue(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!featureKey.trim()) { setError('Feature key is required.'); return; }
    const body: UpsertEntitlementBody = { isEnabled: enabled === 'true' };
    if (plan.trim()) body.plan = plan.trim();
    if (limitValue.trim()) {
      const n = Number(limitValue);
      if (Number.isNaN(n) || n < 0 || !Number.isInteger(n)) { setError('Enter a non-negative whole number limit.'); return; }
      body.limitValue = n;
    }
    try {
      await upsert.mutateAsync({ featureKey: featureKey.trim(), body });
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
      description="Define a feature flag for this tenant - it takes effect immediately."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={upsert.isPending} disabled={!featureKey.trim()}>Save entitlement</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Feature">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Feature key" value={featureKey} onChange={setFeatureKey} required placeholder="e.g. advanced_analytics" hint="Stable key referenced by the entitlement engine" />
          </div>
          <FormField label="Initial state">
            <Select value={enabled} onChange={(e) => setEnabled(e.target.value)}>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Plan & limits" description="Optional plan tier and numeric usage cap for this feature.">
          <TextField label="Plan" value={plan} onChange={setPlan} placeholder="e.g. pro, enterprise" />
          <FormField label="Limit" hint="Numeric cap (optional, e.g. seats or API calls)">
            <Input type="number" min="0" step="1" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} placeholder="e.g. 100" />
          </FormField>
        </FormSection>

        {error && <p className={css.error} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
