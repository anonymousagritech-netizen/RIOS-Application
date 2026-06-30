/**
 * Performance management (brief §14). Lists employee review cycles with their
 * weighted overall rating (computed server-side by the pure engine) and opens a
 * review to show its goals, scores and weights. Read-only view; authoring is
 * gated on hr:write elsewhere.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { PageLoader } from '../components/Feedback';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';

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
      <PageHeader title="Performance" description="Review cycles with weighted goal scoring - the overall rating reconciles with its goals." />
      <Card>
        <CardHeader title="Reviews" />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table columns={cols} rows={q.data?.reviews} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r)}
            empty={<EmptyState title="No reviews" message="No performance reviews recorded." />} />
        </div>
      </Card>

      {open && (
        <Card>
          <CardHeader
            title={`${open.employeeName} - ${open.period}`}
            subtitle={open.summary ?? undefined}
            actions={open.band ? <Badge color={BAND_COLOR[open.band] ?? 'slate'}>{titleCase(open.band)} · {Number(open.overallScore).toFixed(2)}</Badge> : undefined}
          />
          <div style={{ padding: 'var(--space-4)' }}>
            <Table
              columns={[
                { key: 'goal', header: 'Goal', render: (g: Goal) => <span className={shared.cellMain}>{g.title ?? '-'}</span> },
                { key: 'weight', header: 'Weight', align: 'right', render: (g: Goal) => String(g.weight) },
                { key: 'score', header: 'Score', align: 'right', render: (g: Goal) => `${g.score} / 5` },
              ]}
              rows={open.goals ?? []}
              rowKey={(g) => g.title ?? String(g.weight)}
              empty={<EmptyState title="No goals" message="This review has no goals." />}
            />
          </div>
        </Card>
      )}
    </>
  );
}
