/**
 * API / app marketplace (brief §26). Browse installable apps and API products and
 * manage per-tenant install state. integration:write to install/uninstall.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/Table';
import { PageLoader } from '../components/Feedback';
import shared from './shared.module.css';

interface Listing { id: string; key: string; name: string; category?: string | null; publisher?: string | null; description?: string | null; version: string; installed: boolean; enabled: boolean }

export function MarketplacePage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canInstall = hasPermission('integration:write');
  const q = useQuery({ queryKey: ['marketplace'], queryFn: () => api<{ listings: Listing[] }>('/api/marketplace/listings') });

  const install = useMutation({
    mutationFn: (key: string) => api('/api/marketplace/installs', { body: { listingKey: key } }),
    onSuccess: () => { toast.success('Installed'); qc.invalidateQueries({ queryKey: ['marketplace'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Install failed'),
  });
  const uninstall = useMutation({
    mutationFn: (key: string) => api(`/api/marketplace/installs/${key}/uninstall`, { body: {} }),
    onSuccess: () => { toast.success('Uninstalled'); qc.invalidateQueries({ queryKey: ['marketplace'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Uninstall failed'),
  });

  if (q.isLoading) return <PageLoader label="Loading marketplace…" />;

  return (
    <>
      <PageHeader title="Marketplace" description="Installable apps and API products that extend RIOS." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 'var(--space-4)' }}>
        {(q.data?.listings ?? []).map((l) => (
          <Card key={l.id}>
            <CardHeader title={l.name} subtitle={`${l.publisher ?? ''} · v${l.version}`} actions={l.category ? <Badge color="violet">{l.category}</Badge> : undefined} />
            <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
              <p className={shared.cellSub}>{l.description}</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Badge color={l.installed ? 'green' : 'slate'}>{l.installed ? 'Installed' : 'Not installed'}</Badge>
                {canInstall && (l.installed
                  ? <Button variant="ghost" onClick={() => uninstall.mutate(l.key)} loading={uninstall.isPending}>Uninstall</Button>
                  : <Button variant="primary" onClick={() => install.mutate(l.key)} loading={install.isPending}>Install</Button>)}
              </div>
            </div>
          </Card>
        ))}
        {(q.data?.listings ?? []).length === 0 && <Card><EmptyState title="Empty" message="No marketplace listings." /></Card>}
      </div>
    </>
  );
}
