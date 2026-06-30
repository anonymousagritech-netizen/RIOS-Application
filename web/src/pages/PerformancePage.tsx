/**
 * Performance management (brief §14). Lists employee review cycles with their
 * weighted overall rating (computed server-side by the pure engine) and opens a
 * review to show its goals, scores and weights. Read-only view; authoring is
 * gated on hr:write elsewhere.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Target, Users, Award, Gauge } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { PageLoader } from '../components/Feedback';
import { formatNumber, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './PerformancePage.module.css';

interface Goal { title?: string; weight: number; score: number }
interface Review {
  id: string; employeeId: string; employeeName: string; position?: string | null;
  period: string; status: string; overallScore: number | string; band?: string | null; summary?: string | null; goals: Goal[];
}

const BAND_COLOR: Record<string, 'red' | 'amber' | 'blue' | 'green'> = { below: 'red', developing: 'amber', meets: 'blue', exceeds: 'green' };
const STATUS_COLOR: Record<string, 'slate' | 'amber' | 'green'> = { draft: 'slate', in_review: 'amber', finalised: 'green' };

export function PerformancePage() {
  const q = useQuery({ queryKey: ['performance-reviews'], queryFn: () => api<{ reviews: Review[] }>('/api/performance/reviews') });
  const [open, setOpen] = useState<Review | null>(null);

  if (q.isLoading) return <PageLoader label="Loading reviews…" />;

  const reviews = q.data?.reviews ?? [];
  const finalised = reviews.filter((r) => r.status === 'finalised').length;
  const exceeding = reviews.filter((r) => r.band === 'exceeds').length;
  const avgScore = reviews.length
    ? reviews.reduce((acc, r) => acc + Number(r.overallScore), 0) / reviews.length
    : 0;

  const cols: Column<Review>[] = [
    { key: 'name', header: 'Employee', render: (r) => <span className={shared.cellMain}>{r.employeeName}</span> },
    { key: 'pos', header: 'Position', render: (r) => <span className={shared.cellSub}>{r.position ?? '-'}</span> },
    { key: 'period', header: 'Period', render: (r) => r.period },
    { key: 'score', header: 'Overall', align: 'right', render: (r) => <strong>{Number(r.overallScore).toFixed(2)}</strong> },
    { key: 'band', header: 'Band', render: (r) => r.band ? <Badge color={BAND_COLOR[r.band] ?? 'slate'}>{titleCase(r.band)}</Badge> : '-' },
    { key: 'status', header: 'Status', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'slate'}>{titleCase(r.status.replace('_', ' '))}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Performance"
        description="Review cycles with weighted goal scoring - the overall rating reconciles with its goals."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Performance' }]}
      />

      <div className={styles.page}>
        <div className={styles.kpis}>
          <KpiCard label="Review cycles" value={formatNumber(reviews.length)} hint="Across the workforce" icon={<Users size={20} />} accent="var(--primary)" />
          <KpiCard label="Finalised" value={formatNumber(finalised)} hint="Reviews signed off" icon={<Award size={20} />} accent="var(--accent-violet)" />
          <KpiCard label="Average rating" value={avgScore.toFixed(2)} hint="Weighted overall score" icon={<Gauge size={20} />} accent="var(--accent-cyan)" />
          <KpiCard label="Exceeds band" value={formatNumber(exceeding)} hint="Top performers" icon={<Target size={20} />} accent="var(--accent-emerald)" />
        </div>

        <Card padded={false}>
          <div className={styles.cardHead}>
            <CardHeader title="Reviews" subtitle="Select a review to inspect its goals, weights and scores." />
          </div>
          <Table columns={cols} rows={q.data?.reviews} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r)}
            empty={<EmptyState title="No reviews" message="No performance reviews recorded." icon={<Award size={28} />} />} />
        </Card>

        {open && (
          <Card padded={false}>
            <div className={styles.cardHead}>
              <CardHeader
                title={`${open.employeeName} · ${open.period}`}
                subtitle={open.summary ?? open.position ?? undefined}
                actions={open.band ? <Badge color={BAND_COLOR[open.band] ?? 'slate'}>{titleCase(open.band)} · {Number(open.overallScore).toFixed(2)}</Badge> : undefined}
              />
            </div>
            <div className={styles.goals}>
              {(open.goals ?? []).length === 0 ? (
                <EmptyState title="No goals" message="This review has no goals." icon={<Target size={28} />} />
              ) : (
                (open.goals ?? []).map((g, i) => {
                  const pct = Math.max(0, Math.min(100, (Number(g.score) / 5) * 100));
                  return (
                    <div key={g.title ?? `${i}-${g.weight}`} className={styles.goal}>
                      <div className={styles.goalTop}>
                        <span className={styles.goalTitle}>{g.title ?? 'Untitled goal'}</span>
                        <span className={styles.goalMeta}>
                          <span className={styles.goalWeight}>Weight {g.weight}</span>
                          <span className={styles.goalScore}>{g.score} / 5</span>
                        </span>
                      </div>
                      <div className={styles.progressTrack} role="progressbar" aria-valuenow={Number(g.score)} aria-valuemin={0} aria-valuemax={5}>
                        <span className={styles.progressFill} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
