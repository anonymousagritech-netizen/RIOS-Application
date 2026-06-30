/**
 * Mobile portal (brief §9.11). A condensed, touch-first home that consumes the
 * mobile projection endpoint - the same auth/RLS, a smaller payload.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { EmptyState } from '../components/Table';
import { PageLoader } from '../components/Feedback';
import { formatNumber, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Home { tiles: { label: string; value: number }[]; recent: { type: string; label: string; when: string }[] }

export function MobilePage() {
  const q = useQuery({ queryKey: ['mobile-home'], queryFn: () => api<Home>('/api/mobile/home') });
  if (q.isLoading) return <PageLoader label="Loading…" />;
  return (
    <>
      <PageHeader title="Mobile home" description="A condensed, touch-first view for on-the-go." />
      <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
        {q.data?.tiles.map((t) => <KpiCard key={t.label} label={t.label} value={formatNumber(t.value)} icon="◧" />)}
      </div>
      <Card>
        <div style={{ padding: 'var(--space-4)' }}>
          <h4 className={shared.cellMain} style={{ marginBottom: 'var(--space-3)' }}>Recent</h4>
          {(q.data?.recent ?? []).length === 0
            ? <EmptyState title="Nothing recent" message="No recent activity." />
            : q.data!.recent.map((r, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: 'var(--space-3) 0', borderBottom: '1px solid var(--border)' }}>
                <span className={shared.cellMain}>{r.label}</span>
                <span className={shared.cellSub}>{titleCase(r.type)} · {formatDate(r.when)}</span>
              </div>
            ))}
        </div>
      </Card>
    </>
  );
}
