/**
 * API / app marketplace (brief §26). Browse installable apps and API products and
 * manage per-tenant install state. integration:write to install/uninstall.
 */

import type { CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Badge, StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { KpiCard } from '../components/KpiCard';
import { EmptyState } from '../components/Table';
import { PageLoader } from '../components/Feedback';
import { Store, Package, CheckCircle2, Boxes } from 'lucide-react';
import shared from './shared.module.css';
import styles from './MarketplacePage.module.css';

interface Listing { id: string; key: string; name: string; category?: string | null; publisher?: string | null; description?: string | null; version: string; installed: boolean; enabled: boolean }

const TILE_ACCENTS = ['var(--primary)', 'var(--accent-violet)', 'var(--accent-cyan)', 'var(--accent-emerald)', 'var(--accent-orange)', 'var(--accent-indigo)'];

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

  const listings = q.data?.listings ?? [];
  const installedCount = listings.filter((l) => l.installed).length;
  const categories = new Set(listings.map((l) => l.category).filter(Boolean)).size;

  if (q.isLoading) return <PageLoader label="Loading marketplace…" />;

  return (
    <>
      <PageHeader
        title="Marketplace"
        description="Installable apps and API products that extend RIOS."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Marketplace' }]}
        actions={canInstall ? <Badge color="green">integration:write</Badge> : <Badge color="slate">read-only</Badge>}
      />

      <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
        <KpiCard label="Listings" value={String(listings.length)} hint="Available apps & API products" icon={<Store size={18} />} accent="var(--primary)" />
        <KpiCard label="Installed" value={String(installedCount)} hint="Active in this tenant" icon={<CheckCircle2 size={18} />} accent="var(--accent-emerald)" />
        <KpiCard label="Categories" value={String(categories)} hint="Distinct product areas" icon={<Boxes size={18} />} accent="var(--accent-violet)" />
      </div>

      {listings.length === 0 ? (
        <Card><EmptyState title="Empty" message="No marketplace listings." icon={<Store size={16} />} /></Card>
      ) : (
        <div className={styles.grid}>
          {listings.map((l, i) => {
            const accent = TILE_ACCENTS[i % TILE_ACCENTS.length];
            return (
              <Card key={l.id} padded={false} className={styles.tile} style={{ '--tile-accent': accent } as CSSProperties}>
                <div className={styles.head}>
                  <span className={styles.icon} aria-hidden><Package size={22} /></span>
                  <div className={styles.headText}>
                    <span className={styles.name}>{l.name}</span>
                    <span className={styles.meta}>{[l.publisher, `v${l.version}`].filter(Boolean).join(' · ')}</span>
                  </div>
                  {l.category && <Badge color="violet">{l.category}</Badge>}
                </div>
                <p className={styles.desc}>{l.description}</p>
                <div className={styles.foot}>
                  <StatusPill
                    status={l.installed ? 'INSTALLED' : 'NOT_INSTALLED'}
                    label={l.installed ? 'Installed' : 'Not installed'}
                    metaColors={{ INSTALLED: 'green', NOT_INSTALLED: 'slate' }}
                  />
                  {canInstall && (l.installed
                    ? <Button variant="ghost" onClick={() => uninstall.mutate(l.key)} loading={uninstall.isPending}>Uninstall</Button>
                    : <Button variant="primary" onClick={() => install.mutate(l.key)} loading={install.isPending}>Install</Button>)}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
