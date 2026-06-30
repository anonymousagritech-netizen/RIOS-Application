import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select } from '../components/Form';
import { formatMoney, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './workspace.module.css';

/* ---------------- Types ---------------- */
interface TrialBalanceAccount {
  code: string;
  name: string;
  type: string;
  debitMinor: number;
  creditMinor: number;
}
interface TrialBalanceResponse {
  accounts: TrialBalanceAccount[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  balanced: boolean;
}
interface Invoice {
  id: string;
  reference: string;
  partyName: string;
  currency: string;
  amount_minor: number;
  settled_minor: number;
  due_date: string;
  status: string;
  overdue: boolean;
}
interface InvoicesResponse { invoices: Invoice[]; }
interface BankAccount {
  id: string;
  name: string;
  currency: string;
  balance_minor: number;
  iban: string;
}
interface BankAccountsResponse { accounts: BankAccount[]; }

/* ---------------- Data hooks ---------------- */
function useTrialBalance() {
  return useQuery({
    queryKey: ['finance', 'trial-balance'],
    queryFn: () => api<TrialBalanceResponse>('/api/finance/trial-balance'),
  });
}
function useArInvoices(status: string) {
  return useQuery({
    queryKey: ['finance', 'ar-invoices', status],
    queryFn: () => api<InvoicesResponse>(`/api/finance/ar-invoices${qs({ status: status || undefined })}`),
  });
}
function useApInvoices(status: string) {
  return useQuery({
    queryKey: ['finance', 'ap-invoices', status],
    queryFn: () => api<InvoicesResponse>(`/api/finance/ap-invoices${qs({ status: status || undefined })}`),
  });
}
function useBankAccounts() {
  return useQuery({
    queryKey: ['finance', 'bank-accounts'],
    queryFn: () => api<BankAccountsResponse>('/api/finance/bank-accounts'),
  });
}

interface CashBody {
  bankAccountId?: string;
  direction: 'IN' | 'OU';
  amount: number;
  currency: string;
  counterpartyId?: string;
  arInvoiceId?: string;
  apInvoiceId?: string;
  narrative?: string;
}
function usePostCash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CashBody) => api('/api/finance/cash', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance'] });
    },
  });
}

const INVOICE_STATUSES = ['', 'OPEN', 'PARTIAL', 'SETTLED', 'OVERDUE'];

const TABS = [
  { id: 'trial', label: 'Trial Balance' },
  { id: 'ar', label: 'Receivables' },
  { id: 'ap', label: 'Payables' },
  { id: 'bank', label: 'Bank' },
];

export function FinancePage() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState('trial');
  const canPost = hasPermission('finance:post');

  return (
    <>
      <PageHeader
        title="Finance"
        description="Ledger, receivables, payables and bank cash management."
        actions={
          canPost
            ? <Badge color="green">finance:post granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'trial' && <TrialBalanceTab />}
        {tab === 'ar' && <InvoicesTab kind="ar" canPost={canPost} />}
        {tab === 'ap' && <InvoicesTab kind="ap" canPost={canPost} />}
        {tab === 'bank' && <BankTab canPost={canPost} />}
      </Card>
    </>
  );
}

/* ---------------- Trial Balance ---------------- */
function TrialBalanceTab() {
  const { data, isLoading } = useTrialBalance();

  const columns: Column<TrialBalanceAccount>[] = [
    { key: 'code', header: 'Code', sortValue: (a) => a.code, render: (a) => <span className={shared.cellRef}>{a.code}</span> },
    { key: 'name', header: 'Account', sortValue: (a) => a.name, render: (a) => <span className={shared.cellMain}>{a.name}</span> },
    { key: 'type', header: 'Type', sortValue: (a) => a.type, render: (a) => titleCase(a.type) },
    { key: 'debit', header: 'Debit', align: 'right', sortValue: (a) => a.debitMinor, render: (a) => <span className={shared.money}>{a.debitMinor ? formatMoney(a.debitMinor) : '—'}</span> },
    { key: 'credit', header: 'Credit', align: 'right', sortValue: (a) => a.creditMinor, render: (a) => <span className={shared.money}>{a.creditMinor ? formatMoney(a.creditMinor) : '—'}</span> },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader title="Trial balance" subtitle="Aggregated ledger debits and credits across all accounts." />
      </div>
      {!isLoading && data && (
        <div className={styles.balanceBar}>
          <div className={styles.totals}>
            <div className={styles.total}>
              <span className={styles.totalLabel}>Total debit</span>
              <span className={styles.totalValue}>{formatMoney(data.totalDebitMinor)}</span>
            </div>
            <div className={styles.total}>
              <span className={styles.totalLabel}>Total credit</span>
              <span className={styles.totalValue}>{formatMoney(data.totalCreditMinor)}</span>
            </div>
          </div>
          <StatusPill
            status={data.balanced ? 'BALANCED' : 'UNBALANCED'}
            label={data.balanced ? 'Balanced ✓' : 'Unbalanced ✗'}
            metaColors={{ BALANCED: 'green', UNBALANCED: 'red' }}
          />
        </div>
      )}
      <Table
        columns={columns}
        rows={data?.accounts}
        loading={isLoading}
        rowKey={(a) => a.code}
        empty={<EmptyState title="No accounts" message="The general ledger has no posted entries yet." icon="$" />}
      />
    </>
  );
}

