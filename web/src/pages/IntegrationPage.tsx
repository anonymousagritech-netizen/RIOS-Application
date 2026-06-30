import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, Textarea } from '../components/Form';
import { formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './IntegrationPage.module.css';

/* ---------------- Types ---------------- */
interface Subscription {
  id: string;
  url: string;
  event_types: string[];
  is_active: boolean;
  created_at: string;
}
interface SubscriptionsResponse { subscriptions: Subscription[]; }
interface Delivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  created_at: string;
}
interface DeliveriesResponse { deliveries: Delivery[]; }
interface EmitResponse { enqueued: number; }
interface ExportResponse { entity: string; rows: Record<string, unknown>[]; }
interface ImportResponse { accepted: number; rejected: { index: number; errors: string[] }[]; }

const ENTITIES = ['parties', 'contracts', 'claims'];

/* ---------------- Data hooks ---------------- */
function useWebhooks() {
  return useQuery({
    queryKey: ['integration', 'webhooks'],
    queryFn: () => api<SubscriptionsResponse>('/api/integration/webhooks'),
  });
}
function useDeliveries(id: string | null) {
  return useQuery({
    queryKey: ['integration', 'deliveries', id],
    queryFn: () => api<DeliveriesResponse>(`/api/integration/webhooks/${id}/deliveries`),
    enabled: !!id,
  });
}
function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; eventTypes: string[]; secret?: string }) =>
      api('/api/integration/webhooks', { body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['integration', 'webhooks'] }); },
  });
}
function useDisableWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/integration/webhooks/${id}/disable`, { body: {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['integration', 'webhooks'] }); },
  });
}
function useEmitEvent() {
  return useMutation({
    mutationFn: (body: { eventType: string; payload?: unknown }) =>
      api<EmitResponse>('/api/integration/webhooks/emit', { body }),
  });
}
function useExport() {
  return useMutation({
    mutationFn: (entity: string) =>
      api<ExportResponse>(`/api/integration/export?entity=${encodeURIComponent(entity)}&format=json`),
  });
}
function useImport() {
  return useMutation({
    mutationFn: (body: { entity: string; rows: Record<string, unknown>[] }) =>
      api<ImportResponse>('/api/integration/import', { body }),
  });
}

const TABS = [
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'data', label: 'Data' },
];

export function IntegrationPage() {
  const [tab, setTab] = useState('webhooks');

  return (
    <>
      <PageHeader
        title="Integration"
        description="Webhook subscriptions, event delivery and data import/export."
      />

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'webhooks' && <WebhooksTab />}
        {tab === 'data' && <DataTab />}
      </Card>
    </>
  );
}

/* ---------------- Webhooks tab ---------------- */
function WebhooksTab() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('integration:write');
  const { data, isLoading } = useWebhooks();
  const [showNew, setShowNew] = useState(false);
  const [showEmit, setShowEmit] = useState(false);
  const [selected, setSelected] = useState<Subscription | null>(null);

  const columns: Column<Subscription>[] = [
    {
      key: 'url', header: 'Endpoint', sortValue: (s) => s.url,
      render: (s) => <span className={shared.cellMain} style={{ wordBreak: 'break-all' }}>{s.url}</span>,
    },
    {
      key: 'events', header: 'Event types',
      render: (s) => (
        <div className={styles.eventTypes}>
          {s.event_types.length
            ? s.event_types.map((e) => <Badge key={e} color="indigo">{e}</Badge>)
            : <span className={shared.cellSub}>—</span>}
        </div>
      ),
    },
    {
      key: 'active', header: 'Active', sortValue: (s) => (s.is_active ? 1 : 0),
      render: (s) => <StatusPill status={s.is_active ? 'ACTIVE' : 'DISABLED'} metaColors={{ ACTIVE: 'green', DISABLED: 'slate' }} />,
    },
    { key: 'created', header: 'Created', sortValue: (s) => s.created_at, render: (s) => formatDateTime(s.created_at) },
    {
      key: 'actions', header: '', align: 'right',
      render: (s) => (
        <div onClick={(e) => e.stopPropagation()} className={styles.panelActions} style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" onClick={() => setSelected(s)}>Deliveries</Button>
          {canWrite && s.is_active && <DisableCell sub={s} />}
        </div>
      ),
    },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }} className={shared.toolbar}>
        <span className={shared.cellSub}>{data?.subscriptions.length ?? 0} subscription{(data?.subscriptions.length ?? 0) === 1 ? '' : 's'}</span>
        <div className={shared.spacer} />
        {canWrite && (
          <>
            <Button variant="secondary" size="sm" onClick={() => setShowEmit(true)}>Emit test event</Button>
            <Button variant="primary" size="sm" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New webhook</Button>
          </>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.subscriptions}
        loading={isLoading}
        rowKey={(s) => s.id}
        onRowClick={(s) => setSelected(s)}
        empty={<EmptyState title="No webhooks" message="Register a webhook subscription to receive events." icon="⚡" />}
      />

      <NewWebhookModal open={showNew} onClose={() => setShowNew(false)} />
      <EmitEventModal open={showEmit} onClose={() => setShowEmit(false)} />
      <DeliveriesModal subscription={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function DisableCell({ sub }: { sub: Subscription }) {
  const toast = useToast();
  const disable = useDisableWebhook();

  const onDisable = async () => {
    try {
      await disable.mutateAsync(sub.id);
      toast.success('Webhook disabled');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not disable the webhook.');
    }
  };

  return <Button size="sm" variant="danger" loading={disable.isPending} onClick={onDisable}>Disable</Button>;
}

function NewWebhookModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateWebhook();

  const [url, setUrl] = useState('');
  const [eventTypes, setEventTypes] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setUrl(''); setEventTypes(''); setSecret(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const types = eventTypes.split(',').map((t) => t.trim()).filter(Boolean);
    if (!url.trim()) { setError('Enter an endpoint URL.'); return; }
    if (!types.length) { setError('Enter at least one event type.'); return; }
    try {
      await create.mutateAsync({ url: url.trim(), eventTypes: types, secret: secret.trim() || undefined });
      toast.success('Webhook registered');
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not register the webhook.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New webhook"
      description="Deliver events to an external endpoint. Event types are comma-separated."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!url.trim() || !eventTypes.trim()}>Register</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Endpoint URL" required>
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/rios" />
        </FormField>
        <FormField label="Event types" required hint="Comma-separated, e.g. claim.created, treaty.bound">
          <Input value={eventTypes} onChange={(e) => setEventTypes(e.target.value)} placeholder="claim.created, treaty.bound" />
        </FormField>
        <FormField label="Secret" hint="Optional signing secret for HMAC verification">
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Optional" />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function EmitEventModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const emit = useEmitEvent();

  const [eventType, setEventType] = useState('');
  const [payload, setPayload] = useState('');
  const [enqueued, setEnqueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setEventType(''); setPayload(''); setEnqueued(null); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEnqueued(null);
    if (!eventType.trim()) { setError('Enter an event type.'); return; }
    let parsed: unknown = undefined;
    if (payload.trim()) {
      try { parsed = JSON.parse(payload); }
      catch { setError('Payload must be valid JSON.'); return; }
    }
    try {
      const res = await emit.mutateAsync({ eventType: eventType.trim(), payload: parsed });
      setEnqueued(res.enqueued);
      toast.success(`Event enqueued to ${res.enqueued} subscription${res.enqueued === 1 ? '' : 's'}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not emit the event.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Emit test event"
      description="Dispatch a test event to matching subscriptions."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Close</Button>
          <Button variant="primary" onClick={submit} loading={emit.isPending} disabled={!eventType.trim()}>Emit</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Event type" required>
          <Input value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="claim.created" />
        </FormField>
        <FormField label="Payload (JSON)" hint="Optional JSON object">
          <Textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={5} placeholder='{ "id": "abc" }' className={styles.mono} />
        </FormField>
        {enqueued != null && (
          <div className={styles.result}>Enqueued to <strong>{enqueued}</strong> subscription{enqueued === 1 ? '' : 's'}.</div>
        )}
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function DeliveriesModal({ subscription, onClose }: { subscription: Subscription | null; onClose: () => void }) {
  const { data, isLoading } = useDeliveries(subscription?.id ?? null);

  const columns: Column<Delivery>[] = [
    { key: 'event', header: 'Event', sortValue: (d) => d.event_type, render: (d) => <span className={shared.cellMain}>{d.event_type}</span> },
    { key: 'status', header: 'Status', sortValue: (d) => d.status, render: (d) => <StatusPill status={d.status} /> },
    { key: 'attempts', header: 'Attempts', align: 'right', sortValue: (d) => d.attempts, render: (d) => d.attempts },
    { key: 'created', header: 'Created', sortValue: (d) => d.created_at, render: (d) => formatDateTime(d.created_at) },
  ];

  return (
    <Modal
      open={!!subscription}
      onClose={onClose}
      title="Deliveries"
      description={subscription?.url}
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <Table
        columns={columns}
        rows={data?.deliveries}
        loading={isLoading}
        rowKey={(d) => d.id}
        skeletonRows={4}
        empty={<EmptyState title="No deliveries" message="No events have been delivered to this subscription yet." icon="⚡" />}
      />
    </Modal>
  );
}

