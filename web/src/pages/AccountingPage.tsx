import { useState } from 'react';
import {
  Banknote, BookOpen, Building2, Coins, FileText, Download, Send,
  ReceiptText, Scale, ListX,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  useTreaties, useStatusColors, useGlJournals, useTrialBalance,
  useUnpostedEvents, usePostAll,
} from '../lib/queries';
import { useAuth } from '../lib/auth';
import { downloadFile, qs } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { Input, Select } from '../components/Form';
import { AiActionPanel } from '../components/AiActionPanel';
import { formatDate, formatMoney, formatNumber, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { JournalEntry, UnpostedEvent, TrialBalanceRow } from '../lib/types';
import shared from './shared.module.css';
import styles from './AccountingPage.module.css';

// Current month helpers
function currentMonthFrom(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function currentMonthTo(): string {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

const PAGE_TABS = [
  { id: 'journals',       label: <span><ReceiptText size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Journal Entries</span> },
  { id: 'trial-balance',  label: <span><Scale size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Trial Balance</span> },
  { id: 'unposted',       label: <span><ListX size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Unposted Events</span> },
];

/**
 * Accounting workspace: GL journal drill-down, trial balance, and unposted event queue.
 * P2-05.
 */
export function AccountingPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const toast = useToast();

  const [tab, setTab] = useState('journals');

  // ── KPI data (treaty counts) ──────────────────────────────────────────────
  const { data: treatyData, isLoading: treatyLoading } = useTreaties({});
  const statusColors = useStatusColors('contract_status');

  const postable = (treatyData?.treaties ?? []).filter((t) =>
    ['BOUND', 'ACTIVE', 'EXPIRING', 'RUNOFF', 'COMMUTED'].includes(t.status),
  );
  const activeCount   = postable.filter((t) => ['BOUND', 'ACTIVE'].includes(t.status)).length;
  const cedentCount   = new Set(postable.map((t) => t.cedentName).filter(Boolean)).size;
  const currencyCount = new Set(postable.map((t) => t.currency)).size;

  return (
    <>
      <PageHeader
        title="Accounting"
        description="GL journal drill-down, trial balance, and unposted event queue."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Accounting' }]}
        actions={
          hasPermission('accounting:post')
            ? <Badge color="green">accounting:post granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <div className={styles.page}>
        <div className={styles.kpis}>
          <KpiCard label="Postable treaties"  value={formatNumber(postable.length)} hint="With a statement to reconcile" icon={<BookOpen size={20} />}  accent="var(--primary)"        loading={treatyLoading} />
          <KpiCard label="Bound & active"     value={formatNumber(activeCount)}     hint="Currently in force"           icon={<Banknote size={20} />}  accent="var(--accent-emerald)" loading={treatyLoading} />
          <KpiCard label="Cedents"            value={formatNumber(cedentCount)}     hint="Distinct cedents in scope"    icon={<Building2 size={20} />} accent="var(--accent-violet)" loading={treatyLoading} />
          <KpiCard label="Currencies"         value={formatNumber(currencyCount)}   hint="Settlement currencies"        icon={<Coins size={20} />}     accent="var(--accent-cyan)"   loading={treatyLoading} />
        </div>

        <AiActionPanel
          title="AI journal & balance validation"
          buttonLabel="AI insight"
          note="Uses the finance insight domain (technical result & combined ratio) as a book-level balance sanity check."
          insightDomain="finance"
          context={{ postableTreaties: postable.length, boundAndActive: activeCount, cedents: cedentCount, currencies: currencyCount }}
        />

        <Card padded={false}>
          <div className={styles.tabWrap}>
            <Tabs tabs={PAGE_TABS} active={tab} onChange={setTab} />
          </div>

          {tab === 'journals'      && <JournalTab navigate={navigate} statusColors={statusColors} />}
          {tab === 'trial-balance' && <TrialBalanceTab />}
          {tab === 'unposted'      && <UnpostedTab toast={toast} hasPostPermission={hasPermission('accounting:post')} navigate={navigate} />}
        </Card>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 1: Journal Entries
// ─────────────────────────────────────────────────────────────────────────────

interface JournalTabProps {
  navigate: ReturnType<typeof useNavigate>;
  statusColors: Record<string, string>;
}

function JournalTab({ navigate: _navigate }: JournalTabProps) {
  const [from, setFrom]           = useState('');
  const [to, setTo]               = useState('');
  const [treatyRef, setTreatyRef] = useState('');
  const [eventType, setEventType] = useState('');
  const [page, setPage]           = useState(0);
  const [downloading, setDownloading] = useState(false);

  const { data, isLoading } = useGlJournals({ from, to, treatyRef, eventType, page });
  const entries = data?.entries ?? [];

  const handleExport = async () => {
    setDownloading(true);
    try {
      await downloadFile(
        `/api/accounting/export.csv${qs({ from, to, treatyRef, eventType })}`,
        'gl-journal.csv',
      );
    } catch {
      // downloadFile throws on 4xx/5xx; swallow silently (the user sees no change)
    } finally {
      setDownloading(false);
    }
  };

  const cols: Column<JournalEntry>[] = [
    {
      key: 'journalRef',
      header: 'Journal Ref',
      render: (e) => <span className={shared.cellRef}>{e.journalReference ?? '—'}</span>,
    },
    {
      key: 'postedAt',
      header: 'Date',
      sortValue: (e) => e.postedAt,
      render: (e) => formatDate(e.postedAt),
    },
    {
      key: 'treatyRef',
      header: 'Treaty',
      render: (e) => e.treatyReference
        ? <span className={shared.cellRef}>{e.treatyReference}</span>
        : <span className={shared.cellSub}>—</span>,
    },
    {
      key: 'eventType',
      header: 'Event Type',
      render: (e) => e.eventType
        ? <span className={shared.cellMain}>{titleCase(e.eventType)}</span>
        : <span className={shared.cellSub}>—</span>,
    },
    {
      key: 'debitAccount',
      header: 'Dr Account',
      render: (e) => <span className={shared.cellRef}>{e.debitAccount ?? '—'}</span>,
    },
    {
      key: 'creditAccount',
      header: 'Cr Account',
      render: (e) => <span className={shared.cellRef}>{e.creditAccount ?? '—'}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (e) => e.amountMinor,
      render: (e) => <span className={shared.money}>{formatMoney(e.amountMinor, e.currency)}</span>,
    },
  ];

  return (
    <div>
      {/* Filter toolbar */}
      <div className={styles.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>From</span>
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} className={styles.dateInput} />
        </div>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>To</span>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} className={styles.dateInput} />
        </div>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Treaty Ref</span>
          <Input
            type="text"
            placeholder="e.g. CAT-001"
            value={treatyRef}
            onChange={(e) => { setTreatyRef(e.target.value); setPage(0); }}
            className={styles.refInput}
          />
        </div>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Event Type</span>
          <Select value={eventType} onChange={(e) => { setEventType(e.target.value); setPage(0); }}>
            <option value="">All types</option>
            <option value="DEPOSIT_PREMIUM">Deposit Premium</option>
            <option value="INSTALMENT_PREMIUM">Instalment Premium</option>
            <option value="ADJUSTMENT_PREMIUM">Adjustment Premium</option>
            <option value="REINSTATEMENT_PREMIUM">Reinstatement Premium</option>
            <option value="MINIMUM_PREMIUM">Minimum Premium</option>
            <option value="CEDING_COMMISSION">Ceding Commission</option>
            <option value="OVERRIDING_COMMISSION">Overriding Commission</option>
            <option value="PROFIT_COMMISSION">Profit Commission</option>
            <option value="BROKERAGE">Brokerage</option>
            <option value="TAX">Tax</option>
            <option value="PAID_LOSS">Paid Loss</option>
            <option value="CASH_LOSS">Cash Loss</option>
            <option value="RECOVERY">Recovery</option>
          </Select>
        </div>
        <span className={shared.spacer} />
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          loading={downloading}
          onClick={() => void handleExport()}
        >
          Export CSV
        </Button>
      </div>

      <Table
        columns={cols}
        rows={entries}
        loading={isLoading}
        rowKey={(e) => `${e.journalReference ?? ''}-${e.postedAt}-${e.debitAccount}-${e.amountMinor}`}
        empty={
          <EmptyState
            title="No journal entries"
            message="Post a treaty to the GL to see entries here."
            icon={<ReceiptText size={28} />}
          />
        }
      />

      {/* Pagination */}
      {(page > 0 || data?.hasMore) && (
        <div className={styles.pagination}>
          <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </Button>
          <span className={styles.pageNum}>Page {page + 1}</span>
          <Button variant="ghost" size="sm" disabled={!data?.hasMore} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 2: Trial Balance
// ─────────────────────────────────────────────────────────────────────────────

function TrialBalanceTab() {
  const [from, setFrom] = useState(currentMonthFrom());
  const [to, setTo]     = useState(currentMonthTo());

  const { data, isLoading } = useTrialBalance({ from, to });
  const rows = data?.rows ?? [];

  const totalDebit  = rows.reduce((s, r) => s + r.debitMinor, 0);
  const totalCredit = rows.reduce((s, r) => s + r.creditMinor, 0);
  const totalNet    = rows.reduce((s, r) => s + r.netMinor, 0);

  const cols: Column<TrialBalanceRow>[] = [
    {
      key: 'code',
      header: 'Account Code',
      sortValue: (r) => r.accountCode,
      render: (r) => <span className={shared.cellRef}>{r.accountCode}</span>,
    },
    {
      key: 'name',
      header: 'Account Name',
      sortValue: (r) => r.accountName,
      render: (r) => <span className={shared.cellMain}>{r.accountName}</span>,
    },
    {
      key: 'debits',
      header: 'Debits',
      align: 'right',
      sortValue: (r) => r.debitMinor,
      render: (r) => <span className={shared.money}>{formatMoney(r.debitMinor)}</span>,
    },
    {
      key: 'credits',
      header: 'Credits',
      align: 'right',
      sortValue: (r) => r.creditMinor,
      render: (r) => <span className={shared.money}>{formatMoney(r.creditMinor)}</span>,
    },
    {
      key: 'net',
      header: 'Net',
      align: 'right',
      sortValue: (r) => r.netMinor,
      render: (r) => (
        <span className={`${shared.money} ${r.netMinor < 0 ? styles.negative : ''}`}>
          {formatMoney(r.netMinor)}
        </span>
      ),
    },
  ];

  return (
    <div>
      {/* Period selector */}
      <div className={styles.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Period From</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={styles.dateInput} />
        </div>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Period To</span>
          <Input type="date" value={to}   onChange={(e) => setTo(e.target.value)}   className={styles.dateInput} />
        </div>
        {!isLoading && rows.length > 0 && (
          <div className={styles.tbBalance}>
            <span className={styles.tbBalanceLabel}>Period net:</span>
            <span className={`${shared.money} ${totalNet !== 0 ? styles.negative : styles.balanced}`}>
              {formatMoney(totalNet)}
            </span>
            {totalNet === 0 && <span className={styles.balancedBadge}>Balanced</span>}
          </div>
        )}
      </div>

      <Table
        columns={cols}
        rows={rows}
        loading={isLoading}
        rowKey={(r) => r.accountCode}
        empty={
          <EmptyState
            title="No balances for this period"
            message="Select a period that contains posted journal entries."
            icon={<Scale size={28} />}
          />
        }
      />

      {rows.length > 0 && (
        <div className={styles.tbTotals}>
          <span className={styles.tbTotalLabel}>Totals</span>
          <span className={shared.money}>{formatMoney(totalDebit)}</span>
          <span className={shared.money}>{formatMoney(totalCredit)}</span>
          <span className={`${shared.money} ${totalNet !== 0 ? styles.negative : ''}`}>{formatMoney(totalNet)}</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 3: Unposted Events
// ─────────────────────────────────────────────────────────────────────────────

interface UnpostedTabProps {
  toast: ReturnType<typeof useToast>;
  hasPostPermission: boolean;
  navigate: ReturnType<typeof useNavigate>;
}

function UnpostedTab({ toast, hasPostPermission, navigate }: UnpostedTabProps) {
  const { data, isLoading, refetch } = useUnpostedEvents();
  const postAll = usePostAll();
  const events = data?.events ?? [];

  const handlePostAll = async () => {
    try {
      const result = await postAll.mutateAsync();
      toast.success(`Posted ${result.posted} event(s) in ${result.journals} journal(s)`);
      void refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Post all failed');
    }
  };

  const cols: Column<UnpostedEvent>[] = [
    {
      key: 'contractRef',
      header: 'Treaty',
      render: (e) => (
        <span
          className={shared.linkCell}
          style={{ cursor: 'pointer' }}
          onClick={() => navigate(`/treaties/${e.contractId}`)}
        >
          {e.contractReference ?? e.contractName}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Treaty Name',
      render: (e) => <span className={shared.cellMain}>{e.contractName}</span>,
    },
    {
      key: 'eventType',
      header: 'Event Type',
      sortValue: (e) => e.eventType,
      render: (e) => <span>{titleCase(e.eventType)}</span>,
    },
    {
      key: 'direction',
      header: 'Dr/Cr',
      render: (e) => (
        <Badge color={e.direction === 'DR' ? 'blue' : 'green'}>{e.direction}</Badge>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (e) => e.amountMinor,
      render: (e) => <span className={shared.money}>{formatMoney(e.amountMinor, e.currency)}</span>,
    },
    {
      key: 'bookedAt',
      header: 'Booked',
      sortValue: (e) => e.bookedAt,
      render: (e) => formatDate(e.bookedAt),
    },
    {
      key: 'narrative',
      header: 'Narrative',
      render: (e) => <span className={shared.cellSub}>{e.narrative ?? '—'}</span>,
    },
  ];

  return (
    <div>
      <div className={styles.toolbar}>
        <span className={shared.cellSub}>
          {isLoading ? 'Loading…' : `${events.length} unposted event(s)`}
        </span>
        <span className={shared.spacer} />
        {hasPostPermission && (
          <Button
            variant="primary"
            size="sm"
            icon={<Send size={14} />}
            loading={postAll.isPending}
            disabled={events.length === 0 || isLoading}
            onClick={() => void handlePostAll()}
          >
            Post All
          </Button>
        )}
      </div>

      <Table
        columns={cols}
        rows={events}
        loading={isLoading}
        rowKey={(e) => e.id}
        onRowClick={(e) => navigate(`/treaties/${e.contractId}`)}
        empty={
          <EmptyState
            title="No unposted events"
            message="All financial events have been posted to the GL."
            icon={<FileText size={28} />}
          />
        }
      />
    </div>
  );
}
