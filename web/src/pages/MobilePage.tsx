/**
 * Mobile portal (brief §9.11). A condensed, touch-first home that consumes the
 * mobile projection endpoint - the same auth/RLS, a smaller payload.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { EmptyState } from '../components/Table';
import { PageLoader } from '../components/Feedback';
import { formatNumber, formatDate, titleCase } from '../lib/format';
import { Smartphone, Activity } from 'lucide-react';
import shared from './shared.module.css';
import styles from './MobilePage.module.css';

interface Home { tiles: { label: string; value: number }[]; recent: { type: string; label: string; when: string }[] }

const ACCENTS = ['var(--primary)', 'var(--accent-violet)', 'var(--accent-cyan)', 'var(--accent-emerald)', 'var(--accent-orange)'];

export function MobilePage() {
  const q = useQuery({ queryKey: ['mobile-home'], queryFn: () => api<Home>('/api/mobile/home') });
  if (q.isLoading) return <PageLoader label="Loading…" />;

  const recent = q.data?.recent ?? [];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Mobile home' }]}
        title="Mobile home"
        description="A condensed, touch-first projection for on-the-go access."
      />

      <div className={styles.kpiGrid}>
        {q.data?.tiles.map((t, i) => (
          <KpiCard
            key={t.label}
            label={t.label}
            value={formatNumber(t.value)}
            icon={<Smartphone size={20} />}
            accent={ACCENTS[i % ACCENTS.length]}
          />
        ))}
      </div>

      <Card padded={false}>
        <CardHeader title="Recent activity" subtitle="The latest items surfaced for this account." />
        <div style={{ padding: '0 var(--space-5) var(--space-4)' }}>
          {recent.length === 0 ? (
            <EmptyState title="Nothing recent" message="No recent activity to show." icon={<Activity size={16} />} />
          ) : (
            <div className={styles.recentList}>
              {recent.map((r, i) => (
                <div key={i} className={styles.recentRow}>
                  <span className={styles.recentIcon} aria-hidden><Activity size={16} /></span>
                  <span className={`${styles.recentMain} ${shared.cellMain}`}>{r.label}</span>
                  <span className={styles.recentMeta}>
                    <span className={shared.cellSub}>{titleCase(r.type)} · {formatDate(r.when)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
