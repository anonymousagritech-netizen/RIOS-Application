import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiUrl, qs, ApiError } from '../lib/api';
import { useStatusColors, useSoaEntries, useAddPremiumEntry, useAddClaimEntry } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, Select, Input, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { KpiCard } from '../components/KpiCard';
import { formatMoney, formatDate, formatNumber, titleCase } from '../lib/format';
import { ReceiptText, Scale, Hourglass, CheckCircle2, Download, Plus, FileText } from 'lucide-react';
import type { PremiumEntry, ClaimEntry } from '../lib/types';
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

      {/* SOA Entries panel — shown when a contract is selected */}
      {contractId && (
        <SoaEntriesPanel
          statementId={selectedId}
          contractId={contractId}
          canWritePremium={hasPermission('treaty:write')}
          canWriteClaim={hasPermission('claims:write')}
        />
      )}
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

/* ------------------------------------------------------------------ */
/* SOA Entries Panel (P3-B)                                             */
/* ------------------------------------------------------------------ */
const COB_LABELS: Record<string, string> = {
  MB: 'Marine (Bulk Cargo)', MLOP: 'Marine (Loss of Profit)', CPM: "Contractor's Plant & Machinery",
  DOS: 'Deterioration of Stock', EEI: 'Electronic Equipment', EAR: 'Erection All Risk',
  CAR: "Contractor's All Risk", BOILERS: 'Boilers & Pressure Vessels',
  ALOP: 'Advanced Loss of Profit', MEGA: 'Mega Risk', INWARD: 'Inward Facultative', OTHER: 'Other',
};

function cobLabel(code: string | null): string {
  if (!code) return 'Unclassified';
  return COB_LABELS[code] ?? code;
}

