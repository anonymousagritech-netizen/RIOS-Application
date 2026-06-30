import { useNavigate } from 'react-router-dom';
import { useDashboard, useStatusColors } from '../lib/queries';
import { PageHeader } from '../components/PageHeader';
import { KpiCard } from '../components/KpiCard';
import { Card, CardHeader } from '../components/Card';
import { BarChart } from '../components/BarChart';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { ErrorState } from '../components/Feedback';
import { formatMoneyCompact, formatNumber } from '../lib/format';
import type { DashboardSummary } from '../lib/types';
import shared from './shared.module.css';

type RecentTreaty = DashboardSummary['recentTreaties'][number];

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useDashboard();
  const statusColors = useStatusColors('contract_status');
  const k = data?.kpis;

  const columns: Column<RecentTreaty>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (r) => <span className={shared.cellRef}>{r.reference}</span>,
    },
    {
      key: 'name',
      header: 'Treaty',
      render: (r) => <span className={shared.cellMain}>{r.name}</span>,
    },
    {
      key: 'currency',
      header: 'Currency',
      render: (r) => r.currency,
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (r) => <StatusPill status={r.status} metaColors={statusColors} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Executive overview"
        description="Portfolio health at a glance — treaty volumes, premium and claims exposure."
      />

      {isError ? (
        <Card><ErrorState message="Could not load the dashboard summary." /></Card>
      ) : (
        <>
          <div className={shared.kpiGrid}>
            <KpiCard label="Treaties" value={formatNumber(k?.treaties)} loading={isLoading} icon="▤" />
            <KpiCard label="Active treaties" value={formatNumber(k?.activeTreaties)} loading={isLoading} icon="●" accent="var(--c-green)" />
            <KpiCard label="Parties" value={formatNumber(k?.parties)} loading={isLoading} icon="◎" />
            <KpiCard label="Open claims" value={formatNumber(k?.openClaims)} loading={isLoading} icon="◬" accent="var(--c-amber)" />
            <KpiCard
              label="Gross written premium"
              value={k ? formatMoneyCompact(k.gwpMinor, k.currency) : '—'}
              hint={k?.currency}
              loading={isLoading}
              icon="$"
            />
            <KpiCard
              label="Outstanding reserves"
              value={k ? formatMoneyCompact(k.outstandingMinor, k.currency) : '—'}
              hint={k?.currency}
              loading={isLoading}
              icon="◷"
              accent="var(--c-rose)"
            />
          </div>

          <div className={shared.cols}>
            <Card>
              <CardHeader title="Recent treaties" subtitle="Latest activity across the book" />
              <Table
                columns={columns}
                rows={data?.recentTreaties}
                loading={isLoading}
                rowKey={(r) => r.reference}
                onRowClick={() => navigate('/treaties')}
                empty={<EmptyState title="No treaties yet" message="New treaties will appear here." />}
                skeletonRows={5}
              />
            </Card>

            <Card>
              <CardHeader title="Treaties by status" subtitle="Distribution across the lifecycle" />
              {isLoading ? (
                <div className={shared.cellSub}>Loading…</div>
              ) : (
                <BarChart
                  data={(data?.treatiesByStatus ?? []).map((s) => ({
                    label: s.status,
                    value: s.n,
                    status: s.status,
                  }))}
                  metaColors={statusColors}
                />
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
