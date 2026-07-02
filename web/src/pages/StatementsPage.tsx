import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, Select } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { KpiCard } from '../components/KpiCard';
import { formatMoney, formatDate, formatNumber, titleCase } from '../lib/format';
import { ReceiptText, Scale, Hourglass, CheckCircle2 } from 'lucide-react';
import shared from './shared.module.css';
import styles from './StatementsPage.module.css';

/* ---------------- Types ---------------- */
interface TreatyOption { id: string; reference: string; name: string; }
interface TreatiesResponse { treaties: TreatyOption[]; }

interface StatementListItem {
  id: string;
  reference: string;
  contractId: string;
  currency: string;
  balanceMinor: number;
  status: string;
  issuedAt?: string | null;
}
interface StatementsResponse { statements: StatementListItem[]; }

interface StatementLine { type: string; count: number; totalMinor: number; }
interface StatementEvent {
  id: string;
  event_type: string;
  direction: string;
  amount_minor: number;
  currency: string;
  narrative?: string | null;
  booked_at?: string | null;
}
interface StatementDetail {
  id: string;
  reference: string;
  contract_id: string;
  currency: string;
  balance_minor: number;
  status: string;
  created_at?: string | null;
  lines?: StatementLine[];
  events?: StatementEvent[];
  eventCount?: number;
}
interface GenerateResult {
  id: string;
  reference: string;
  balanceMinor: number;
  currency: string;
  lines: StatementLine[];
  eventCount: number;
}

/* ---------------- Lifecycle ---------------- */
const LIFECYCLE = ['OPEN', 'PREPARED', 'UNDER_REVIEW', 'APPROVED', 'ISSUED', 'SETTLED', 'CLOSED'];

function legalNextStates(status: string): string[] {
  const idx = LIFECYCLE.indexOf(status);
  const next: string[] = [];
  const forward = idx >= 0 && idx < LIFECYCLE.length - 1 ? LIFECYCLE[idx + 1] : undefined;
  if (forward) next.push(forward);
  // DISPUTED branch from UNDER_REVIEW / ISSUED
  if (status === 'UNDER_REVIEW' || status === 'ISSUED') next.push('DISPUTED');
  return next;
}

/* ---------------- Local data hooks ---------------- */
function useTreatyOptions() {
  return useQuery({
    queryKey: ['statements', 'treaties'],
    queryFn: () => api<TreatiesResponse>(`/api/treaties${qs({})}`),
  });
}

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
    mutationFn: (body: { contractId: string; counterpartyId?: string; periodStart?: string; periodEnd?: string }) =>
      api<GenerateResult>('/api/statements/generate', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['statements', 'list'] }),
  });
}

function useTransitionStatement(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: string) => api<{ id: string; status: string }>(`/api/statements/${id}/transition`, { body: { to } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['statements', 'detail', id] });
      qc.invalidateQueries({ queryKey: ['statements', 'list'] });
    },
  });
}

const STATUSES = [...LIFECYCLE, 'DISPUTED'];

