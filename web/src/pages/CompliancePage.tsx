import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ShieldCheck, FileClock, Stamp, Users, CalendarClock, ScrollText, Fingerprint,
} from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { BarChart } from '../components/BarChart';
import { Tabs } from '../components/Tabs';
import { PageLoader } from '../components/Feedback';
import type { TokenColor } from '../lib/status';
import { formatNumber, formatDateTime, formatDate, titleCase } from '../lib/format';
import styles from './CompliancePage.module.css';

/* ---------------- Types (mirror the /api/compliance contract) ---------------- */
interface Totals {
  auditEntries: number; auditLast30d: number; approvals: number; approvalsPending: number;
  regReturns: number; calendarDue: number; chainOk: boolean; chainBroken: number; chainVerifiedPct: number;
}
interface KeyN { key: string; n: number }
interface AuditRow { at: string; action: string; actor: string | null; entityType: string; entityId: string }
interface Approval { id: string; action: string; entityType: string; status: string; requestedBy: string | null; decidedBy: string | null; decidedAt: string | null; note: string | null }
interface Activity { actor: string | null; actorId: string | null; actions: number; lastAt: string }
interface CalendarItem { type: string; title: string; due: string | null; status: string }
interface PolicyItem { ref: string; versionNo: number; note: string | null; at: string }
interface ComplianceResponse {
  totals: Totals;
  audit: { byAction: KeyN[]; byEntityType: KeyN[]; recent: AuditRow[] };
  approvals: Approval[];
  activity: Activity[];
  calendar: CalendarItem[];
  policyHistory: PolicyItem[];
}

const STATUS_COLOR: Record<string, TokenColor> = {
  approved: 'green', filed: 'green', pending: 'amber', rejected: 'red',
  scheduled: 'blue', paused: 'slate', draft: 'slate',
};
const statusColor = (s: string): TokenColor => STATUS_COLOR[s?.toLowerCase()] ?? 'slate';

type TabId = 'audit' | 'approvals' | 'activity' | 'calendar' | 'policy';
const TABS = [
  { id: 'audit', label: 'Audit trail' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'activity', label: 'User activity' },
  { id: 'calendar', label: 'Compliance calendar' },
  { id: 'policy', label: 'Policy history' },
];

