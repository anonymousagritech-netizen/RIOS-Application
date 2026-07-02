import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useStatusColors, useTreaties } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, FormGrid, Select, Input } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { KpiCard } from '../components/KpiCard';
import { Tabs, type TabDef } from '../components/Tabs';
import {
  formatMoney, formatDate, formatDateTime, formatNumber, titleCase, minorUnitsFor,
} from '../lib/format';
import { ReceiptText, Scale, Hourglass, CheckCircle2, Download, ShieldCheck } from 'lucide-react';
import type { TreatyListItem } from '../lib/types';
import shared from './shared.module.css';
import styles from './StatementsPage.module.css';

/* -------------------------------------------------------------------------- */
/*  Types                                                                       */
/* -------------------------------------------------------------------------- */

interface StatementListItem {
  id: string;
  reference: string;
  contractId: string;
  counterpartyId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  currency: string;
  balanceMinor: number;
  status: string;
  issuedAt?: string | null;
  settledAt?: string | null;
}
interface StatementsResponse { statements: StatementListItem[]; }

interface StatementEvent {
  id: string;
  contractId: string;
  eventType: string;
  direction: 'DR' | 'CR';
  amountMinor: number;
  currency: string;
  bookedAt?: string | null;
  narrative?: string | null;
}

interface StatementDetail {
  id: string;
  reference: string;
  contractId: string;
  counterpartyId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  currency: string;
  balanceMinor: number;
  status: string;
  issuedAt?: string | null;
  settledAt?: string | null;
  events?: StatementEvent[];
  eventCount?: number;
}

interface GenerateResult {
  id: string;
  reference: string;
  balanceMinor: number;
  currency: string;
  lines: { type: string; count: number; totalMinor: number }[];
  eventCount: number;
}

interface VerificationItem {
  itemKey: string;
  expectedMinor: number | null;
  actualMinor: number | null;
  deviationMinor: number | null;
  withinTolerance: boolean | null;
  note: string | null;
}

interface Verification {
  id: string;
  status: string;
  tolerancePct: number;
  createdAt: string;
  items: VerificationItem[];
}

interface VerificationsResponse {
  statementId: string;
  verifications: Verification[];
}

