/**
 * Integration hub (brief §12, §3): the connector registry, the event-bus outbox,
 * and developer-portal API keys. The outbox/relay/registry mechanics are real;
 * the production sinks (Kafka, live connector handshakes) are provider-wired.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { PageLoader } from '../components/Feedback';
import { formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';

export function IntegrationHubPage() {
  const [tab, setTab] = useState('connectors');
  return (
    <>
      <PageHeader title="Integration hub" description="Connectors, the event-bus outbox, and developer API keys." />
      <Card>
        <Tabs tabs={[{ id: 'connectors', label: 'Connectors' }, { id: 'events', label: 'Event bus' }, { id: 'keys', label: 'API keys' }]} active={tab} onChange={setTab} />
        <div style={{ padding: 'var(--space-5)' }}>
          {tab === 'connectors' && <Connectors />}
          {tab === 'events' && <EventBus />}
          {tab === 'keys' && <ApiKeys />}
        </div>
      </Card>
    </>
  );
}

interface Connector { id: string; key: string; name: string; kind: string; config: Record<string, unknown>; enabled: boolean; lastStatus?: string | null }

function Connectors() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['connectors'], queryFn: () => api<{ connectors: Connector[] }>('/api/connectors') });
  const test = useMutation({
    mutationFn: (id: string) => api<{ status: string }>(`/api/connectors/${id}/test`, { body: {} }),
    onSuccess: (r) => { toast.success(`Test: ${r.status}`); qc.invalidateQueries({ queryKey: ['connectors'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Test failed'),
  });
  if (q.isLoading) return <PageLoader label="Loading connectors…" />;
  const cols: Column<Connector>[] = [
    { key: 'key', header: 'Key', render: (c) => <span className={shared.cellRef}>{c.key}</span> },
    { key: 'name', header: 'Connector', render: (c) => <span className={shared.cellMain}>{c.name}</span> },
    { key: 'kind', header: 'Kind', render: (c) => <Badge color="violet">{c.kind.toUpperCase()}</Badge> },
    { key: 'status', header: 'Last test', render: (c) => c.lastStatus ? <Badge color={c.lastStatus === 'ok' ? 'green' : 'red'}>{c.lastStatus}</Badge> : '-' },
    { key: 'enabled', header: 'Enabled', render: (c) => <Badge color={c.enabled ? 'green' : 'gray'}>{c.enabled ? 'On' : 'Off'}</Badge> },
    { key: 'act', header: '', align: 'right', render: (c) => <Button variant="ghost" onClick={() => test.mutate(c.id)} loading={test.isPending}>Test</Button> },
  ];
  return <Table columns={cols} rows={q.data?.connectors} rowKey={(c) => c.id} empty={<EmptyState title="No connectors" message="No connectors registered." />} />;
}

interface Event { id: string; eventType: string; aggregateType?: string | null; status: string; createdAt: string; publishedAt?: string | null }

function EventBus() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['events'], queryFn: () => api<{ events: Event[]; pending: number }>('/api/events') });
  const relay = useMutation({
    mutationFn: () => api<{ published: number }>('/api/events/relay', { body: {} }),
    onSuccess: (r) => { toast.success(`Published ${r.published}`); qc.invalidateQueries({ queryKey: ['events'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Relay failed'),
  });
  if (q.isLoading) return <PageLoader label="Loading events…" />;
  const cols: Column<Event>[] = [
    { key: 'type', header: 'Event', render: (e) => <span className={shared.cellMain}>{e.eventType}</span> },
    { key: 'agg', header: 'Aggregate', render: (e) => e.aggregateType ?? '-' },
    { key: 'status', header: 'Status', render: (e) => <Badge color={e.status === 'published' ? 'green' : 'amber'}>{titleCase(e.status)}</Badge> },
    { key: 'pub', header: 'Published', render: (e) => e.publishedAt ? formatDateTime(e.publishedAt) : '-' },
  ];
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className={shared.cellSub}>{q.data?.pending ?? 0} pending in the outbox.</span>
        <Button variant="primary" onClick={() => relay.mutate()} loading={relay.isPending} disabled={!q.data?.pending}>Relay pending</Button>
      </div>
      <Table columns={cols} rows={q.data?.events} rowKey={(e) => e.id} empty={<EmptyState title="No events" message="No domain events in the outbox." />} />
    </div>
  );
}

interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; revokedAt?: string | null }

function ApiKeys() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canManage = hasPermission('admin:manage');
  const q = useQuery({ queryKey: ['api-keys'], queryFn: () => api<{ keys: ApiKey[] }>('/api/devportal/keys') });
  const catalog = useQuery({ queryKey: ['api-catalog'], queryFn: () => api<{ catalog: { group: string; endpoints: string[] }[] }>('/api/devportal/catalog') });
  const [newKey, setNewKey] = useState<string | null>(null);

  const issue = useMutation({
    mutationFn: () => api<{ key: string }>('/api/devportal/keys', { body: { name: `Key ${new Date().toISOString().slice(0, 10)}` } }),
    onSuccess: (r) => { setNewKey(r.key); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not issue key'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/devportal/keys/${id}/revoke`, { body: {} }),
    onSuccess: () => { toast.success('Revoked'); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not revoke'),
  });

  if (q.isLoading) return <PageLoader label="Loading keys…" />;
  const cols: Column<ApiKey>[] = [
    { key: 'name', header: 'Name', render: (k) => <span className={shared.cellMain}>{k.name}</span> },
    { key: 'prefix', header: 'Prefix', render: (k) => <span className={shared.cellRef}>{k.prefix}…</span> },
    { key: 'created', header: 'Created', render: (k) => formatDateTime(k.createdAt) },
    { key: 'status', header: 'Status', render: (k) => <Badge color={k.revokedAt ? 'gray' : 'green'}>{k.revokedAt ? 'Revoked' : 'Active'}</Badge> },
    { key: 'act', header: '', align: 'right', render: (k) => canManage && !k.revokedAt ? <Button variant="ghost" onClick={() => revoke.mutate(k.id)} loading={revoke.isPending}>Revoke</Button> : null },
  ];
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      {canManage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Button variant="primary" onClick={() => issue.mutate()} loading={issue.isPending}>Issue API key</Button>
          {newKey && <span className={shared.cellSub} style={{ fontFamily: 'var(--font-mono)' }}>Copy now - shown once: {newKey}</span>}
        </div>
      )}
      <Table columns={cols} rows={q.data?.keys} rowKey={(k) => k.id} empty={<EmptyState title="No keys" message="No API keys issued." />} />
      <Card>
        <CardHeader title="API catalog" subtitle="The stable public endpoints." />
        <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
          {catalog.data?.catalog.map((g) => (
            <div key={g.group}>
              <div className={shared.cellMain}>{g.group}</div>
              {g.endpoints.map((e) => <div key={e} className={shared.cellRef}>{e}</div>)}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
