import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Workflow, AlarmClock, TriangleAlert, ShieldCheck, Stamp, GitBranch, Timer } from 'lucide-react';
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
import { formatNumber, formatDate, formatPercent, titleCase } from '../lib/format';
import styles from './WorkflowEnginePage.module.css';

/* ---------------- Types (mirror /api/workflow-engine) ---------------- */
type SlaState = 'ON_TRACK' | 'AT_RISK' | 'DUE_SOON' | 'BREACHED' | 'DONE' | 'NO_DUE';
interface KeyN { key: string; n: number }
interface Task { id: string; name: string; status: string; assigneeRole: string | null; workflowKey: string | null; instanceState: string | null; dueAt: string | null; slaState: SlaState; escalationTier: number; breached: boolean; overdueHours: number }
interface Approval { id: string; action: string; entityType: string; status: string; requestedBy: string | null; decidedBy: string | null; createdMs: string }
interface SlaTarget { id: string; service: string; metric: string; targetValue: string; unit: string }
interface Response {
  totals: { instances: number; openTasks: number; breachedTasks: number; slaCompliancePct: number; escalations: number; pendingApprovals: number; slaTargets: number };
  instancesByState: KeyN[]; instancesByStatus: KeyN[];
  slaBook: { total: number; onTrack: number; atRisk: number; dueSoon: number; breached: number; done: number; compliancePct: number; escalations: number };
  tasks: Task[]; escalations: Task[]; approvals: Approval[]; approvalsByStatus: KeyN[]; approvalsByAction: KeyN[]; slaTargets: SlaTarget[];
}

const SLA_COLOR: Record<SlaState, TokenColor> = { ON_TRACK: 'green', AT_RISK: 'amber', DUE_SOON: 'orange', BREACHED: 'red', DONE: 'slate', NO_DUE: 'gray' };
const APPROVAL_COLOR: Record<string, TokenColor> = { approved: 'green', pending: 'amber', rejected: 'red' };
const TIER_COLOR: Record<number, TokenColor> = { 0: 'slate', 1: 'amber', 2: 'orange', 3: 'red' };
const SLA_META: Record<string, string> = { ON_TRACK: 'green', AT_RISK: 'amber', DUE_SOON: 'orange', BREACHED: 'red', DONE: 'slate' };

type TabId = 'escalations' | 'tasks' | 'approvals' | 'sla';