/* ---------------- Data tab ---------------- */
function DataTab() {
  return (
    <div className={styles.tabBody}>
      <div className={styles.panelGrid}>
        <ExportPanel />
        <ImportPanel />
      </div>
    </div>
  );
}

function ExportPanel() {
  const toast = useToast();
  const exportMut = useExport();
  const [entity, setEntity] = useState('parties');
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);

  const runExport = async () => {
    setRows(null);
    if (format === 'csv') {
      try {
        const res = await fetch(`/api/integration/export?entity=${encodeURIComponent(entity)}&format=csv`, {
          headers: { Accept: 'text/csv', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        });
        if (!res.ok) throw new ApiError(res.status, res.statusText);
        const text = await res.text();
        const blob = new Blob([text], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${entity}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success(`Exported ${entity} as CSV`);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not export the data.');
      }
      return;
    }
    try {
      const res = await exportMut.mutateAsync(entity);
      setRows(res.rows);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not export the data.');
    }
  };

  return (
    <Card>
      <CardHeader title="Export" subtitle="Download a snapshot of an entity as JSON or CSV." />
      <div className={styles.panel}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Entity">
            <Select value={entity} onChange={(e) => { setEntity(e.target.value); setRows(null); }}>
              {ENTITIES.map((en) => <option key={en} value={en}>{titleCase(en)}</option>)}
            </Select>
          </FormField>
          <FormField label="Format">
            <Select value={format} onChange={(e) => setFormat(e.target.value as 'json' | 'csv')}>
              <option value="json">JSON (preview)</option>
              <option value="csv">CSV (download)</option>
            </Select>
          </FormField>
        </div>
        <div className={styles.panelActions}>
          <Button variant="primary" loading={exportMut.isPending} onClick={runExport}>Export</Button>
          {format === 'json' && rows && <span className={shared.cellSub}>{rows.length} row{rows.length === 1 ? '' : 's'}</span>}
        </div>
        {format === 'json' && rows && (
          rows.length
            ? <pre className={styles.mono}>{JSON.stringify(rows, null, 2)}</pre>
            : <EmptyState title="No rows" message="This entity has no exportable rows." />
        )}
      </div>
    </Card>
  );
}

function ImportPanel() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('integration:write');
  const toast = useToast();
  const importMut = useImport();

  const [entity, setEntity] = useState('parties');
  const [rowsText, setRowsText] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runImport = async () => {
    setError(null);
    setResult(null);
    let parsed: unknown;
    try { parsed = JSON.parse(rowsText); }
    catch { setError('Rows must be a valid JSON array.'); return; }
    if (!Array.isArray(parsed)) { setError('Rows must be a JSON array of objects.'); return; }
    try {
      const res = await importMut.mutateAsync({ entity, rows: parsed as Record<string, unknown>[] });
      setResult(res);
      toast.success(`Imported ${res.accepted} row${res.accepted === 1 ? '' : 's'}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import the data.');
    }
  };

  return (
    <Card>
      <CardHeader title="Import" subtitle="Validate and import a JSON array of rows." />
      <div className={styles.panel}>
        <FormField label="Entity">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} disabled={!canWrite}>
            {ENTITIES.map((en) => <option key={en} value={en}>{titleCase(en)}</option>)}
          </Select>
        </FormField>
        <FormField label="Rows (JSON array)">
          <Textarea
            value={rowsText}
            onChange={(e) => setRowsText(e.target.value)}
            rows={8}
            className={styles.mono}
            placeholder='[ { "legalName": "Acme Re" } ]'
            disabled={!canWrite}
          />
        </FormField>
        <div className={styles.panelActions}>
          <Button variant="primary" loading={importMut.isPending} disabled={!canWrite || !rowsText.trim()} onClick={runImport}>
            Validate &amp; import
          </Button>
          {!canWrite && <span className={shared.cellSub}>Requires integration:write.</span>}
        </div>
        {result && (
          <div className={styles.result}>
            <div>
              <Badge color="green">{result.accepted} accepted</Badge>{' '}
              <Badge color={result.rejected.length ? 'red' : 'slate'}>{result.rejected.length} rejected</Badge>
            </div>
            {result.rejected.length > 0 && (
              <ul className={styles.resultErrors}>
                {result.rejected.map((r) => (
                  <li key={r.index}>Row {r.index}: {r.errors.join('; ')}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </div>
    </Card>
  );
}
