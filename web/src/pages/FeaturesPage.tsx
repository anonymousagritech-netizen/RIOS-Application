/**
 * Feature & license management (brief §9.1). Lists capability flags with their
 * plan tier and seat limit; holders of platform:write can toggle them.
 */

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { KpiCard } from '../components/KpiCard';
import { PageLoader } from '../components/Feedback';
import { formatNumber, titleCase } from '../lib/format';
import { Package, ToggleRight, Users, Sparkles, Boxes } from 'lucide-react';
import shared from './shared.module.css';
import styles from './FeaturesPage.module.css';

interface Feature { id: string; key: string; name: string; enabled: boolean; seatLimit?: number | null; plan?: string | null }

const ACCENTS = ['var(--primary)', 'var(--accent-violet)', 'var(--accent-cyan)', 'var(--accent-emerald)', 'var(--accent-orange)'];

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

  const features = q.data?.features ?? [];
  const stats = useMemo(() => {
    const enabled = features.filter((f) => f.enabled).length;
    const plans = new Set(features.filter((f) => f.plan).map((f) => f.plan)).size;
    return { total: features.length, enabled, plans };
  }, [features]);

  if (q.isLoading) return <PageLoader label="Loading features…" />;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Features & licenses"
        description="Gate optional capability per tenant by plan and seat allowance."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Features & licenses' }]}
      />

      <div className={shared.kpiGrid}>
        <KpiCard label="Capabilities" value={formatNumber(stats.total)} hint="Feature flags configured" icon={<Package size={20} />} accent="var(--primary)" />
        <KpiCard label="Enabled" value={formatNumber(stats.enabled)} hint="Active for this tenant" icon={<ToggleRight size={20} />} accent="var(--accent-emerald)" />
        <KpiCard label="Plan tiers" value={formatNumber(stats.plans)} hint="Distinct licensing tiers" icon={<Sparkles size={20} />} accent="var(--accent-violet)" />
      </div>

      {features.length === 0 ? (
        <Card>
          <EmptyState title="No features" message="No feature flags configured." icon={<Boxes size={16} />} />
        </Card>
      ) : (
        <div className={styles.grid}>
          {features.map((f, i) => {
            const accent = ACCENTS[i % ACCENTS.length];
            return (
              <Card key={f.id} className={styles.featureCard}>
                <div className={styles.cardTop}>
                  <span className={styles.icon} style={{ color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` }} aria-hidden>
                    <Package size={18} />
                  </span>
                  <Badge color={f.enabled ? 'green' : 'gray'}>{f.enabled ? 'Enabled' : 'Disabled'}</Badge>
                </div>
                <div className={styles.cardBody}>
                  <h3 className={styles.featureName}>{f.name}</h3>
                  <span className={shared.cellRef}>{f.key}</span>
                </div>
                <div className={styles.meta}>
                  <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Plan</span>
                    {f.plan ? <Badge color="violet">{titleCase(f.plan)}</Badge> : <span className={styles.metaValue}>Any</span>}
                  </div>
                  <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Seats</span>
                    <span className={styles.metaValue}>
                      <Users size={13} aria-hidden /> {f.seatLimit != null ? formatNumber(f.seatLimit) : 'Unlimited'}
                    </span>
                  </div>
                </div>
                {canWrite && (
                  <div className={styles.cardFoot}>
                    <Button
                      size="sm"
                      variant={f.enabled ? 'ghost' : 'secondary'}
                      onClick={() => toggle.mutate(f)}
                      loading={toggle.isPending}
                    >
                      {f.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