/* ---------------- AR / AP invoices ---------------- */
function InvoicesTab({ kind, canPost }: { kind: 'ar' | 'ap'; canPost: boolean }) {
  const [status, setStatus] = useState('');
  const ar = useArInvoices(status);
  const ap = useApInvoices(status);
  const { data, isLoading } = kind === 'ar' ? ar : ap;
  const [target, setTarget] = useState<Invoice | null>(null);

  const isAr = kind === 'ar';
  const actionLabel = isAr ? 'Receive cash' : 'Pay';

  const columns: Column<Invoice>[] = useMemo(() => {
    const cols: Column<Invoice>[] = [
      { key: 'reference', header: 'Reference', sortValue: (r) => r.reference, render: (r) => <span className={shared.cellRef}>{r.reference}</span> },
      { key: 'party', header: 'Counterparty', sortValue: (r) => r.partyName, render: (r) => <span className={shared.cellMain}>{r.partyName}</span> },
      { key: 'ccy', header: 'CCY', render: (r) => r.currency },
      { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amount_minor, render: (r) => <span className={shared.money}>{formatMoney(r.amount_minor, r.currency)}</span> },
      { key: 'settled', header: 'Settled', align: 'right', sortValue: (r) => r.settled_minor, render: (r) => <span className={shared.money}>{formatMoney(r.settled_minor, r.currency)}</span> },
      { key: 'due', header: 'Due', sortValue: (r) => r.due_date ?? '', render: (r) => formatDate(r.due_date) },
      {
        key: 'status', header: 'Status', sortValue: (r) => r.status,
        render: (r) => r.overdue
          ? <StatusPill status="OVERDUE" label="Overdue" metaColors={{ OVERDUE: 'red' }} />
          : <StatusPill status={r.status} />,
      },
    ];
    if (canPost) {
      cols.push({
        key: 'action', header: '', align: 'right',
        render: (r) => (
          <Button size="sm" variant="secondary" onClick={() => setTarget(r)}>{actionLabel}</Button>
        ),
      });
    }
    return cols;
  }, [canPost, actionLabel]);

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            {INVOICE_STATUSES.map((s) => <option key={s} value={s}>{s ? titleCase(s) : 'All'}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{data?.invoices.length ?? 0} result{(data?.invoices.length ?? 0) === 1 ? '' : 's'}</span>
      </div>
      <Table
        columns={columns}
        rows={data?.invoices}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty={<EmptyState title={`No ${isAr ? 'receivables' : 'payables'}`} message="No invoices match the current filter." icon="$" />}
      />
      <CashModal
        invoice={target}
        kind={kind}
        onClose={() => setTarget(null)}
      />
    </>
  );
}

function CashModal({ invoice, kind, onClose }: { invoice: Invoice | null; kind: 'ar' | 'ap'; onClose: () => void }) {
  const toast = useToast();
  const postCash = usePostCash();
  const [amount, setAmount] = useState('');
  const [narrative, setNarrative] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isAr = kind === 'ar';
  const reset = () => { setAmount(''); setNarrative(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!invoice) return;
    const amountNum = Number(amount);
    if (!amount || Number.isNaN(amountNum) || amountNum <= 0) {
      setError('Enter a positive amount in major units.');
      return;
    }
    const body: CashBody = {
      direction: isAr ? 'IN' : 'OU',
      amount: amountNum,
      currency: invoice.currency,
      narrative: narrative || undefined,
    };
    if (isAr) body.arInvoiceId = invoice.id;
    else body.apInvoiceId = invoice.id;
    try {
      await postCash.mutateAsync(body);
      toast.success(isAr ? 'Cash received' : 'Payment recorded');
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not post the cash movement.');
    }
  };

  return (
    <Modal
      open={!!invoice}
      onClose={close}
      title={isAr ? 'Receive cash' : 'Record payment'}
      description={invoice ? `${invoice.reference} · ${invoice.partyName}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={postCash.isPending} disabled={!amount.trim()}>
            {isAr ? 'Receive cash' : 'Pay'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {invoice && (
          <div className={shared.cellSub}>
            Outstanding: {formatMoney(invoice.amount_minor - invoice.settled_minor, invoice.currency)}
          </div>
        )}
        <FormField label="Amount" required hint={invoice ? `Major units of ${invoice.currency}.` : 'Major units.'}>
          <Input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 250000" />
        </FormField>
        <FormField label="Narrative">
          <Input value={narrative} onChange={(e) => setNarrative(e.target.value)} placeholder="Optional reference" />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Bank ---------------- */
function BankTab({ canPost }: { canPost: boolean }) {
  const { data, isLoading } = useBankAccounts();
  const toast = useToast();
  const qc = useQueryClient();
  const reconcile = useMutation({
    mutationFn: (id: string) => api(`/api/finance/cash/${id}/reconcile`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['finance'] });
      toast.success('Reconciliation triggered');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not reconcile.'),
  });

  const columns: Column<BankAccount>[] = [
    { key: 'name', header: 'Account', sortValue: (a) => a.name, render: (a) => <span className={shared.cellMain}>{a.name}</span> },
    { key: 'iban', header: 'IBAN', render: (a) => <span className={shared.cellRef}>{a.iban}</span> },
    { key: 'ccy', header: 'CCY', render: (a) => a.currency },
    { key: 'balance', header: 'Balance', align: 'right', sortValue: (a) => a.balance_minor, render: (a) => <span className={shared.money}>{formatMoney(a.balance_minor, a.currency)}</span> },
    ...(canPost ? [{
      key: 'action', header: '', align: 'right' as const,
      render: (a: BankAccount) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => reconcile.mutate(a.id)}
          loading={reconcile.isPending && reconcile.variables === a.id}
        >
          Reconcile
        </Button>
      ),
    }] : []),
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader title="Bank accounts" subtitle="Cash positions across settlement accounts." />
      </div>
      <Table
        columns={columns}
        rows={data?.accounts}
        loading={isLoading}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No bank accounts" message="Configure a settlement account to manage cash." icon="$" />}
      />
    </>
  );
}
