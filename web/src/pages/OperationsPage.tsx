import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { KpiCard } from '../components/KpiCard';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { ErrorState } from '../components/Feedback';
import { formatNumber, formatDateTime, titleCase } from '../lib/format';
import { Database, Clock, AlertTriangle, CheckCircle2, Gauge, ArrowLeftRight } from 'lucide-react';
import shared from './shared.module.css';
import styles from './workspace.module.css';

/* ---------------- Types ---------------- */
interface Health {
  auditEvents: number;
  pendingEvents: number;
  openClaims: number;
  activeContracts: number;
  lastActivityAt: string | null;
  slaTargets: number;
}

interface AuditEntry {
  occurredAt: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string;
  tamperChainPresent: boolean;
}
interface AuditResponse { entries: AuditEntry[]; }

interface OutboxEvent {
  id: string;
  topic: string;
  createdAt: string | null;
  publishedAt: string | null;
  attempts: number;
  status: string;
}
interface EventsResponse { events: OutboxEvent[]; }

interface SlaTarget {
  id: string;
  service: string;
  metric: string;
  targetValue: number;
  unit: string | null;
  createdAt: string;
}
interface SlaResponse { slaTargets: SlaTarget[]; }

/* ---------------- Data hooks ---------------- */
function useHealth() {
  return useQuery({
    queryKey: ['ops', 'health'],
    queryFn: () => api<Health>('/api/ops/health'),
  });
}
function useAudit(entityType: string, action: string) {
  return useQuery({
    queryKey: ['ops', 'audit', entityType, action],
    queryFn: () =>
      api<AuditResponse>(`/api/ops/audit${qs({ entityType: entityType || undefined, action: action || undefined, limit: '100' })}`),
  });
}
function useEvents(status: string) {
  return useQuery({
    queryKey: ['ops', 'events', status],
    queryFn: () => api<EventsResponse>(`/api/ops/events${qs({ status: status || undefined })}`),
  });
}
function useSla() {
  return useQuery({
    queryKey: ['ops', 'sla'],
    queryFn: () => api<SlaResponse>('/api/ops/sla'),
  });
}

interface CreateSlaBody { service: string; metric: string; targetValue: number; unit?: string; }
function useCreateSla() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSlaBody) => api('/api/ops/sla', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ops', 'sla'] }),
  });
}

/* ---------------- Constants ---------------- */
const EVENT_STATUSES = ['', 'published', 'pending'];
const TABS = [
  { id: 'health', label: 'Health' },
  { id: 'audit', label: 'Audit log' },
  { id: 'events', label: 'Events' },
  { id: 'sla', label: 'SLA' },
];

export function OperationsPage() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState('health');
  const canWrite = hasPermission('ops:write');

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Operations' }]}
        title="Operations"
        description="Platform health, the immutable audit viewer, event-delivery monitor and SLA targets."
        actions={
          canWrite
            ? <Badge color="green">ops:write granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      {tab === 'health' && <HealthTab />}

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'audit' && <AuditTab />}
        {tab === 'events' && <EventsTab />}
        {tab === 'sla' && <SlaTab canWrite={canWrite} />}
        {tab === 'health' && <HealthDetail />}
      </Card>
    </>
  );
}

/* ---------------- Health ---------------- */
function HealthTab() {
  const { data, isLoading, isError } = useHealth();

  if (isError) {
    return <Card><ErrorState message="Could not load platform health." /></Card>;
  }

  return (
    <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
      <KpiCard label="Audit events" value={formatNumber(data?.auditEvents)} loading={isLoading} icon={<Database size={20} />} accent="var(--primary)" />
      <KpiCard label="Pending events" value={formatNumber(data?.pendingEvents)} loading={isLoading} icon={<Clock size={20} />} accent="var(--accent-orange)" />
      <KpiCard label="Open claims" value={formatNumber(data?.openClaims)} loading={isLoading} icon={<AlertTriangle size={20} />} accent="var(--accent-rose)" />
      <KpiCard label="Active contracts" value={formatNumber(data?.activeContracts)} loading={isLoading} icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" />
      <KpiCard label="SLA targets" value={formatNumber(data?.slaTargets)} loading={isLoading} icon={<Gauge size={20} />} accent="var(--accent-violet)" />
    </div>
  );
}

