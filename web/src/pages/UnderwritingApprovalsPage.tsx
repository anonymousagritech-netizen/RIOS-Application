import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Clock, AlertTriangle, ThumbsUp, ThumbsDown, Layers, Gavel } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { titleCase } from '../lib/format';
import styles from './UnderwritingPage.module.css';

type ApprovalLevel = 'UNDERWRITER' | 'SENIOR_UW' | 'CHIEF_UW' | 'COMMITTEE';
interface ApprovalRow {
  id: string; submissionId: string; level: ApprovalLevel; reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED'; slaDueAt: string | null; createdAt: string;
  decidedAt: string | null; note: string | null; slaBreached: boolean;
  reference: string; title: string; currency: string; riskScore: number | null; riskBand: string | null;
  limitMinor: number | null; estPremiumMinor: number | null; cedentName: string | null;
}

const LEVEL_LABEL: Record<string, string> = {
  UNDERWRITER: 'Underwriter', SENIOR_UW: 'Senior UW', CHIEF_UW: 'Chief UW', COMMITTEE: 'Committee',
};
const BAND_COLOR: Record<string, 'green' | 'amber' | 'orange' | 'red'> = { LOW: 'green', MODERATE: 'amber', ELEVATED: 'orange', HIGH: 'red' };
const STATUS_COLOR: Record<string, 'amber' | 'green' | 'red'> = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red' };

const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);

function useApprovals(status: string) {
  return useQuery({ queryKey: ['uw', 'approvals', status], queryFn: () => api<{ approvals: ApprovalRow[] }>(`/api/underwriting/approvals?status=${status}`) });
}

export function UnderwritingApprovalsPage() {
  const [status, setStatus] = useState('PENDING');
  const qc = useQueryClient();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canApprove = hasPermission('underwriting:approve');
  const list = useApprovals(status);
  const rows = list.data?.approvals ?? [];

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVED' | 'REJECTED' }) =>
      api(`/api/underwriting/approvals/${id}/decision`, { body: { decision } }),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['uw'] }); toast.success(`Referral ${v.decision.toLowerCase()}`); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Decision failed'),
  });

  const pending = rows.filter((r) => r.status === 'PENDING');
  const breached = pending.filter((r) => r.slaBreached);
  const byLevel = pending.reduce<Record<string, number>>((a, r) => { a[r.level] = (a[r.level] ?? 0) + 1; return a; }, {});
  const committee = byLevel['COMMITTEE'] ?? 0;

  const columns: Column<ApprovalRow>[] = [
    {
      key: 'sub', header: 'Submission', sortValue: (r) => r.reference,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.title}</div>
          <div className={styles.cellRef}>{r.reference} · {r.cedentName ?? 'Cedent TBC'}</div>
        </div>
      ),
    },
    { key: 'level', header: 'Authority', render: (r) => <Badge color="blue">{LEVEL_LABEL[r.level] ?? r.level}</Badge> },
    { key: 'reason', header: 'Reason', render: (r) => <span className={styles.cellSub}>{r.reason ?? '—'}</span> },
    { key: 'risk', header: 'Risk', render: (r) => r.riskBand ? <Badge color={BAND_COLOR[r.riskBand] ?? 'gray'}>{r.riskScore} · {titleCase(r.riskBand)}</Badge> : <span className={styles.cellSub}>—</span> },
    { key: 'limit', header: 'Limit', align: 'right', render: (r) => <span className={styles.num}>{money(r.limitMinor ?? r.estPremiumMinor, r.currency)}</span> },
    {
      key: 'sla', header: 'SLA', render: (r) => r.status !== 'PENDING'
        ? <Badge color={STATUS_COLOR[r.status] ?? 'gray'}>{titleCase(r.status)}</Badge>
        : r.slaDueAt
          ? <span className={`${styles.approvalSla} ${r.slaBreached ? styles.approvalSlaBreached : ''}`}><Clock size={12} /> {r.slaBreached ? 'Breached' : `due ${new Date(r.slaDueAt).toLocaleDateString([], { day: '2-digit', month: 'short' })}`}</span>
          : <span className={styles.cellSub}>—</span>,
    },
    {
      key: 'act', header: '', align: 'right', render: (r) => (r.status === 'PENDING' && canApprove) ? (
        <div className={styles.approvalActions}>
          <Button size="sm" variant="primary" icon={<ThumbsUp size={13} />} loading={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'APPROVED' })}>Approve</Button>
          <Button size="sm" variant="danger" icon={<ThumbsDown size={13} />} loading={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'REJECTED' })}>Reject</Button>
        </div>
      ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Approval queue"
        description="Referrals awaiting sign-off, ordered by SLA. Approve or reject business referred up the authority matrix."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Underwriting', to: '/underwriting' }, { label: 'Approvals' }]}
      />

      <div className={styles.kpis}>
        <KpiCard label="Pending referrals" value={String(pending.length)} hint="Awaiting a decision" icon={<ShieldCheck size={20} />} accent="var(--primary)" loading={list.isLoading} />
        <KpiCard label="SLA breached" value={String(breached.length)} hint="Past turnaround target" icon={<AlertTriangle size={20} />} accent="var(--accent-rose)" loading={list.isLoading} />
        <KpiCard label="Committee" value={String(committee)} hint="Largest risks" icon={<Layers size={20} />} accent="var(--accent-violet)" loading={list.isLoading} />
        <KpiCard label="Your authority" value={canApprove ? 'Approver' : 'View only'} hint={canApprove ? 'You can sign off' : 'No approval rights'} icon={<Gavel size={20} />} accent="var(--accent-emerald)" loading={list.isLoading} />
      </div>

      <Card padded={false}>
        <CardHeader title="Referrals" subtitle="SLA-breached first" />
        <div className={styles.filterBar}>
          {['PENDING', 'APPROVED', 'REJECTED', 'ALL'].map((s) => (
            <button key={s} className={`${styles.filterChip} ${status === s ? styles.filterActive : ''}`} onClick={() => setStatus(s)}>{titleCase(s)}</button>
          ))}
        </div>
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={rows}
            loading={list.isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<ShieldCheck size={18} />} title="No referrals" message="Nothing is waiting for approval in this view." />}
            skeletonRows={5}
          />
        </div>
      </Card>
    </>
  );
}