export function WorkflowEnginePage() {
  const [tab, setTab] = useState<TabId>('escalations');
  const { data, isLoading } = useQuery({ queryKey: ['workflow-engine'], queryFn: () => api<Response>('/api/workflow-engine') });

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <PageHeader title="Workflow Engine" description="Live workflow instances, SLA tracking, escalations and the approval matrix." />
        <PageLoader />
      </div>
    );
  }
  const t = data.totals;

  const taskCols: Column<Task>[] = [
    { key: 'name', header: 'Task', render: (r) => <span className={styles.main}>{r.name}</span> },
    { key: 'wf', header: 'Workflow', render: (r) => <span className={styles.sub}>{r.workflowKey ?? '—'}{r.instanceState ? ` · ${r.instanceState}` : ''}</span> },
    { key: 'role', header: 'Owner', render: (r) => r.assigneeRole ? <Badge color="indigo">{titleCase(r.assigneeRole)}</Badge> : '—' },
    { key: 'due', header: 'Due', render: (r) => r.dueAt ? formatDate(r.dueAt) : '—' },
    { key: 'sla', header: 'SLA', render: (r) => <Badge color={SLA_COLOR[r.slaState]}>{titleCase(r.slaState)}</Badge> },
    { key: 'esc', header: 'Escalation', align: 'right', render: (r) => r.escalationTier > 0 ? <Badge color={TIER_COLOR[r.escalationTier] ?? 'red'}>Tier {r.escalationTier} · {r.overdueHours}h</Badge> : '—' },
  ];
  const apprCols: Column<Approval>[] = [
    { key: 'action', header: 'Action', render: (r) => <span className={styles.main}>{titleCase(r.action)}</span> },
    { key: 'entity', header: 'Entity', render: (r) => <span className={styles.sub}>{titleCase(r.entityType)}</span> },
    { key: 'req', header: 'Requested by', render: (r) => r.requestedBy ?? '—' },
    { key: 'dec', header: 'Decided by', render: (r) => r.decidedBy ?? '—' },
    { key: 'status', header: 'Status', render: (r) => <Badge color={APPROVAL_COLOR[r.status] ?? 'slate'}>{titleCase(r.status)}</Badge> },
  ];
  const slaCols: Column<SlaTarget>[] = [
    { key: 'service', header: 'Service', render: (r) => <span className={styles.main}>{titleCase(r.service)}</span> },
    { key: 'metric', header: 'Metric', render: (r) => titleCase(r.metric) },
    { key: 'target', header: 'Target', align: 'right', render: (r) => `${r.targetValue} ${r.unit}` },
  ];

  return (
    <div className={styles.page}>
      <PageHeader
        title="Workflow Engine"
        description="The control tower over every running workflow — instances by state, SLA-scored tasks, the escalation queue and the approval matrix."
        crumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'Workflow Engine' }]}
      />

      <div className={styles.kpiGrid}>
        <KpiCard label="Active instances" value={formatNumber(t.instances)} icon={<Workflow size={18} />} accent="var(--primary)" />
        <KpiCard label="Open tasks" value={formatNumber(t.openTasks)} icon={<AlarmClock size={18} />} accent="var(--accent-indigo)" />
        <KpiCard label="SLA compliance" value={formatPercent(t.slaCompliancePct)} icon={<ShieldCheck size={18} />} accent={t.slaCompliancePct >= 95 ? 'var(--accent-emerald)' : 'var(--c-amber)'} />
        <KpiCard label="Breached" value={formatNumber(t.breachedTasks)} hint={`${formatNumber(t.escalations)} escalations`} icon={<TriangleAlert size={18} />} accent={t.breachedTasks ? 'var(--c-red)' : 'var(--accent-emerald)'} />
        <KpiCard label="Pending approvals" value={formatNumber(t.pendingApprovals)} icon={<Stamp size={18} />} accent="var(--accent-violet)" />
      </div>

      <div className={styles.chartGrid}>
        <Card>
          <CardHeader title="Instances by state" subtitle="Where work sits in each workflow" />
          <BarChart data={data.instancesByState.map((s) => ({ label: titleCase(s.key), value: s.n }))} />
        </Card>
        <Card>
          <CardHeader title="Task SLA mix" subtitle="Health of the open queue" />
          <BarChart
            data={[
              { label: 'On track', value: data.slaBook.onTrack, status: 'ON_TRACK' },
              { label: 'At risk', value: data.slaBook.atRisk, status: 'AT_RISK' },
              { label: 'Due soon', value: data.slaBook.dueSoon, status: 'DUE_SOON' },
              { label: 'Breached', value: data.slaBook.breached, status: 'BREACHED' },
              { label: 'Done', value: data.slaBook.done, status: 'DONE' },
            ]}
            metaColors={SLA_META}
          />
        </Card>
      </div>

      <Card padded={false}>
        <div className={styles.tabsHead}>
          <Tabs
            tabs={[
              { id: 'escalations', label: `Escalations (${data.escalations.length})` },
              { id: 'tasks', label: 'All tasks' },
              { id: 'approvals', label: `Approval matrix (${data.approvals.length})` },
              { id: 'sla', label: 'SLA targets' },
            ]}
            active={tab} onChange={(id) => setTab(id as TabId)}
          />
        </div>
        <div className={styles.tabBody}>
          {tab === 'escalations' && (
            <Table rows={data.escalations} columns={taskCols} rowKey={(r) => r.id}
              empty={<EmptyState icon={<Timer size={18} />} title="Nothing escalating" message="All SLAs are on track." />} />
          )}
          {tab === 'tasks' && (
            <Table rows={data.tasks} columns={taskCols} rowKey={(r) => r.id}
              empty={<EmptyState icon={<AlarmClock size={18} />} title="No tasks" message="Workflow tasks will appear here." />} />
          )}
          {tab === 'approvals' && (
            <Table rows={data.approvals} columns={apprCols} rowKey={(r) => r.id}
              empty={<EmptyState icon={<Stamp size={18} />} title="No approvals" message="Approval requests will appear here." />} />
          )}
          {tab === 'sla' && (
            <Table rows={data.slaTargets} columns={slaCols} rowKey={(r) => r.id}
              empty={<EmptyState icon={<GitBranch size={18} />} title="No SLA targets" message="SLA targets will appear here." />} />
          )}
        </div>
      </Card>
    </div>
  );
}