function HealthDetail() {
  const { data, isLoading } = useHealth();
  const lastActivity = data?.lastActivityAt;
  const stale = data?.pendingEvents ? data.pendingEvents > 0 : false;

  return (
    <div style={{ padding: 'var(--space-5)' }}>
      <CardHeader title="System status" subtitle="Live operational state for this tenant." />
      <div className={styles.balanceBar} style={{ padding: 'var(--space-4) 0 0' }}>
        <div className={styles.totals}>
          <div className={styles.total}>
            <span className={styles.totalLabel}>Last activity</span>
            <span className={styles.totalValue}>{isLoading ? '-' : formatDateTime(lastActivity)}</span>
          </div>
          <div className={styles.total}>
            <span className={styles.totalLabel}>Event backlog</span>
            <span className={styles.totalValue}>{isLoading ? '-' : formatNumber(data?.pendingEvents)}</span>
          </div>
        </div>
        {!isLoading && (
          <StatusPill
            status={stale ? 'BACKLOG' : 'HEALTHY'}
            label={stale ? 'Events pending delivery' : 'All systems nominal ✓'}
            metaColors={{ HEALTHY: 'green', BACKLOG: 'amber' }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- Audit log ---------------- */
const AUDIT_ACTIONS = ['', 'create', 'update', 'assign', 'upsert', 'transition', 'delete'];

function AuditTab() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const { data, isLoading } = useAudit(entityType, action);
  const rows = data?.entries ?? [];

  const columns: Column<AuditEntry>[] = [
    { key: 'time', header: 'Time', sortValue: (e) => e.occurredAt ?? '', render: (e) => <span className={shared.cellSub}>{formatDateTime(e.occurredAt)}</span> },
    { key: 'actor', header: 'Actor', sortValue: (e) => e.actorLabel ?? '', render: (e) => e.actorLabel ?? <span className={shared.cellSub}>system</span> },
    { key: 'action', header: 'Action', render: (e) => <StatusPill status={e.action} /> },
    { key: 'entityType', header: 'Entity', sortValue: (e) => e.entityType, render: (e) => titleCase(e.entityType) },
    { key: 'entityId', header: 'Entity ID', render: (e) => <span className={shared.cellRef}>{e.entityId}</span> },
    {
      key: 'chain', header: 'Chain', align: 'right',
      render: (e) => e.tamperChainPresent
        ? <Badge color="green">chained ✓</Badge>
        : <Badge color="slate">none</Badge>,
    },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Entity</span>
          <Input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="e.g. asset" aria-label="Filter by entity type" style={{ minWidth: 160 }} />
        </div>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Action</span>
          <Select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
            {AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a ? titleCase(a) : 'All'}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span>
      </div>
      <Table
        columns={columns}
        rows={data?.entries}
        loading={isLoading}
        rowKey={(e) => `${e.entityId}-${e.occurredAt ?? ''}-${e.action}`}
        empty={<EmptyState title="No audit entries" message="No audit activity matches the current filter." icon={<Database size={16} />} />}
      />
    </>
  );
}

/* ---------------- Events ---------------- */
function EventsTab() {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useEvents(status);
  const rows = data?.events ?? [];

  const columns: Column<OutboxEvent>[] = [
    { key: 'topic', header: 'Topic', sortValue: (e) => e.topic, render: (e) => <span className={shared.cellMain}>{e.topic}</span> },
    { key: 'created', header: 'Created', sortValue: (e) => e.createdAt ?? '', render: (e) => <span className={shared.cellSub}>{formatDateTime(e.createdAt)}</span> },
    { key: 'published', header: 'Published', sortValue: (e) => e.publishedAt ?? '', render: (e) => <span className={shared.cellSub}>{e.publishedAt ? formatDateTime(e.publishedAt) : '-'}</span> },
    {
      key: 'status', header: 'Status',
      render: (e) => (
        <StatusPill
          status={e.status}
          metaColors={{ published: 'green', pending: 'amber' }}
        />
      ),
    },
    { key: 'attempts', header: 'Attempts', align: 'right', sortValue: (e) => e.attempts, render: (e) => <span className={shared.money}>{e.attempts}</span> },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <CardHeader title="Event delivery" subtitle="Transactional outbox - publication status and retry attempts." />
        <div className={shared.spacer} />
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            {EVENT_STATUSES.map((s) => <option key={s} value={s}>{s ? titleCase(s) : 'All'}</option>)}
          </Select>
        </div>
        <span className={shared.cellSub}>{rows.length} event{rows.length === 1 ? '' : 's'}</span>
      </div>
      <Table
        columns={columns}
        rows={data?.events}
        loading={isLoading}
        rowKey={(e) => e.id}
        empty={<EmptyState title="No events" message="No outbox events match the current filter." icon={<ArrowLeftRight size={16} />} />}
      />
    </>
  );
}

/* ---------------- SLA ---------------- */
function SlaTab({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading } = useSla();
  const [creating, setCreating] = useState(false);
  const rows = data?.slaTargets ?? [];

  const columns: Column<SlaTarget>[] = [
    { key: 'service', header: 'Service', sortValue: (s) => s.service, render: (s) => <span className={shared.cellMain}>{s.service}</span> },
    { key: 'metric', header: 'Metric', sortValue: (s) => s.metric, render: (s) => s.metric },
    { key: 'target', header: 'Target', align: 'right', sortValue: (s) => s.targetValue, render: (s) => <span className={shared.money}>{formatNumber(s.targetValue)}</span> },
    { key: 'unit', header: 'Unit', render: (s) => s.unit ?? <span className={shared.cellSub}>-</span> },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <CardHeader title="SLA targets" subtitle="Service-level objectives tracked per tenant." />
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} target{rows.length === 1 ? '' : 's'}</span>
        {canWrite && <Button size="sm" variant="primary" onClick={() => setCreating(true)} icon={<span aria-hidden>+</span>}>New SLA target</Button>}
      </div>
      <Table
        columns={columns}
        rows={data?.slaTargets}
        loading={isLoading}
        rowKey={(s) => s.id}
        empty={<EmptyState title="No SLA targets" message="Define a service-level objective to begin tracking." icon={<Gauge size={16} />} />}
      />
      <NewSlaModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NewSlaModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateSla();
  const [service, setService] = useState('');
  const [metric, setMetric] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [unit, setUnit] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setService(''); setMetric(''); setTargetValue(''); setUnit(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!service.trim() || !metric.trim()) { setError('Service and metric are required.'); return; }
    const n = Number(targetValue);
    if (!targetValue || Number.isNaN(n)) { setError('Enter a numeric target value.'); return; }
    const body: CreateSlaBody = { service: service.trim(), metric: metric.trim(), targetValue: n };
    if (unit.trim()) body.unit = unit.trim();
    try {
      await create.mutateAsync(body);
      toast.success(`Saved SLA target for ${service.trim()}`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the SLA target.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New SLA target"
      description="Define a service-level objective for this tenant."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!service.trim() || !metric.trim() || !targetValue.trim()}>Save target</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Service" value={service} onChange={setService} required placeholder="e.g. api" />
          <TextField label="Metric" value={metric} onChange={setMetric} required placeholder="e.g. availability" />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Target value" required>
            <Input type="number" step="any" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder="e.g. 99.9" />
          </FormField>
          <TextField label="Unit" value={unit} onChange={setUnit} placeholder="e.g. %" />
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