interface VerifyResult {
  id: string;
  statementId: string;
  status: string;
  tolerancePct: number;
  currency: string;
  createdAt: string;
  items: VerificationItem[];
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle helpers                                                            */
/* -------------------------------------------------------------------------- */

const LIFECYCLE = ['OPEN', 'PREPARED', 'UNDER_REVIEW', 'APPROVED', 'ISSUED', 'SETTLED', 'CLOSED'];
const STATUSES = [...LIFECYCLE, 'DISPUTED'];

function legalNextStates(status: string): string[] {
  const idx = LIFECYCLE.indexOf(status);
  const next: string[] = [];
  const forward = idx >= 0 && idx < LIFECYCLE.length - 1 ? LIFECYCLE[idx + 1] : undefined;
  if (forward) next.push(forward);
  if (status === 'UNDER_REVIEW' || status === 'ISSUED') next.push('DISPUTED');
  return next;
}

function actionLabel(to: string): string {
  switch (to) {
    case 'PREPARED':     return 'Prepare';
    case 'UNDER_REVIEW': return 'Submit for Review';
    case 'APPROVED':     return 'Approve';
    case 'ISSUED':       return 'Issue';
    case 'SETTLED':      return 'Settle';
    case 'CLOSED':       return 'Close';
    case 'DISPUTED':     return 'Dispute';
    default:             return titleCase(to);
  }
}

/* -------------------------------------------------------------------------- */
/*  Display helpers                                                              */
/* -------------------------------------------------------------------------- */

function formatPeriod(
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
): string {
  if (!periodStart && !periodEnd) return '-';
  if (!periodStart) return formatDate(periodEnd);
  if (!periodEnd) return formatDate(periodStart);
  return `${formatDate(periodStart)} – ${formatDate(periodEnd)}`;
}

/** Attempt a compact label ("Q2 2024" or "2024") when the period matches a standard length. */
function periodLabel(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const days = Math.round((e.getTime() - s.getTime()) / 86400000);
  if (days >= 88 && days <= 95) {
    const q = Math.ceil((s.getMonth() + 1) / 3);
    return `Q${q} ${s.getFullYear()}`;
  }
  if (days >= 362 && days <= 367) return String(s.getFullYear());
  return formatPeriod(start, end);
}

/** Client-side CSV export of visible statement rows. */
function exportCsv(rows: StatementListItem[], treatyMap: Map<string, TreatyListItem>): void {
  const headers = ['Reference', 'Treaty', 'Period From', 'Period To', 'Currency', 'Balance', 'Status', 'Issued'];
  const body = rows.map((s) => {
    const t = treatyMap.get(s.contractId);
    const label = t ? (t.reference ? `${t.reference} — ${t.name}` : t.name) : s.contractId;
    const minor = minorUnitsFor(s.currency);
    const balance = (s.balanceMinor / Math.pow(10, minor)).toFixed(minor);
    return [s.reference, label, s.periodStart ?? '', s.periodEnd ?? '', s.currency, balance, s.status, s.issuedAt ?? ''];
  });
  const csv = [headers, ...body].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `statements-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------------- */
/*  Data hooks                                                                  */
/* -------------------------------------------------------------------------- */

function useStatements(params: { contractId?: string; status?: string }) {
  return useQuery({
    queryKey: ['statements', 'list', params],
    queryFn: () => api<StatementsResponse>(`/api/statements${qs(params)}`),
  });
}

function useStatementDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['statements', 'detail', id],
    queryFn: () => api<StatementDetail>(`/api/statements/${id}`),
    enabled: !!id,
  });
}

function useGenerateStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { contractId: string; periodStart?: string; periodEnd?: string }) =>
      api<GenerateResult>('/api/statements/generate', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statements', 'list'] }),
  });
}

function useTransitionStatement(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: string) =>
      api<{ id: string; status: string }>(`/api/statements/${id}/transition`, { body: { to } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['statements', 'detail', id] });
      qc.invalidateQueries({ queryKey: ['statements', 'list'] });
    },
  });
}

function useStatementVerifications(id: string | undefined) {
  return useQuery({
    queryKey: ['statements', 'verifications', id],
    queryFn: () => api<VerificationsResponse>(`/api/statements/${id}/verifications`),
    enabled: !!id,
  });
}

function useRunVerification(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tolerancePct?: number) =>
      api<VerifyResult>(`/api/statements/${id}/verify`, { body: { tolerancePct } }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['statements', 'verifications', id] }),
  });
}

/* -------------------------------------------------------------------------- */
/*  Generate Statement modal                                                    */
/* -------------------------------------------------------------------------- */

const STATEMENT_TYPES = [
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'ANNUAL',    label: 'Annual' },
  { value: 'ADHOC',     label: 'Ad Hoc' },
];

function GenerateModal({
  open,
  treaties,
  onClose,
  onSuccess,
}: {
  open: boolean;
  treaties: TreatyListItem[];
  onClose: () => void;
  onSuccess: (id: string) => void;
}) {
  const toast = useToast();
  const generate = useGenerateStatement();

  const [contractId, setContractId]       = useState('');
  const [statementType, setStatementType] = useState('QUARTERLY');
  const [periodStart, setPeriodStart]     = useState('');
  const [periodEnd, setPeriodEnd]         = useState('');

  function applyType(type: string) {
    setStatementType(type);
    const now = new Date();
    if (type === 'QUARTERLY') {
      const q = Math.ceil((now.getMonth() + 1) / 3);
      const startMonth = (q - 1) * 3;
      const start = new Date(now.getFullYear(), startMonth, 1);
      const end   = new Date(now.getFullYear(), startMonth + 3, 0);
      setPeriodStart(start.toISOString().slice(0, 10));
      setPeriodEnd(end.toISOString().slice(0, 10));
    } else if (type === 'ANNUAL') {
      setPeriodStart(`${now.getFullYear()}-01-01`);
      setPeriodEnd(`${now.getFullYear()}-12-31`);
    } else {
      setPeriodStart('');
      setPeriodEnd('');
    }
  }

  const reset = () => {
    setContractId('');
    setStatementType('QUARTERLY');
    setPeriodStart('');
    setPeriodEnd('');
  };

  const submit = async () => {
    if (!contractId) { toast.error('Select a treaty first'); return; }
    try {
      const res = await generate.mutateAsync({
        contractId,
        periodStart: periodStart || undefined,
        periodEnd:   periodEnd   || undefined,
      });
      toast.success(`Statement ${res.reference} generated — ${res.eventCount} event(s)`);
      reset();
      onSuccess(res.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(e.message || 'No un-statemented events for this period');
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Could not generate statement');
      }
    }
  };

  const handleClose = () => { reset(); onClose(); };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Generate Statement"
      description="Gather un-statemented financial events into a new statement of account."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={generate.isPending}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={generate.isPending}
            disabled={!contractId}
          >
            Generate
          </Button>
        </>
      }
    >
      <FormGrid>
        <FormField label="Treaty" required>
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)}>
            <option value="">Select a treaty…</option>
            {treaties.map((t) => (
              <option key={t.id} value={t.id}>
                {t.reference ? `${t.reference} — ${t.name}` : t.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Statement Type">
          <Select value={statementType} onChange={(e) => applyType(e.target.value)}>
            {STATEMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
        </FormField>

        <FormField label="Period From">
          <Input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
        </FormField>

        <FormField label="Period To">
          <Input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
        </FormField>
      </FormGrid>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main page                                                                   */
/* -------------------------------------------------------------------------- */

export function StatementsPage() {
  const { hasPermission } = useAuth();
  const toast             = useToast();
  const qc                = useQueryClient();
  const canWrite          = hasPermission('statement:write');
  const statusColors      = useStatusColors('statement_status');

  /* Treaty lookup (for display + generate form) */
  const { data: treatyData } = useTreaties({});
  const treaties     = treatyData?.treaties ?? [];
  const treatyMap    = useMemo(() => new Map(treaties.map((t) => [t.id, t])), [treaties]);

  /* Filters */
  const [contractId,    setContractId]    = useState('');
  const [statusFilter,  setStatusFilter]  = useState('');
  const [periodFrom,    setPeriodFrom]    = useState('');
  const [periodTo,      setPeriodTo]      = useState('');

  /* UI state */
  const [selectedId,    setSelectedId]    = useState<string | null>(null);
  const [generateOpen,  setGenerateOpen]  = useState(false);

  /* Data */
  const { data, isLoading } = useStatements({
    contractId: contractId || undefined,
    status:     statusFilter || undefined,
  });

  const allRows = data?.statements ?? [];

  /* Client-side date-range filter (period overlap: row's period overlaps filter range) */
  const rows = useMemo(() => {
    if (!periodFrom && !periodTo) return allRows;
    return allRows.filter((s) => {
      if (periodFrom && s.periodEnd   && s.periodEnd   < periodFrom) return false;
      if (periodTo   && s.periodStart && s.periodStart > periodTo)   return false;
      return true;
    });
  }, [allRows, periodFrom, periodTo]);

  /* KPIs */
  const kpis = useMemo(() => {
    const inFlightSet  = new Set(['PREPARED', 'UNDER_REVIEW', 'APPROVED', 'ISSUED']);
    const settledSet   = new Set(['SETTLED', 'CLOSED']);
    let balance = 0, inFlight = 0, settled = 0;
    for (const s of rows) {
      balance += s.balanceMinor;
      if (inFlightSet.has(s.status)) inFlight++;
      if (settledSet.has(s.status))  settled++;
    }
    return { count: rows.length, balance, inFlight, settled, ccy: rows[0]?.currency };
  }, [rows]);

  /* Row-level quick transitions */
  const rowTransition = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api<{ id: string; status: string }>(`/api/statements/${id}/transition`, { body: { to } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['statements', 'list'] });
      qc.invalidateQueries({ queryKey: ['statements', 'detail'] });
    },
  });

  const doRowTransition = useCallback(async (id: string, to: string) => {
    try {
      const res = await rowTransition.mutateAsync({ id, to });
      toast.success(`Statement moved to ${titleCase(res.status)}`);
      if (res.status === 'ISSUED') toast.success('AR/AP invoice created');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Transition failed');
    }
  }, [rowTransition, toast]);

  const pendingId = rowTransition.isPending ? (rowTransition.variables as { id?: string })?.id : undefined;

  const columns: Column<StatementListItem>[] = useMemo(() => [
    {
      key: 'reference',
      header: 'Reference',
      sortValue: (s) => s.reference,
      render: (s) => <span className={shared.cellRef}>{s.reference}</span>,
    },
    {
      key: 'treaty',
      header: 'Treaty',
      render: (s) => {
        const t = treatyMap.get(s.contractId);
        if (!t) return <span className={shared.cellSub}>{s.contractId.slice(0, 8)}…</span>;
        return (
          <div>
            <div className={shared.cellMain}>{t.name}</div>
            {t.reference && <div className={shared.cellRef}>{t.reference}</div>}
          </div>
        );
      },
    },
    {
      key: 'period',
      header: 'Period',
      render: (s) => (
        <span className={shared.cellSub}>
          {s.periodStart && s.periodEnd
            ? periodLabel(s.periodStart, s.periodEnd)
            : formatPeriod(s.periodStart, s.periodEnd)}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      sortValue: (s) => s.balanceMinor,
      render: (s) => <span className={shared.money}>{formatMoney(s.balanceMinor, s.currency)}</span>,
    },
    {
      key: 'issued',
      header: 'Issued',
      sortValue: (s) => s.issuedAt ?? '',
      render: (s) => formatDate(s.issuedAt),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'center',
      sortValue: (s) => s.status,
      render: (s) => <StatusPill status={s.status} metaColors={statusColors} />,
    },
    ...(canWrite ? [{
      key: 'actions',
      header: '',
      align: 'right' as const,
      width: '200px',
      render: (s: StatementListItem) => {
        const nextStates = legalNextStates(s.status);
        if (!nextStates.length) return <span className={shared.cellSub}>—</span>;
        return (
          <div
            className={styles.rowActions}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {nextStates.map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === 'DISPUTED' ? 'danger' : 'secondary'}
                onClick={() => doRowTransition(s.id, to)}
                loading={pendingId === s.id && rowTransition.variables
                  ? (rowTransition.variables as { to?: string })?.to === to
                  : false}
                disabled={rowTransition.isPending && pendingId !== s.id}
              >
                {actionLabel(to)}
              </Button>
            ))}
          </div>
        );
      },
    }] : []),
  ], [statusColors, treatyMap, canWrite, doRowTransition, pendingId, rowTransition.isPending, rowTransition.variables]);

  return (
    <>
      <PageHeader
        title="Statements"
        description="Generate statements of account from un-statemented financial events and drive them through the settlement lifecycle."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Statements' }]}
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setGenerateOpen(true)}>
              Generate Statement
            </Button>
          ) : (
            <Badge color="slate">read-only</Badge>
          )
        }
      />

      <div className={styles.kpiRow}>
        <KpiCard label="Statements" value={formatNumber(kpis.count)} accent="var(--primary)" icon={<ReceiptText size={20} />} loading={isLoading} />
        <KpiCard label="Net Balance" value={formatMoney(kpis.balance, kpis.ccy)} accent="var(--accent-cyan)" icon={<Scale size={20} />} loading={isLoading} />
        <KpiCard label="In Flight" value={formatNumber(kpis.inFlight)} hint="Prepared through issued" accent="var(--accent-orange)" icon={<Hourglass size={20} />} loading={isLoading} />
        <KpiCard label="Settled" value={formatNumber(kpis.settled)} accent="var(--accent-emerald)" icon={<CheckCircle2 size={20} />} loading={isLoading} />
      </div>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Contract</span>
            <Select
              value={contractId}
              onChange={(e) => setContractId(e.target.value)}
              aria-label="Filter by contract"
            >
              <option value="">All</option>
              {treaties.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.reference ? `${t.reference} — ${t.name}` : t.name}
                </option>
              ))}
            </Select>
          </div>

          <div className={shared.filter}>
            <span className={shared.filterLabel}>Status</span>
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>

          <div className={shared.filter}>
            <span className={shared.filterLabel}>From</span>
            <Input
              type="date"
              value={periodFrom}
              onChange={(e) => setPeriodFrom(e.target.value)}
              aria-label="Period from"
              style={{ width: 140 }}
            />
          </div>

          <div className={shared.filter}>
            <span className={shared.filterLabel}>To</span>
            <Input
              type="date"
              value={periodTo}
              onChange={(e) => setPeriodTo(e.target.value)}
              aria-label="Period to"
              style={{ width: 140 }}
            />
          </div>

          <div className={shared.spacer} />

          {rows.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => exportCsv(rows, treatyMap)}
              title="Export visible rows as CSV"
            >
              <Download size={15} style={{ marginRight: 4 }} />
              Export CSV
            </Button>
          )}
        </div>

        <Table
          columns={columns}
          rows={rows}
          loading={isLoading}
          rowKey={(s) => s.id}
          onRowClick={(s) => setSelectedId(s.id)}
          empty={
            <EmptyState
              title="No statements"
              message="Use Generate Statement to create a statement of account from un-statemented events."
              icon={<ReceiptText size={16} />}
            />
          }
        />
      </Card>

      <GenerateModal
        open={generateOpen}
        treaties={treaties}
        onClose={() => setGenerateOpen(false)}
        onSuccess={(id) => { setGenerateOpen(false); setSelectedId(id); }}
      />

      <StatementDrawer
        id={selectedId}
        canWrite={canWrite}
        statusColors={statusColors}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Statement drawer (overview + SOA verification tabs)                        */
/* -------------------------------------------------------------------------- */

function StatementDrawer({
  id,
  canWrite,
  statusColors,
  onClose,
}: {
  id: string | null;
  canWrite: boolean;
  statusColors: Record<string, string>;
  onClose: () => void;
}) {
  const toast   = useToast();
  const { data, isLoading } = useStatementDetail(id ?? undefined);
  const transition  = useTransitionStatement(id ?? undefined);
  const verQuery    = useStatementVerifications(id ?? undefined);
  const runVerify   = useRunVerification(id ?? undefined);

  const [confirmTo,    setConfirmTo]    = useState<string | null>(null);
  const [activeTab,    setActiveTab]    = useState('overview');
  const [tolerancePct, setTolerancePct] = useState('1');

  const drawerTabs: TabDef[] = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'soa',
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ShieldCheck size={13} />
          SOA Verification
        </span>
      ),
    },
  ];

  const runTransition = async (to: string) => {
    try {
      const res = await transition.mutateAsync(to);
      toast.success(`Statement moved to ${titleCase(res.status)}`);
      if (res.status === 'ISSUED') toast.success('AR/AP invoice created on issue');
      setConfirmTo(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(e.message || 'Illegal transition');
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Transition failed');
      }
      setConfirmTo(null);
    }
  };

  const onTransitionClick = (to: string) => {
    if (to === 'ISSUED' || to === 'SETTLED') setConfirmTo(to);
    else runTransition(to);
  };

  const doVerify = async () => {
    const pct = parseFloat(tolerancePct);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) { toast.error('Tolerance must be 0–100'); return; }
    try {
      const res = await runVerify.mutateAsync(pct);
      if (res.status === 'VERIFIED') {
        toast.success('All items within tolerance — statement verified');
      } else if (res.status === 'DEVIATIONS') {
        const n = res.items.filter((i) => i.withinTolerance === false).length;
        toast.error(`Verification found ${n} deviation(s) outside tolerance`);
      } else {
        toast.error('Verification computation failed — see item notes');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Verification failed');
    }
  };

  const events      = data?.events ?? [];
  const nextStates  = data ? legalNextStates(data.status) : [];

  /* Derive statement lines client-side from events (server detail doesn't include them) */
  const linesByType = useMemo(() => {
    const map = new Map<string, { count: number; totalMinor: number }>();
    for (const e of events) {
      const sign    = e.direction === 'DR' ? 1 : -1;
      const cur     = map.get(e.eventType) ?? { count: 0, totalMinor: 0 };
      map.set(e.eventType, { count: cur.count + 1, totalMinor: cur.totalMinor + sign * e.amountMinor });
    }
    return Array.from(map.entries()).map(([type, v]) => ({ type, ...v }));
  }, [events]);

  type LineRow = { type: string; count: number; totalMinor: number };

  const lineCols: Column<LineRow>[] = [
    { key: 'type',  header: 'Line',  render: (l) => titleCase(l.type) },
    { key: 'count', header: 'Count', align: 'right', sortValue: (l) => l.count, render: (l) => l.count },
    {
      key: 'total', header: 'Total', align: 'right',
      sortValue: (l) => l.totalMinor,
      render:    (l) => <span className={shared.money}>{formatMoney(l.totalMinor, data?.currency)}</span>,
    },
  ];

  const eventCols: Column<StatementEvent>[] = [
    { key: 'booked',    header: 'Booked',    sortValue: (e) => e.bookedAt ?? '', render: (e) => formatDate(e.bookedAt) },
    { key: 'type',      header: 'Type',      render: (e) => <Badge color="indigo">{titleCase(e.eventType)}</Badge> },
    { key: 'narrative', header: 'Narrative', render: (e) => e.narrative ?? '-' },
    { key: 'dir',       header: 'Dr/Cr',     align: 'center', render: (e) => <Badge color={e.direction === 'DR' ? 'blue' : 'teal'}>{e.direction}</Badge> },
    {
      key: 'amount', header: 'Amount', align: 'right',
      sortValue: (e) => e.amountMinor,
      render:    (e) => <span className={shared.money}>{formatMoney(e.amountMinor, e.currency || data?.currency)}</span>,
    },
  ];

  const verifCols: Column<VerificationItem>[] = [
    { key: 'key',       header: 'Item',      render: (i) => titleCase(i.itemKey) },
    {
      key: 'expected', header: 'Expected', align: 'right',
      render: (i) => i.expectedMinor != null
        ? <span className={shared.money}>{formatMoney(i.expectedMinor, data?.currency)}</span>
        : <span className={shared.cellSub}>—</span>,
    },
    {
      key: 'actual', header: 'Actual', align: 'right',
      render: (i) => i.actualMinor != null
        ? <span className={shared.money}>{formatMoney(i.actualMinor, data?.currency)}</span>
        : <span className={shared.cellSub}>—</span>,
    },
    {
      key: 'deviation', header: 'Deviation', align: 'right',
      render: (i) => i.deviationMinor != null
        ? <span className={shared.money}>{formatMoney(i.deviationMinor, data?.currency)}</span>
        : <span className={shared.cellSub}>—</span>,
    },
    {
      key: 'ok', header: 'Result', align: 'center',
      render: (i) => i.withinTolerance == null
        ? <span className={shared.cellSub}>—</span>
        : i.withinTolerance
          ? <Badge color="teal">Pass</Badge>
          : <Badge color="red">Fail</Badge>,
    },
    { key: 'note', header: 'Note', render: (i) => i.note ?? '-' },
  ];

  const verifications = verQuery.data?.verifications ?? [];

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      title={
        data
          ? <span>Statement <span className={shared.cellRef}>{data.reference}</span></span>
          : 'Statement'
      }
      description={
        data
          ? `${titleCase(data.status)} · ${data.currency} · ${formatPeriod(data.periodStart, data.periodEnd)}`
          : undefined
      }
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {isLoading ? (
        <PageLoader label="Loading statement…" />
      ) : !data ? (
        <EmptyState title="Statement not found" message="It may have been removed." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>

          {/* Summary grid */}
          <div className={styles.summaryGrid}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Balance</span>
              <span className={`${styles.summaryValue} ${shared.money}`}>
                {formatMoney(data.balanceMinor, data.currency)}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Events</span>
              <span className={styles.summaryValue}>{data.eventCount ?? events.length}</span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Period</span>
              <span className={styles.summaryValue}>
                {data.periodStart && data.periodEnd
                  ? periodLabel(data.periodStart, data.periodEnd)
                  : formatPeriod(data.periodStart, data.periodEnd)}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Status</span>
              <span><StatusPill status={data.status} metaColors={statusColors} /></span>
            </div>
          </div>

          {/* Transition actions */}
          {canWrite && (
            <div className={styles.transitions}>
              {nextStates.length > 0 ? (
                <>
                  <span className={shared.cellSub} style={{ fontSize: 'var(--text-xs)' }}>Advance:</span>
                  {nextStates.map((to) => (
                    <Button
                      key={to}
                      size="sm"
                      variant={to === 'DISPUTED' ? 'danger' : 'secondary'}
                      onClick={() => onTransitionClick(to)}
                      loading={transition.isPending && confirmTo === to}
                      disabled={transition.isPending && confirmTo !== to}
                    >
                      {actionLabel(to)}
                    </Button>
                  ))}
                </>
              ) : (
                <span className={shared.cellSub}>No further transitions available.</span>
              )}
            </div>
          )}

          {/* Tabs */}
          <Tabs tabs={drawerTabs} active={activeTab} onChange={setActiveTab} />

          {/* ── Overview tab ── */}
          {activeTab === 'overview' && (
            <>
              <section>
                <CardHeader
                  title="Statement lines"
                  subtitle="Grouped totals by financial event type (DR positive)."
                />
                <Table
                  columns={lineCols}
                  rows={linesByType}
                  rowKey={(l) => l.type}
                  empty={<EmptyState title="No lines" />}
                  skeletonRows={2}
                />
              </section>

              <section>
                <CardHeader
                  title="Financial events"
                  subtitle="Individual events captured on this statement."
                />
                <Table
                  columns={eventCols}
                  rows={events}
                  rowKey={(e) => e.id}
                  empty={<EmptyState title="No events" />}
                  skeletonRows={3}
                />
              </section>
            </>
          )}

          {/* ── SOA Verification tab ── */}
          {activeTab === 'soa' && (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <CardHeader
                title="SOA Verification"
                subtitle="Recompute expected figures from contract terms and flag deviations beyond tolerance."
              />

              {canWrite && (
                <div className={styles.verifyBar}>
                  <div className={shared.filter}>
                    <span className={shared.filterLabel}>Tolerance %</span>
                    <Input
                      type="number"
                      value={tolerancePct}
                      onChange={(e) => setTolerancePct(e.target.value)}
                      min={0}
                      max={100}
                      step={0.5}
                      style={{ width: 80 }}
                      aria-label="Tolerance percentage"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={doVerify}
                    loading={runVerify.isPending}
                  >
                    <ShieldCheck size={14} style={{ marginRight: 4 }} />
                    Run Verification
                  </Button>
                </div>
              )}

              {verQuery.isLoading ? (
                <PageLoader label="Loading verifications…" />
              ) : verifications.length === 0 ? (
                <EmptyState
                  title="No verifications yet"
                  message="Run a verification to check statement figures against contract terms."
                  icon={<ShieldCheck size={16} />}
                />
              ) : (
                <div className={styles.verifList}>
                  {verifications.map((v) => (
                    <div key={v.id} className={styles.verifRun}>
                      <div className={styles.verifHeader}>
                        <StatusPill status={v.status} metaColors={statusColors} />
                        <span className={shared.cellSub}>
                          {formatDateTime(v.createdAt)} · tolerance {v.tolerancePct}%
                        </span>
                      </div>
                      <Table
                        columns={verifCols}
                        rows={v.items}
                        rowKey={(i) => i.itemKey}
                        empty={<EmptyState title="No items" />}
                        skeletonRows={2}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmTo}
        onClose={() => setConfirmTo(null)}
        onConfirm={() => confirmTo && runTransition(confirmTo)}
        loading={transition.isPending}
        title={`Move to ${titleCase(confirmTo ?? '')}?`}
        confirmLabel={`Yes, ${actionLabel(confirmTo ?? '')}`}
        message={
          confirmTo === 'ISSUED'
            ? 'Issuing the statement spins off an AR/AP invoice. This is a material accounting action.'
            : 'Settling the statement records final settlement. This is a material accounting action.'
        }
      />
    </Modal>
  );
}
