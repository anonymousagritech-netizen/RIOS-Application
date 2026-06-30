import { useNavigate } from 'react-router-dom';
import {
  FileText, CheckCircle2, Users, ShieldAlert, Wallet, PiggyBank,
  Plus, ArrowRight, BarChart3, Clock,
} from 'lucide-react';
import { useDashboard, useStatusColors } from '../lib/queries';
import { PageHeader } from '../components/PageHeader';
import { KpiCard } from '../components/KpiCard';
import { Card, CardHeader } from '../components/Card';
import { DonutChart } from '../components/DonutChart';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { ErrorState } from '../components/Feedback';
import { formatMoneyCompact, formatNumber } from '../lib/format';
import type { DashboardSummary } from '../lib/types';
import shared from './shared.module.css';

type RecentTreaty = DashboardSummary['recentTreaties'][number];

const QUICK_ACTIONS = [
  { label: 'New treaty', to: '/treaties', icon: Plus, accent: 'var(--primary)' },
  { label: 'Parties', to: '/parties', icon: Users, accent: 'var(--accent-cyan)' },
  { label: 'Claims', to: '/claims', icon: ShieldAlert, accent: 'var(--accent-orange)' },
  { label: 'Reports', to: '/reports', icon: BarChart3, accent: 'var(--accent-emerald)' },
  { label: 'Attendance', to: '/attendance', icon: Clock, accent: 'var(--accent-violet)' },
];

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
    { key: 'currency', header: 'Currency', render: (r) => r.currency },
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
        description="Portfolio health at a glance: treaty volumes, premium and claims exposure."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Dashboard' }]}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/treaties')}>
            New treaty
          </Button>
        }
      />

      {isError ? (
        <Card><ErrorState message="Could not load the dashboard summary." /></Card>
      ) : (
        <>
          <div className={shared.kpiGrid}>
            <KpiCard label="Treaties" value={formatNumber(k?.treaties)} loading={isLoading} icon={<FileText size={20} />} accent="var(--primary)" />
            <KpiCard label="Active treaties" value={formatNumber(k?.activeTreaties)} loading={isLoading} icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" />
            <KpiCard label="Parties" value={formatNumber(k?.parties)} loading={isLoading} icon={<Users size={20} />} accent="var(--accent-cyan)" />
            <KpiCard label="Open claims" value={formatNumber(k?.openClaims)} loading={isLoading} icon={<ShieldAlert size={20} />} accent="var(--accent-orange)" />
            <KpiCard
              label="Gross written premium"
              value={k ? formatMoneyCompact(k.gwpMinor, k.currency) : '-'}
              hint={k?.currency}
              loading={isLoading}
              icon={<Wallet size={20} />}
              accent="var(--accent-indigo)"
            />
            <KpiCard
              label="Outstanding reserves"
              value={k ? formatMoneyCompact(k.outstandingMinor, k.currency) : '-'}
              hint={k?.currency}
              loading={isLoading}
              icon={<PiggyBank size={20} />}
              accent="var(--accent-rose)"
            />
          </div>

          <Card padded>
            <CardHeader title="Quick actions" subtitle="Jump straight into the most common workflows" />
            <div className={shared.quickActions}>
              {QUICK_ACTIONS.map((a) => (
                <button key={a.to} className={shared.quickAction} onClick={() => navigate(a.to)}>
                  <span className={shared.quickIcon} style={{ color: a.accent }}>
                    <a.icon size={18} />
                  </span>
                  <span className={shared.quickLabel}>{a.label}</span>
                  <ArrowRight size={15} className={shared.quickArrow} />
                </button>
              ))}
            </div>
          </Card>

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
                <div className={shared.cellSub}>Loading...</div>
              ) : (
                <DonutChart
                  data={(data?.treatiesByStatus ?? []).map((s) => ({
                    label: s.status,
                    value: s.n,
                    status: s.status,
                  }))}
                  metaColors={statusColors}
                  centerLabel="treaties"
                />
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