function SoaEntriesPanel({ statementId, contractId, canWritePremium, canWriteClaim }: {
  statementId: string | null;
  contractId: string;
  canWritePremium: boolean;
  canWriteClaim: boolean;
}) {
  // Use statementId for the entries endpoint; fall back to contractId-based stub when no statement selected
  const soaId = statementId;
  const { data, isLoading } = useSoaEntries(soaId ?? undefined);
  const toast = useToast();

  const [showPremForm, setShowPremForm] = useState(false);
  const [showClaimForm, setShowClaimForm] = useState(false);

  const premiumEntries = data?.premiumEntries ?? [];
  const claimEntries   = data?.claimEntries   ?? [];
  const summary        = data?.summary;

  // Group premium entries by class_of_business
  const premByCoB = useMemo(() => {
    const map = new Map<string, PremiumEntry[]>();
    for (const e of premiumEntries) {
      const key = e.classOfBusiness ?? 'OTHER';
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return map;
  }, [premiumEntries]);

  const premCols: Column<PremiumEntry>[] = [
    { key: 'policyNo',     header: 'Policy No',    render: (e) => <span className={shared.cellRef}>{e.policyNo ?? '-'}</span> },
    { key: 'insuredName',  header: 'Insured',       render: (e) => e.insuredName ?? '-' },
    { key: 'period',       header: 'Period',        render: (e) => e.periodFrom && e.periodTo ? `${e.periodFrom} / ${e.periodTo}` : '-' },
    { key: 'gross',        header: 'Gross Prem',    align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.grossPremiumMinor, e.currency)}</span> },
    { key: 'ri',           header: 'RI Prem',       align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.riPremiumMinor, e.currency)}</span> },
    { key: 'commission',   header: 'Commission',    align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.commissionMinor, e.currency)}</span> },
    { key: 'net',          header: 'Net Prem',      align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.netPremiumMinor, e.currency)}</span> },
  ];

  const claimCols: Column<ClaimEntry>[] = [
    { key: 'policyNo',   header: 'Policy No',   render: (e) => <span className={shared.cellRef}>{e.policyNo ?? '-'}</span> },
    { key: 'insured',    header: 'Insured',      render: (e) => e.insuredName ?? '-' },
    { key: 'dol',        header: 'Date of Loss', render: (e) => formatDate(e.dateOfLoss) },
    { key: 'cause',      header: 'Cause',        render: (e) => e.causeOfLoss ?? '-' },
    { key: 'gross',      header: 'Gross Loss',   align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.grossLossMinor, e.currency)}</span> },
    { key: 'ri',         header: 'RI Loss',      align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.riLossMinor, e.currency)}</span> },
    { key: 'outstanding',header: 'Outstanding',  align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.outstandingMinor, e.currency)}</span> },
    { key: 'paid',       header: 'Paid',         align: 'right', render: (e) => <span className={shared.money}>{formatMoney(e.paidMinor, e.currency)}</span> },
  ];

  if (!soaId) {
    return (
      <Card padded style={{ marginTop: 'var(--space-5)' }}>
        <EmptyState title="No statement selected" message="Select a statement above to view its SOA entries." icon={<FileText size={16} />} />
      </Card>
    );
  }

  return (
    <Card padded={false} style={{ marginTop: 'var(--space-5)' }}>
      <div style={{ padding: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-base)', flex: 1 }}>SOA Entries</span>
        {canWritePremium && (
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setShowPremForm(true)}>
            Add premium entry
          </Button>
        )}
        {canWriteClaim && (
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setShowClaimForm(true)}>
            Add claim entry
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Download size={14} />}
          onClick={() => window.open(apiUrl(`/api/statements/${soaId}/pdf`), '_blank')}
        >
          Download PDF
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<FileText size={14} />}
          onClick={() => toast.success('Generate & Issue is a planned capability (P3-C).')}
        >
          Generate &amp; Issue
        </Button>
      </div>

      {/* Summary row */}
      {summary && (
        <div className={styles.summaryGrid} style={{ margin: '0 var(--space-4) var(--space-4)' }}>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Gross Premium</span>
            <span className={`${styles.summaryValue} ${shared.money}`}>{formatMoney(summary.totalGrossPremiumMinor, 'USD')}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>RI Premium</span>
            <span className={`${styles.summaryValue} ${shared.money}`}>{formatMoney(summary.totalRiPremiumMinor, 'USD')}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Net Premium</span>
            <span className={`${styles.summaryValue} ${shared.money}`}>{formatMoney(summary.totalNetPremiumMinor, 'USD')}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Gross Loss</span>
            <span className={`${styles.summaryValue} ${shared.money}`}>{formatMoney(summary.totalGrossLossMinor, 'USD')}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>RI Loss</span>
            <span className={`${styles.summaryValue} ${shared.money}`}>{formatMoney(summary.totalRiLossMinor, 'USD')}</span>
          </div>
        </div>
      )}

      {/* CoB grid — premium entries grouped by class of business */}
      {isLoading ? (
        <PageLoader label="Loading entries…" />
      ) : premByCoB.size === 0 && claimEntries.length === 0 ? (
        <EmptyState
          title="No SOA entries"
          message="Add premium or claim entries to build this Statement of Account."
          icon={<ReceiptText size={16} />}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', padding: '0 0 var(--space-4)' }}>
          {/* Premium sections per CoB */}
          {Array.from(premByCoB.entries()).map(([cob, entries]) => (
            <section key={cob}>
              <CardHeader
                title={`Premium — ${cobLabel(cob)}`}
                subtitle={`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
              />
              <Table
                columns={premCols}
                rows={entries}
                rowKey={(e) => e.id}
                empty={<EmptyState title="No entries" />}
              />
            </section>
          ))}

          {/* Claim entries */}
          {claimEntries.length > 0 && (
            <section>
              <CardHeader title="Claims" subtitle={`${claimEntries.length} ${claimEntries.length === 1 ? 'entry' : 'entries'}`} />
              <Table
                columns={claimCols}
                rows={claimEntries}
                rowKey={(e) => e.id}
                empty={<EmptyState title="No claim entries" />}
              />
            </section>
          )}
        </div>
      )}

      {/* Add Premium Entry modal */}
      <AddPremiumEntryModal
        open={showPremForm}
        contractId={contractId}
        onClose={() => setShowPremForm(false)}
      />

      {/* Add Claim Entry modal */}
      <AddClaimEntryModal
        open={showClaimForm}
        contractId={contractId}
        onClose={() => setShowClaimForm(false)}
      />
    </Card>
  );
}

const COB_OPTIONS = [
  { code: 'MB',      label: 'Marine (Bulk Cargo)' },
  { code: 'MLOP',   label: 'Marine (Loss of Profit)' },
  { code: 'CPM',    label: "Contractor's Plant & Machinery" },
  { code: 'DOS',    label: 'Deterioration of Stock' },
  { code: 'EEI',    label: 'Electronic Equipment' },
  { code: 'EAR',    label: 'Erection All Risk' },
  { code: 'CAR',    label: "Contractor's All Risk" },
  { code: 'BOILERS',label: 'Boilers & Pressure Vessels' },
  { code: 'ALOP',   label: 'Advanced Loss of Profit' },
  { code: 'MEGA',   label: 'Mega Risk' },
  { code: 'INWARD', label: 'Inward Facultative' },
  { code: 'OTHER',  label: 'Other' },
];

function AddPremiumEntryModal({ open, contractId, onClose }: {
  open: boolean; contractId: string; onClose: () => void;
}) {
  const toast = useToast();
  const addEntry = useAddPremiumEntry(contractId);

  const [form, setForm] = useState({
    policyNo: '', insuredName: '', periodFrom: '', periodTo: '',
    sumInsuredMinor: '', grossPremiumMinor: '', riPremiumMinor: '',
    commissionMinor: '', netPremiumMinor: '', classOfBusiness: '', currency: 'USD', remarks: '',
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    try {
      await addEntry.mutateAsync({
        contractId,
        policyNo:           form.policyNo || undefined,
        insuredName:        form.insuredName || undefined,
        periodFrom:         form.periodFrom || undefined,
        periodTo:           form.periodTo || undefined,
        sumInsuredMinor:    form.sumInsuredMinor ? Math.round(parseFloat(form.sumInsuredMinor) * 100) : 0,
        grossPremiumMinor:  form.grossPremiumMinor ? Math.round(parseFloat(form.grossPremiumMinor) * 100) : 0,
        riPremiumMinor:     form.riPremiumMinor ? Math.round(parseFloat(form.riPremiumMinor) * 100) : 0,
        commissionMinor:    form.commissionMinor ? Math.round(parseFloat(form.commissionMinor) * 100) : 0,
        netPremiumMinor:    form.netPremiumMinor ? Math.round(parseFloat(form.netPremiumMinor) * 100) : 0,
        classOfBusiness:    form.classOfBusiness || undefined,
        currency:           form.currency || 'USD',
        remarks:            form.remarks || undefined,
      });
      toast.success('Premium entry added');
      onClose();
      setForm({ policyNo: '', insuredName: '', periodFrom: '', periodTo: '', sumInsuredMinor: '', grossPremiumMinor: '', riPremiumMinor: '', commissionMinor: '', netPremiumMinor: '', classOfBusiness: '', currency: 'USD', remarks: '' });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not add entry');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Premium Entry"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={addEntry.isPending}>Add entry</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <FormField label="Policy No"><Input value={form.policyNo} onChange={set('policyNo')} /></FormField>
          <FormField label="Insured Name"><Input value={form.insuredName} onChange={set('insuredName')} /></FormField>
          <FormField label="Period From"><Input type="date" value={form.periodFrom} onChange={set('periodFrom')} /></FormField>
          <FormField label="Period To"><Input type="date" value={form.periodTo} onChange={set('periodTo')} /></FormField>
          <FormField label="Sum Insured (major units)"><Input type="number" value={form.sumInsuredMinor} onChange={set('sumInsuredMinor')} min={0} /></FormField>
          <FormField label="Gross Premium (major units)"><Input type="number" value={form.grossPremiumMinor} onChange={set('grossPremiumMinor')} min={0} /></FormField>
          <FormField label="RI Premium (major units)"><Input type="number" value={form.riPremiumMinor} onChange={set('riPremiumMinor')} min={0} /></FormField>
          <FormField label="Commission (major units)"><Input type="number" value={form.commissionMinor} onChange={set('commissionMinor')} min={0} /></FormField>
          <FormField label="Net Premium (major units)"><Input type="number" value={form.netPremiumMinor} onChange={set('netPremiumMinor')} min={0} /></FormField>
          <FormField label="Class of Business">
            <Select value={form.classOfBusiness} onChange={set('classOfBusiness')}>
              <option value="">— select —</option>
              {COB_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency"><Input value={form.currency} onChange={set('currency')} maxLength={3} /></FormField>
        </div>
        <FormField label="Remarks"><Textarea value={form.remarks} onChange={set('remarks')} rows={2} /></FormField>
      </div>
    </Modal>
  );
}

function AddClaimEntryModal({ open, contractId, onClose }: {
  open: boolean; contractId: string; onClose: () => void;
}) {
  const toast = useToast();
  const addEntry = useAddClaimEntry(contractId);

  const [form, setForm] = useState({
    policyNo: '', insuredName: '', dateOfLoss: '', causeOfLoss: '',
    grossLossMinor: '', riLossMinor: '', outstandingMinor: '', paidMinor: '',
    classOfBusiness: '', currency: 'USD', remarks: '',
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    try {
      await addEntry.mutateAsync({
        contractId,
        policyNo:         form.policyNo || undefined,
        insuredName:      form.insuredName || undefined,
        dateOfLoss:       form.dateOfLoss || undefined,
        causeOfLoss:      form.causeOfLoss || undefined,
        grossLossMinor:   form.grossLossMinor ? Math.round(parseFloat(form.grossLossMinor) * 100) : 0,
        riLossMinor:      form.riLossMinor ? Math.round(parseFloat(form.riLossMinor) * 100) : 0,
        outstandingMinor: form.outstandingMinor ? Math.round(parseFloat(form.outstandingMinor) * 100) : 0,
        paidMinor:        form.paidMinor ? Math.round(parseFloat(form.paidMinor) * 100) : 0,
        classOfBusiness:  form.classOfBusiness || undefined,
        currency:         form.currency || 'USD',
        remarks:          form.remarks || undefined,
      });
      toast.success('Claim entry added');
      onClose();
      setForm({ policyNo: '', insuredName: '', dateOfLoss: '', causeOfLoss: '', grossLossMinor: '', riLossMinor: '', outstandingMinor: '', paidMinor: '', classOfBusiness: '', currency: 'USD', remarks: '' });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not add claim entry');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Claim Entry"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={addEntry.isPending}>Add entry</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <FormField label="Policy No"><Input value={form.policyNo} onChange={set('policyNo')} /></FormField>
          <FormField label="Insured Name"><Input value={form.insuredName} onChange={set('insuredName')} /></FormField>
          <FormField label="Date of Loss"><Input type="date" value={form.dateOfLoss} onChange={set('dateOfLoss')} /></FormField>
          <FormField label="Cause of Loss"><Input value={form.causeOfLoss} onChange={set('causeOfLoss')} /></FormField>
          <FormField label="Gross Loss (major units)"><Input type="number" value={form.grossLossMinor} onChange={set('grossLossMinor')} min={0} /></FormField>
          <FormField label="RI Loss (major units)"><Input type="number" value={form.riLossMinor} onChange={set('riLossMinor')} min={0} /></FormField>
          <FormField label="Outstanding (major units)"><Input type="number" value={form.outstandingMinor} onChange={set('outstandingMinor')} min={0} /></FormField>
          <FormField label="Paid (major units)"><Input type="number" value={form.paidMinor} onChange={set('paidMinor')} min={0} /></FormField>
          <FormField label="Class of Business">
            <Select value={form.classOfBusiness} onChange={set('classOfBusiness')}>
              <option value="">— select —</option>
              {COB_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency"><Input value={form.currency} onChange={set('currency')} maxLength={3} /></FormField>
        </div>
        <FormField label="Remarks"><Textarea value={form.remarks} onChange={set('remarks')} rows={2} /></FormField>
      </div>
    </Modal>
  );
}