export function CompliancePage() {
  const [tab, setTab] = useState<TabId>('audit');
  const { data, isLoading } = useQuery({ queryKey: ['compliance'], queryFn: () => api<ComplianceResponse>('/api/compliance') });

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <PageHeader title="Regulatory & Compliance" description="Assurance across the audit trail, approvals, activity and filings." />
        <PageLoader />
      </div>
    );
  }
  const t = data.totals;

  const auditCols: Column<AuditRow>[] = [
    { key: 'at', header: 'When', render: (r) => <span className={styles.mono}>{formatDateTime(r.at)}</span> },
    { key: 'action', header: 'Action', render: (r) => <Badge color="indigo">{titleCase(r.action)}</Badge> },
    { key: 'entity', header: 'Entity', render: (r) => <span className={styles.sub}>{titleCase(r.entityType)}</span> },
    { key: 'actor', header: 'Actor', render: (r) => r.actor ?? '—' },
  ];
  const approvalCols: Column<Approval>[] = [
    { key: 'action', header: 'Action', render: (r) => <span className={styles.main}>{titleCase(r.action)}</span> },
    { key: 'entity', header: 'Entity', render: (r) => <span className={styles.sub}>{titleCase(r.entityType)}</span> },
    { key: 'requestedBy', header: 'Requested by', render: (r) => r.requestedBy ?? '—' },
    { key: 'decidedBy', header: 'Decided by', render: (r) => r.decidedBy ?? '—' },
    { key: 'decidedAt', header: 'Decided', render: (r) => r.decidedAt ? formatDate(r.decidedAt) : '—' },
    { key: 'status', header: 'Status', render: (r) => <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> },
  ];
  const activityCols: Column<Activity>[] = [
    { key: 'actor', header: 'User', render: (r) => <span className={styles.main}>{r.actor ?? 'System'}</span> },
    { key: 'actions', header: 'Actions', align: 'right', render: (r) => formatNumber(r.actions) },
    { key: 'lastAt', header: 'Last activity', render: (r) => <span className={styles.mono}>{formatDateTime(r.lastAt)}</span> },
  ];
  const calendarCols: Column<CalendarItem>[] = [
    { key: 'type', header: 'Type', render: (r) => <Badge color={r.type === 'RETURN' ? 'violet' : 'teal'}>{titleCase(r.type)}</Badge> },
    { key: 'title', header: 'Item', render: (r) => <span className={styles.main}>{r.title}</span> },
    { key: 'due', header: 'Due', render: (r) => r.due ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> },
  ];
  const policyCols: Column<PolicyItem>[] = [
    { key: 'ref', header: 'Contract', render: (r) => <span className={styles.main}>{r.ref}</span> },
    { key: 'versionNo', header: 'Version', render: (r) => <Badge color="blue">v{r.versionNo}</Badge> },
    { key: 'note', header: 'Note', render: (r) => r.note ?? '—' },
    { key: 'at', header: 'Snapshotted', render: (r) => <span className={styles.mono}>{formatDateTime(r.at)}</span> },
  ];

  return (
    <div className={styles.page}>
      <PageHeader
        title="Regulatory & Compliance"
        description="A single assurance view over the hash-chained audit trail, the approval log, user activity, filings and the compliance calendar."
        crumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'Compliance' }]}
      />

      <div className={styles.kpiGrid}>
        <KpiCard label="Audit entries" value={formatNumber(t.auditEntries)} hint={`${formatNumber(t.auditLast30d)} in last 30 days`} icon={<FileClock size={18} />} accent="var(--primary)" />
        <KpiCard
          label="Chain integrity"
          value={`${t.chainVerifiedPct}%`}
          hint={t.chainOk ? 'Tamper-evident chain intact' : `${formatNumber(t.chainBroken)} continuity gaps`}
          icon={<ShieldCheck size={18} />}
          accent={t.chainOk ? 'var(--accent-emerald)' : 'var(--c-amber)'}
        />
        <KpiCard label="Approvals" value={formatNumber(t.approvals)} hint={`${formatNumber(t.approvalsPending)} pending`} icon={<Stamp size={18} />} accent="var(--accent-violet)" />
        <KpiCard label="Regulatory returns" value={formatNumber(t.regReturns)} icon={<ScrollText size={18} />} accent="var(--accent-indigo)" />
        <KpiCard label="Calendar due" value={formatNumber(t.calendarDue)} hint="Open filings & reports" icon={<CalendarClock size={18} />} accent={t.calendarDue ? 'var(--c-amber)' : 'var(--accent-emerald)'} />
      </div>

      <div className={styles.chartGrid}>
        <Card>
          <CardHeader title="Audit activity by action" subtitle="What the platform records" />
          <BarChart data={data.audit.byAction.map((a) => ({ label: titleCase(a.key), value: a.n }))} />
        </Card>
        <Card>
          <CardHeader title="Audit activity by entity" subtitle="Which objects change most" />
          <BarChart data={data.audit.byEntityType.map((a) => ({ label: titleCase(a.key), value: a.n }))} />
        </Card>
      </div>

      <Card padded={false}>
        <div className={styles.tabsHead}>
          <Tabs tabs={TABS} active={tab} onChange={(id) => setTab(id as TabId)} />
        </div>
        <div className={styles.tabBody}>
          {tab === 'audit' && (
            <Table rows={data.audit.recent} columns={auditCols} rowKey={(r) => `${r.at}-${r.action}-${r.entityId}`}
              empty={<EmptyState icon={<Fingerprint size={18} />} title="No audit entries" message="Material changes will appear here." />} />
          )}
          {tab === 'approvals' && (
            <Table rows={data.approvals} columns={approvalCols} rowKey={(r) => r.id}
              empty={<EmptyState icon={<Stamp size={18} />} title="No approvals" message="Approval requests will appear here." />} />
          )}
          {tab === 'activity' && (
            <Table rows={data.activity} columns={activityCols} rowKey={(r) => r.actorId ?? r.actor ?? r.lastAt}
              empty={<EmptyState icon={<Users size={18} />} title="No activity" message="User activity will appear here." />} />
          )}
          {tab === 'calendar' && (
            <Table rows={data.calendar} columns={calendarCols} rowKey={(r) => `${r.type}-${r.title}-${r.due}`}
              empty={<EmptyState icon={<CalendarClock size={18} />} title="Nothing scheduled" message="Regulatory returns and scheduled reports will appear here." />} />
          )}
          {tab === 'policy' && (
            <Table rows={data.policyHistory} columns={policyCols} rowKey={(r) => `${r.ref}-${r.versionNo}`}
              empty={<EmptyState icon={<ScrollText size={18} />} title="No version history" message="Treaty version snapshots will appear here." />} />
          )}
        </div>
      </Card>
    </div>
  );
}
