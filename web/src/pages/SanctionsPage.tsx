/**
 * Sanctions screening (brief §12). Loads the denylist from the bundled sample
 * feed provider (the labelled seam for a live OFAC/EU/UN/OFSI feed), shows the
 * current list and last refresh, and re-screens the whole party book against it.
 * Refresh / screen-all need party:write.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Button } from '../components/Button';
import { PageLoader } from '../components/Feedback';
import { formatDate } from '../lib/format';
import { ShieldAlert, RefreshCw, ScanLine } from 'lucide-react';

interface Entry { id: string; listSource: string; fullName: string; alias?: string | null; country?: string | null; note?: string | null }
interface Refresh { source: string; provider: string; entryCount: number; refreshedAt: string }
interface Count { source: string; count: number }

export function SanctionsPage() {
  const { hasPermission } = useAuth();
  const qc = useQueryClient();
  const canWrite = hasPermission('party:write');

  const listQ = useQuery({ queryKey: ['sanctions', 'list'], queryFn: () => api<{ entries: Entry[] }>('/api/sanctions/list') });
  const statusQ = useQuery({ queryKey: ['sanctions', 'status'], queryFn: () => api<{ refreshes: Refresh[]; counts: Count[]; provider: string; defaultSource: string }>('/api/sanctions/status') });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['sanctions'] });
  const refresh = useMutation({ mutationFn: () => api('/api/sanctions/refresh', { method: 'POST' }), onSuccess: invalidate });
  const screenAll = useMutation({ mutationFn: () => api<{ screened: number; blocked: number; potential: number; clear: number }>('/api/sanctions/screen-all', { method: 'POST' }), onSuccess: invalidate });

  if (listQ.isLoading) return <PageLoader />;
  const entries = listQ.data?.entries ?? [];
  const lastRefresh = statusQ.data?.refreshes?.[0];
  const totalEntries = (statusQ.data?.counts ?? []).reduce((a, c) => a + c.count, 0);
  const screen = screenAll.data;

  const columns: Column<Entry>[] = [
    { key: 'listSource', header: 'List', render: (e) => e.listSource },
    { key: 'fullName', header: 'Name', render: (e) => e.fullName },
    { key: 'alias', header: 'Alias', render: (e) => e.alias ?? '—' },
    { key: 'country', header: 'Country', render: (e) => e.country ?? '—' },
    { key: 'note', header: 'Note', render: (e) => e.note ?? '—' },
  ];

  return (
    <>
      <PageHeader
        title="Sanctions Screening"
        description="Denylist loaded from a sanctions feed provider, and party-book screening against it."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Sanctions' }]}
        actions={canWrite ? (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending} icon={<RefreshCw size={15} />}>Refresh feed</Button>
            <Button onClick={() => screenAll.mutate()} disabled={screenAll.isPending} icon={<ScanLine size={15} />}>Screen all parties</Button>
          </span>
        ) : undefined}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        <KpiCard label="Denylist entries" value={String(totalEntries)} icon={<ShieldAlert size={18} />} />
        <KpiCard label="Feed provider" value={statusQ.data?.provider ?? 'BUNDLED'} icon={<RefreshCw size={18} />} />
        <KpiCard label="Last refresh" value={lastRefresh ? formatDate(lastRefresh.refreshedAt) : '—'} icon={<RefreshCw size={18} />} />
        {screen && <KpiCard label="Screened / blocked" value={`${screen.screened} / ${screen.blocked}`} accent={screen.blocked ? 'var(--color-danger, #c0392b)' : undefined} icon={<ScanLine size={18} />} />}
      </div>

      {screen && (
        <Card style={{ marginBottom: 'var(--space-5)' }}>
          <CardHeader title="Last screening run" subtitle="Party book screened against the current denylist" />
          <p>{screen.screened} parties screened — <strong>{screen.blocked}</strong> blocked, {screen.potential} potential match, {screen.clear} clear.</p>
        </Card>
      )}

      <Card padded={false}>
        <CardHeader title="Denylist" subtitle="Current sanctions list entries" />
        {entries.length === 0
          ? <EmptyState title="Denylist is empty" message={canWrite ? 'Refresh the feed to load entries.' : 'No sanctions list entries loaded.'} />
          : <Table columns={columns} rows={entries} rowKey={(e) => e.id} />}
      </Card>
    </>
  );
}
