/**
 * Feature & license management (brief §9.1). Lists capability flags with their
 * plan tier and seat limit; holders of platform:write can toggle them.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageLoader } from '../components/Feedback';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Feature { id: string; key: string; name: string; enabled: boolean; seatLimit?: number | null; plan?: string | null }

export function FeaturesPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = hasPermission('platform:write');
  const q = useQuery({ queryKey: ['features'], queryFn: () => api<{ features: Feature[] }>('/api/platform/features') });

  const toggle = useMutation({
    mutationFn: (f: Feature) => api('/api/platform/features', { body: { key: f.key, name: f.name, enabled: !f.enabled, seatLimit: f.seatLimit ?? null, plan: f.plan ?? null } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['features'] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update flag'),
  });

  if (q.isLoading) return <PageLoader label="Loading features…" />;

  const cols: Column<Feature>[] = [
    { key: 'key', header: 'Key', render: (f) => <span className={shared.cellRef}>{f.key}</span> },
    { key: 'name', header: 'Feature', render: (f) => <span className={shared.cellMain}>{f.name}</span> },
    { key: 'plan', header: 'Plan', render: (f) => f.plan ? <Badge color="violet">{titleCase(f.plan)}</Badge> : '—' },
    { key: 'seats', header: 'Seats', align: 'right', render: (f) => f.seatLimit != null ? String(f.seatLimit) : 'Unlimited' },
    { key: 'enabled', header: 'Status', render: (f) => <Badge color={f.enabled ? 'green' : 'gray'}>{f.enabled ? 'Enabled' : 'Disabled'}</Badge> },
    {
      key: 'act', header: '', align: 'right',
      render: (f) => canWrite ? <Button variant="ghost" onClick={() => toggle.mutate(f)} loading={toggle.isPending}>{f.enabled ? 'Disable' : 'Enable'}</Button> : null,
    },
  ];

  return (
    <>
      <PageHeader title="Features & licenses" description="Gate optional capability per tenant by plan and seat allowance." />
      <Card>
        <CardHeader title="Feature flags" />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table columns={cols} rows={q.data?.features} rowKey={(f) => f.id}
            empty={<EmptyState title="No features" message="No feature flags configured." />} />
        </div>
      </Card>
    </>
  );
}
