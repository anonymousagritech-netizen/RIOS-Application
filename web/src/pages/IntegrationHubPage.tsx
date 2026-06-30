/**
 * Integration hub (brief §12, §3): the connector registry, the event-bus outbox,
 * and developer-portal API keys. The outbox/relay/registry mechanics are real;
 * the production sinks (Kafka, live connector handshakes) are provider-wired.
 */

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge, StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { KpiCard } from '../components/KpiCard';
import { PageLoader } from '../components/Feedback';
import { formatDateTime, titleCase } from '../lib/format';
import { Plug, Radio, KeyRound, Webhook } from 'lucide-react';
import shared from './shared.module.css';
import styles from './IntegrationHubPage.module.css';

export function IntegrationHubPage() {
  const [tab, setTab] = useState('connectors');
  return (
    <>
      <PageHeader
        title="Integration hub"
        description="Connectors, the event-bus outbox, and developer API keys."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Integration hub' }]}
      />
      <Card padded={false}>
        <div style={{ padding: '0 var(--space-4)' }}>
          <Tabs tabs={[{ id: 'connectors', label: 'Connectors' }, { id: 'events', label: 'Event bus' }, { id: 'keys', label: 'API keys' }]} active={tab} onChange={setTab} />
        </div>
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

const CONNECTOR_ACCENTS = ['var(--primary)', 'var(--accent-violet)', 'var(--accent-cyan)', 'var(--accent-emerald)', 'var(--accent-orange)', 'var(--accent-indigo)'];

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

  const connectors = q.data?.connectors ?? [];
  const enabledCount = connectors.filter((c) => c.enabled).length;
  const okCount = connectors.filter((c) => c.lastStatus === 'ok').length;

  if (connectors.length === 0) {
    return <Card><EmptyState title="No connectors" message="No connectors registered." icon={<Plug size={16} />} /></Card>;
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <div className={shared.kpiGrid}>
        <KpiCard label="Connectors" value={String(connectors.length)} hint="Registered in this tenant" icon={<Plug size={18} />} accent="var(--primary)" />
        <KpiCard label="Enabled" value={String(enabledCount)} hint="Active connectors" icon={<Radio size={18} />} accent="var(--accent-emerald)" />
        <KpiCard label="Healthy" value={String(okCount)} hint="Last test passed" icon={<Webhook size={18} />} accent="var(--accent-cyan)" />
      </div>
      <div className={styles.grid}>
        {connectors.map((c, i) => (
          <Card key={c.id} padded={false} className={styles.tile} style={{ '--tile-accent': CONNECTOR_ACCENTS[i % CONNECTOR_ACCENTS.length] } as CSSProperties}>
            <div className={styles.head}>
              <span className={styles.icon} aria-hidden><Plug size={20} /></span>
              <div className={styles.headText}>
                <span className={styles.name}>{c.name}</span>
                <span className={styles.key}>{c.key}</span>
              </div>
              <Badge color="violet">{c.kind.toUpperCase()}</Badge>
            </div>
            <div className={styles.chips}>
              <Badge color={c.enabled ? 'green' : 'gray'}>{c.enabled ? 'Enabled' : 'Disabled'}</Badge>
              {c.lastStatus
                ? <Badge color={c.lastStatus === 'ok' ? 'green' : 'red'}>Last test: {c.lastStatus}</Badge>
                : <Badge color="slate">Not tested</Badge>}
            </div>
            <div className={styles.foot}>
              <span className={shared.cellSub}>Connector</span>
              <Button variant="secondary" size="sm" onClick={() => test.mutate(c.id)} loading={test.isPending && test.variables === c.id}>Test connection</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
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

  const events = q.data?.events ?? [];
  const pending = q.data?.pending ?? 0;
  const published = events.filter((e) => e.status === 'published').length;

  const cols: Column<Event>[] = [
    { key: 'type', header: 'Event', render: (e) => <span className={shared.cellMain}>{e.eventType}</span> },
    { key: 'agg', header: 'Aggregate', render: (e) => e.aggregateType ?? '-' },
    { key: 'status', header: 'Status', render: (e) => <StatusPill status={e.status === 'published' ? 'PUBLISHED' : 'PENDING'} label={titleCase(e.status)} metaColors={{ PUBLISHED: 'green', PENDING: 'amber' }} /> },
    { key: 'pub', header: 'Published', render: (e) => e.publishedAt ? formatDateTime(e.publishedAt) : '-' },
  ];
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <div className={shared.kpiGrid}>
        <KpiCard label="Pending" value={String(pending)} hint="Awaiting relay in the outbox" icon={<Radio size={18} />} accent="var(--accent-orange)" />
        <KpiCard label="Published" value={String(published)} hint="Delivered domain events" icon={<Webhook size={18} />} accent="var(--accent-emerald)" />
        <KpiCard label="Total" value={String(events.length)} hint="Events in the outbox" icon={<Plug size={18} />} accent="var(--primary)" />
      </div>
      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5)' }} className={styles.outboxBar}>
          <CardHeader title="Event outbox" subtitle={`${pending} pending domain event${pending === 1 ? '' : 's'} awaiting relay.`} />
          <Button variant="primary" onClick={() => relay.mutate()} loading={relay.isPending} disabled={!pending}>Relay pending</Button>
        </div>
        <Table columns={cols} rows={events} rowKey={(e) => e.id} empty={<EmptyState title="No events" message="No domain events in the outbox." icon={<Radio size={16} />} />} />
      </Card>
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
    { key: 'status', header: 'Status', render: (k) => <StatusPill status={k.revokedAt ? 'REVOKED' : 'ACTIVE'} label={k.revokedAt ? 'Revoked' : 'Active'} metaColors={{ ACTIVE: 'green', REVOKED: 'slate' }} /> },
    { key: 'act', header: '', align: 'right', render: (k) => canManage && !k.revokedAt ? <Button variant="ghost" onClick={() => revoke.mutate(k.id)} loading={revoke.isPending && revoke.variables === k.id}>Revoke</Button> : null },
  ];
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5)' }} className={styles.outboxBar}>
          <CardHeader title="Developer API keys" subtitle="Issue and revoke keys for programmatic access." />
          {canManage && <Button variant="primary" icon={<KeyRound size={16} />} onClick={() => issue.mutate()} loading={issue.isPending}>Issue API key</Button>}
        </div>
        {newKey && (
          <div style={{ padding: '0 var(--space-5) var(--space-4)' }}>
            <span className={styles.newKey}>Copy now — shown once: {newKey}</span>
          </div>
        )}
        <Table columns={cols} rows={q.data?.keys} rowKey={(k) => k.id} empty={<EmptyState title="No keys" message="No API keys issued." icon={<KeyRound size={16} />} />} />
      </Card>
      <Card>
        <CardHeader title="API catalog" subtitle="The stable public endpoints." />
        <div className={styles.catalogList} style={{ marginTop: 'var(--space-4)' }}>
          {catalog.data?.catalog.map((g) => (
            <div key={g.group} className={styles.catalogGroup}>
              <div className={shared.cellMain}>{g.group}</div>
              {g.endpoints.map((e) => <div key={e} className={shared.cellRef}>{e}</div>)}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