export function StatementsPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const canWrite = hasPermission('statement:write');
  const statusColors = useStatusColors('statement_status');

  const { data: treatyData } = useTreatyOptions();
  const treaties = treatyData?.treaties ?? [];

  const [contractId, setContractId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useStatements({
    contractId: contractId || undefined,
    status: statusFilter || undefined,
  });
  const generate = useGenerateStatement();

  const rows = data?.statements ?? [];

  const kpis = useMemo(() => {
    const settledSet = new Set(['SETTLED', 'CLOSED']);
    const inFlightSet = new Set(['PREPARED', 'UNDER_REVIEW', 'APPROVED', 'ISSUED']);
    let balance = 0;
    let inFlight = 0;
    let settled = 0;
    for (const s of rows) {
      balance += s.balanceMinor;
      if (inFlightSet.has(s.status)) inFlight += 1;
      if (settledSet.has(s.status)) settled += 1;
    }
    const ccy = rows[0]?.currency;
    return { count: rows.length, balance, inFlight, settled, ccy };
  }, [rows]);

  const doGenerate = async () => {
    if (!contractId) { toast.error('Pick a contract first'); return; }
    try {
      const res = await generate.mutateAsync({ contractId });
      toast.success(`Statement ${res.reference} generated - ${res.eventCount} event(s)`);
      setSelectedId(res.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(e.message || 'No un-statemented events for this contract');
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Could not generate statement');
      }
    }
  };

  const columns: Column<StatementListItem>[] = useMemo(() => [
    { key: 'reference', header: 'Reference', sortValue: (s) => s.reference, render: (s) => <span className={shared.cellRef}>{s.reference}</span> },
    { key: 'currency', header: 'CCY', render: (s) => s.currency },
    { key: 'balance', header: 'Balance', align: 'right', sortValue: (s) => s.balanceMinor, render: (s) => <span className={shared.money}>{formatMoney(s.balanceMinor, s.currency)}</span> },
    { key: 'issued', header: 'Issued', sortValue: (s) => s.issuedAt ?? '', render: (s) => formatDate(s.issuedAt) },
    { key: 'status', header: 'Status', align: 'right', sortValue: (s) => s.status, render: (s) => <StatusPill status={s.status} metaColors={statusColors} /> },
  ], [statusColors]);

  return (
    <>
      <PageHeader
        title="Statements"
        description="Generate statements of account from un-statemented financial events and drive them through the settlement lifecycle."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Statements' }]}
        actions={
          canWrite ? (
            <Button
              variant="primary"
              onClick={doGenerate}
              loading={generate.isPending}
              disabled={!contractId}
              title={contractId ? undefined : 'Select a contract to generate a statement'}
            >
              Generate statement
            </Button>
          ) : (
            <Badge color="slate">read-only</Badge>
          )
        }
      />

      <div className={styles.kpiRow}>
        <KpiCard label="Statements" value={formatNumber(kpis.count)} accent="var(--primary)" icon={<ReceiptText size={20} />} loading={isLoading} />
        <KpiCard label="Net balance" value={formatMoney(kpis.balance, kpis.ccy)} accent="var(--accent-cyan)" icon={<Scale size={20} />} loading={isLoading} />
        <KpiCard label="In flight" value={formatNumber(kpis.inFlight)} hint="Prepared through issued" accent="var(--accent-orange)" icon={<Hourglass size={20} />} loading={isLoading} />
        <KpiCard label="Settled" value={formatNumber(kpis.settled)} accent="var(--accent-emerald)" icon={<CheckCircle2 size={20} />} loading={isLoading} />
      </div>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Contract</span>
            <Select value={contractId} onChange={(e) => setContractId(e.target.value)} aria-label="Filter by contract">
              <option value="">All</option>
              {treaties.map((t) => (
                <option key={t.id} value={t.id}>{t.reference ? `${t.reference} - ${t.name}` : t.name}</option>
              ))}
            </Select>
          </div>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Status</span>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
        </div>

        <Table
          columns={columns}
          rows={rows}
          loading={isLoading}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/treaties/${s.contractId}?tab=statement`)}
          empty={<EmptyState title="No statements" message="Pick a contract and generate a statement from its un-statemented events." icon={<ReceiptText size={16} />} />}
        />
      </Card>

      <StatementDrawer
        id={selectedId}
        canWrite={canWrite}
        statusColors={statusColors}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}

function StatementDrawer({ id, canWrite, statusColors, onClose }: {
  id: string | null; canWrite: boolean; statusColors: Record<string, string>; onClose: () => void;
}) {
  const toast = useToast();
  const { data, isLoading } = useStatementDetail(id ?? undefined);
  const transition = useTransitionStatement(id ?? undefined);
  const [confirmTo, setConfirmTo] = useState<string | null>(null);

  const runTransition = async (to: string) => {
    try {
      const res = await transition.mutateAsync(to);
      toast.success(`Statement moved to ${titleCase(res.status)}`);
      if (res.status === 'ISSUED') {
        toast.success('An AR/AP invoice was created on issue');
      }
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

  const lines = data?.lines ?? [];
  const events = data?.events ?? [];
  const nextStates = data ? legalNextStates(data.status) : [];

  const lineCols: Column<StatementLine>[] = [
    { key: 'type', header: 'Line', render: (l) => titleCase(l.type) },
    { key: 'count', header: 'Count', align: 'right', sortValue: (l) => l.count, render: (l) => l.count },
    { key: 'total', header: 'Total', align: 'right', sortValue: (l) => l.totalMinor, render: (l) => <span className={shared.money}>{formatMoney(l.totalMinor, data?.currency)}</span> },
  ];

  const eventCols: Column<StatementEvent>[] = [
    { key: 'booked', header: 'Booked', sortValue: (e) => e.booked_at ?? '', render: (e) => formatDate(e.booked_at) },
    { key: 'type', header: 'Type', render: (e) => <Badge color="indigo">{titleCase(e.event_type)}</Badge> },
    { key: 'narrative', header: 'Narrative', render: (e) => e.narrative ?? '-' },
    { key: 'dir', header: 'Dr/Cr', align: 'center', render: (e) => <Badge color={e.direction === 'DR' ? 'blue' : 'teal'}>{e.direction}</Badge> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (e) => e.amount_minor, render: (e) => <span className={shared.money}>{formatMoney(e.amount_minor, e.currency || data?.currency)}</span> },
  ];

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      title={data ? <span>Statement <span className={shared.cellRef}>{data.reference}</span></span> : 'Statement'}
      description={data ? `${titleCase(data.status)} · ${data.currency}` : undefined}
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {isLoading ? (
        <PageLoader label="Loading statement…" />
      ) : !data ? (
        <EmptyState title="Statement not found" message="It may have been removed." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Balance</span>
              <span className={`${styles.summaryValue} ${shared.money}`}>
                {formatMoney(data.balance_minor, data.currency)}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Events</span>
              <span className={styles.summaryValue}>
                {data.eventCount ?? events.length}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryLabel}>Status</span>
              <span><StatusPill status={data.status} metaColors={statusColors} /></span>
            </div>
          </div>

          {canWrite && (
            <div className={styles.transitions}>
              {nextStates.length ? (
                nextStates.map((to) => (
                  <Button
                    key={to}
                    size="sm"
                    variant={to === 'DISPUTED' ? 'danger' : 'secondary'}
                    onClick={() => onTransitionClick(to)}
                    loading={transition.isPending && confirmTo === to}
                  >
                    {titleCase(to)}
                  </Button>
                ))
              ) : (
                <span className={shared.cellSub}>No further transitions available.</span>
              )}
            </div>
          )}

          <section>
            <CardHeader title="Statement lines" subtitle="Grouped by financial event type." />
            <Table columns={lineCols} rows={lines} rowKey={(l) => l.type} empty={<EmptyState title="No lines" />} skeletonRows={2} />
          </section>

          <section>
            <CardHeader title="Financial events" subtitle="Events captured on this statement." />
            <Table columns={eventCols} rows={events} rowKey={(e) => e.id} empty={<EmptyState title="No events" />} skeletonRows={2} />
          </section>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmTo}
        onClose={() => setConfirmTo(null)}
        onConfirm={() => confirmTo && runTransition(confirmTo)}
        loading={transition.isPending}
        title={`Move to ${titleCase(confirmTo ?? '')}?`}
        confirmLabel={`Yes, ${titleCase(confirmTo ?? '')}`}
        message={
          confirmTo === 'ISSUED'
            ? 'Issuing the statement spins off an AR/AP invoice. This is a material accounting action.'
            : 'Settling the statement records final settlement. This is a material accounting action.'
        }
      />
    </Modal>
  );
}
