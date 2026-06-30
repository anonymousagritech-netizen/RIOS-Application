/**
 * Cost & capacity + performance analytics (brief §13). Shows spend by category
 * with capacity utilisation (computed by the pure engine) and live operational
 * throughput. Read-focused; cost:read / ops:read.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatNumber, formatPercent, titleCase } from '../lib/format';
import { DollarSign, BookOpen, Receipt, ShieldAlert, FileText } from 'lucide-react';
import shared from './shared.module.css';

interface CostRecord {
  id: string; category: string; period: string; amountMinor: number; currency: string;
  capacityProvisioned?: number | null; capacityUsed?: number | null; capacityUnit?: string | null;
  utilisation: number; utilisationBand?: string | null;
}
interface Throughput { totals: { auditEvents: number; financialEvents: number; claims: number; statements: number; contracts: number }; auditByDay: { day: string; events: number }[] }

const BAND: Record<string, 'gray' | 'green' | 'amber' | 'red'> = { idle: 'gray', normal: 'green', high: 'amber', over: 'red' };

export function CostPage() {
  const cost = useQuery({ queryKey: ['cost-records'], queryFn: () => api<{ records: CostRecord[]; totalSpendMinor: number }>('/api/cost/records') });
  const perf = useQuery({ queryKey: ['perf-throughput'], queryFn: () => api<Throughput>('/api/perf/throughput') });

  if (cost.isLoading) return <PageLoader label="Loading cost & capacity…" />;

  const cols: Column<CostRecord>[] = [
    { key: 'cat', header: 'Category', render: (r) => <span className={shared.cellMain}>{titleCase(r.category)}</span> },
    { key: 'period', header: 'Period', render: (r) => r.period },
    { key: 'amount', header: 'Spend', align: 'right', sortValue: (r) => r.amountMinor, render: (r) => formatMoney(r.amountMinor, r.currency) },
    { key: 'cap', header: 'Capacity', align: 'right', render: (r) => r.capacityProvisioned != null ? `${formatNumber(r.capacityUsed)} / ${formatNumber(r.capacityProvisioned)} ${r.capacityUnit ?? ''}` : '-' },
    {
      key: 'util', header: 'Utilisation', align: 'right',
      render: (r) => r.utilisationBand ? <span><Badge color={BAND[r.utilisationBand] ?? 'slate'}>{formatPercent(r.utilisation)}</Badge></span> : '-',
    },
  ];

  return (
    <>
      <PageHeader title="Cost & capacity" description="Spend by category with capacity utilisation, and live operational throughput." />

      <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
        <KpiCard label="Total spend" value={formatMoney(cost.data?.totalSpendMinor)} icon={<DollarSign size={20} />} />
        <KpiCard label="Audit events" value={formatNumber(perf.data?.totals.auditEvents)} icon={<BookOpen size={20} />} />
        <KpiCard label="Financial events" value={formatNumber(perf.data?.totals.financialEvents)} icon={<Receipt size={20} />} />
        <KpiCard label="Claims" value={formatNumber(perf.data?.totals.claims)} icon={<ShieldAlert size={20} />} />
        <KpiCard label="Contracts" value={formatNumber(perf.data?.totals.contracts)} icon={<FileText size={20} />} />
      </div>

      <Card>
        <CardHeader title="Cost & capacity by category" />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table columns={cols} rows={cost.data?.records} rowKey={(r) => r.id}
            empty={<EmptyState title="No cost records" message="No cost records yet." />} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Activity throughput (last 14 days)" subtitle="Audited events per day." />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table
            columns={[
              { key: 'day', header: 'Day', render: (d: { day: string; events: number }) => d.day },
              { key: 'events', header: 'Events', align: 'right', render: (d: { day: string; events: number }) => formatNumber(d.events) },
            ]}
            rows={perf.data?.auditByDay}
            rowKey={(d) => d.day}
            empty={<EmptyState title="No activity" message="No audited activity recorded yet." />}
          />
        </div>
      </Card>
    </>
  );
}
