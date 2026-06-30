import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, Input, Select } from '../components/Form';
import { formatMoney, formatDate, formatDateTime, titleCase } from '../lib/format';
import { CalendarCheck, DollarSign } from 'lucide-react';
import shared from './shared.module.css';
import styles from './PeriodClosePage.module.css';

/* ---------------- Types ---------------- */
interface AccountingPeriod {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
  closedBy: string | null;
  closedAt: string | null;
  createdAt: string;
}
interface FxDetail {
  currency: string;
  amountMinor: number;
  bookedRate: number;
  currentRate: number;
  atBookedMinor: number;
  atCurrentMinor: number;
  gainLossMinor: number;
}
interface FxRevaluation {
  id: string;
  asAt: string | null;
  baseCurrency: string;
  gainLossMinor: number;
  detail: FxDetail[];
  createdAt: string;
}
interface FxRevalueResult {
  id: string;
  gainLossMinor: number;
  detail: FxDetail[];
}

interface BalanceRow { currency: string; amount: string; bookedRate: string; currentRate: string; }

/* ---------------- Data hooks (local) ---------------- */
function usePeriods() {
  return useQuery({
    queryKey: ['finance', 'periods'],
    queryFn: () => api<{ periods: AccountingPeriod[] }>('/api/finance/periods'),
  });
}
function useRevaluations() {
  return useQuery({
    queryKey: ['finance', 'fx-revaluations'],
    queryFn: () => api<{ revaluations: FxRevaluation[] }>('/api/finance/fx-revaluations'),
  });
}
function useCreatePeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; startDate: string; endDate: string }) =>
      api<{ id: string; code: string; status: string }>('/api/finance/periods', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finance', 'periods'] }),
  });
}
function usePeriodAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'close' | 'reopen' }) =>
      api<{ id: string; status: string }>(`/api/finance/periods/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finance', 'periods'] }),
  });
}
function useFxRevalue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      baseCurrency: string;
      asAt?: string;
      balances: { currency: string; amount: number; bookedRate: number; currentRate: number }[];
    }) => api<FxRevalueResult>('/api/finance/fx-revalue', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['finance', 'fx-revaluations'] }),
  });
}

const TABS = [
  { id: 'periods', label: 'Periods' },
  { id: 'fx', label: 'FX revaluation' },
];

export function PeriodClosePage() {
  const { hasPermission } = useAuth();
  const canPost = hasPermission('finance:post');
  const [tab, setTab] = useState('periods');

  return (
    <>
      <PageHeader
        title="Period close"
        description="Open, close and reopen accounting periods, and run FX revaluation at period end."
        actions={canPost ? <Badge color="green">finance:post granted</Badge> : <Badge color="slate">read-only</Badge>}
      />

      <Card padded={false}>
        <div className={styles.tabBar}>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
        </div>
        {tab === 'periods' && <PeriodsTab canPost={canPost} />}
        {tab === 'fx' && <FxTab canPost={canPost} />}
      </Card>
    </>
  );
}

/* ---------------- Periods ---------------- */
function PeriodsTab({ canPost }: { canPost: boolean }) {
  const toast = useToast();
  const { data, isLoading } = usePeriods();
  const rows = data?.periods ?? [];
  const [showNew, setShowNew] = useState(false);
  const [closeTarget, setCloseTarget] = useState<AccountingPeriod | null>(null);
  const action = usePeriodAction();

  const runClose = async () => {
    if (!closeTarget) return;
    try {
      await action.mutateAsync({ id: closeTarget.id, action: 'close' });
      toast.success(`Period ${closeTarget.code} closed`);
      setCloseTarget(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not close the period.');
      setCloseTarget(null);
    }
  };

  const runReopen = async (p: AccountingPeriod) => {
    try {
      await action.mutateAsync({ id: p.id, action: 'reopen' });
      toast.success(`Period ${p.code} reopened`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reopen the period.');
    }
  };

  const columns: Column<AccountingPeriod>[] = [
    { key: 'code', header: 'Code', sortValue: (p) => p.code, render: (p) => <span className={shared.cellMain}>{p.code}</span> },
    { key: 'start', header: 'Start', sortValue: (p) => p.startDate, render: (p) => formatDate(p.startDate) },
    { key: 'end', header: 'End', sortValue: (p) => p.endDate, render: (p) => formatDate(p.endDate) },
    { key: 'status', header: 'Status', sortValue: (p) => p.status, render: (p) => <StatusPill status={p.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (p) =>
        canPost ? (
          <div className={`${shared.toolbar} ${styles.actionsEnd}`}>
            {p.status !== 'closed' && (
              <Button size="sm" variant="secondary" onClick={() => setCloseTarget(p)}>Close</Button>
            )}
            {p.status === 'closed' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => runReopen(p)}
                loading={action.isPending && action.variables?.id === p.id && action.variables.action === 'reopen'}
              >
                Reopen
              </Button>
            )}
          </div>
        ) : (
          <span className={shared.cellSub}>-</span>
        ),
    },
  ];

  return (
    <>
      <div className={`${shared.toolbar} ${styles.toolbarPad}`}>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} period{rows.length === 1 ? '' : 's'}</span>
        {canPost && (
          <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New period</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.periods}
        loading={isLoading}
        rowKey={(p) => p.id}
        empty={<EmptyState title="No periods" message="Open an accounting period to begin month-end close." icon={<CalendarCheck size={16} />} />}
      />

      <NewPeriodModal open={showNew} onClose={() => setShowNew(false)} />

      <ConfirmDialog
        open={!!closeTarget}
        onClose={() => setCloseTarget(null)}
        onConfirm={runClose}
        loading={action.isPending}
        title="Close period?"
        confirmLabel="Close period"
        message={closeTarget ? `Closing ${closeTarget.code} locks the period against further postings. It can be reopened with audit.` : ''}
      />
    </>
  );
}

function NewPeriodModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreatePeriod();
  const [code, setCode] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setCode(''); setStartDate(''); setEndDate(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !startDate || !endDate) { setError('Code, start and end dates are required.'); return; }
    try {
      const res = await create.mutateAsync({ code, startDate, endDate });
      toast.success(`Period ${res.code} opened`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the period.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New period"
      description="Open an accounting period for postings."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!code.trim() || !startDate || !endDate}>Open period</Button>
        </>
      }
    >
      <form onSubmit={submit} className={styles.modalForm}>
        <FormField label="Code" required hint="e.g. 2026-06 or 2026-Q2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="2026-06" />
        </FormField>
        <div className={`${shared.grid2} ${styles.fieldsGrid}`}>
          <FormField label="Start date" required>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </FormField>
          <FormField label="End date" required>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </FormField>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- FX revaluation ---------------- */
const FX_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD'];

function FxTab({ canPost }: { canPost: boolean }) {
  const toast = useToast();
  const revalue = useFxRevalue();
  const { data: pastData, isLoading: pastLoading } = useRevaluations();

  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [asAt, setAsAt] = useState('');
  const [balances, setBalances] = useState<BalanceRow[]>([
    { currency: 'EUR', amount: '', bookedRate: '', currentRate: '' },
  ]);
  const [result, setResult] = useState<FxRevalueResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setBalance = (i: number, key: keyof BalanceRow, v: string) => {
    setBalances((bs) => bs.map((b, idx) => (idx === i ? { ...b, [key]: v } : b)));
  };
  const addBalance = () => setBalances((bs) => [...bs, { currency: 'EUR', amount: '', bookedRate: '', currentRate: '' }]);
  const removeBalance = (i: number) => setBalances((bs) => bs.filter((_, idx) => idx !== i));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed: { currency: string; amount: number; bookedRate: number; currentRate: number }[] = [];
    for (const b of balances) {
      if (!b.currency && b.amount === '' && b.bookedRate === '' && b.currentRate === '') continue;
      const amount = Number(b.amount);
      const bookedRate = Number(b.bookedRate);
      const currentRate = Number(b.currentRate);
      if (!b.currency || Number.isNaN(amount) || Number.isNaN(bookedRate) || bookedRate <= 0 || Number.isNaN(currentRate) || currentRate <= 0) {
        setError('Each balance needs a currency, an amount (major units) and positive booked/current rates.');
        return;
      }
      parsed.push({ currency: b.currency, amount, bookedRate, currentRate });
    }
    if (!parsed.length) { setError('Add at least one non-base-currency balance.'); return; }
    try {
      const res = await revalue.mutateAsync({ baseCurrency, asAt: asAt || undefined, balances: parsed });
      setResult(res);
      toast.success('FX revaluation booked');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the revaluation.');
    }
  };

  const detailColumns: Column<FxDetail>[] = [
    { key: 'currency', header: 'CCY', render: (d) => d.currency },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (d) => d.amountMinor, render: (d) => <span className={shared.money}>{formatMoney(d.amountMinor, d.currency)}</span> },
    { key: 'booked', header: 'Booked rate', align: 'right', render: (d) => d.bookedRate },
    { key: 'current', header: 'Current rate', align: 'right', render: (d) => d.currentRate },
    { key: 'gl', header: 'Gain / loss', align: 'right', sortValue: (d) => d.gainLossMinor, render: (d) => <span className={shared.money}>{formatMoney(d.gainLossMinor, baseCurrency)}</span> },
  ];

  const pastColumns: Column<FxRevaluation>[] = [
    { key: 'asAt', header: 'As at', sortValue: (r) => r.asAt ?? '', render: (r) => formatDate(r.asAt) },
    { key: 'base', header: 'Base', sortValue: (r) => r.baseCurrency, render: (r) => r.baseCurrency },
    { key: 'gl', header: 'Gain / loss', align: 'right', sortValue: (r) => r.gainLossMinor, render: (r) => <span className={shared.money}>{formatMoney(r.gainLossMinor, r.baseCurrency)}</span> },
    { key: 'lines', header: 'Lines', align: 'right', render: (r) => (r.detail ?? []).length },
    { key: 'created', header: 'Created', sortValue: (r) => r.createdAt, render: (r) => formatDateTime(r.createdAt) },
  ];

  return (
    <div className={styles.fxBody}>
      <div>
        <CardHeader title="FX revaluation" subtitle="Restate non-base-currency balances at current rates and book the net gain or loss." />
        {!canPost && <p className={`${shared.cellSub} ${styles.readonlyNote}`}>You need finance:post to run a revaluation.</p>}
        <form onSubmit={submit} className={styles.fxForm}>
          <div className={`${shared.grid2} ${styles.fieldsGrid}`}>
            <FormField label="Base currency" required>
              <Select value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)} disabled={!canPost}>
                {FX_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </FormField>
            <FormField label="As at">
              <Input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} disabled={!canPost} />
            </FormField>
          </div>

          <FormField label="Balances" hint="Amounts in major units. Non-base-currency balances only; matching-base rows are ignored.">
            <div className={styles.balanceRows}>
              {balances.map((b, i) => (
                <div key={i} className={shared.toolbar}>
                  <Select value={b.currency} onChange={(e) => setBalance(i, 'currency', e.target.value)} disabled={!canPost} aria-label={`Balance ${i + 1} currency`}>
                    {FX_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                  <Input type="number" step="any" value={b.amount} onChange={(e) => setBalance(i, 'amount', e.target.value)} placeholder="Amount" aria-label={`Balance ${i + 1} amount`} className={styles.balanceInput} disabled={!canPost} />
                  <Input type="number" min="0" step="any" value={b.bookedRate} onChange={(e) => setBalance(i, 'bookedRate', e.target.value)} placeholder="Booked rate" aria-label={`Balance ${i + 1} booked rate`} className={styles.balanceInput} disabled={!canPost} />
                  <Input type="number" min="0" step="any" value={b.currentRate} onChange={(e) => setBalance(i, 'currentRate', e.target.value)} placeholder="Current rate" aria-label={`Balance ${i + 1} current rate`} className={styles.balanceInput} disabled={!canPost} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => removeBalance(i)} disabled={!canPost || balances.length <= 1}>Remove</Button>
                </div>
              ))}
              <div>
                <Button type="button" size="sm" variant="secondary" onClick={addBalance} disabled={!canPost}>Add balance</Button>
              </div>
            </div>
          </FormField>

          {error && <p className={styles.error} role="alert">{error}</p>}
          <div>
            <Button type="submit" variant="primary" loading={revalue.isPending} disabled={!canPost}>Run revaluation</Button>
          </div>
        </form>

        {result && (
          <Card padded>
            <CardHeader
              title="Result"
              subtitle="Net gain or loss in the base currency."
              actions={<span className={`${shared.money} ${styles.resultValue}`}>{formatMoney(result.gainLossMinor, baseCurrency)}</span>}
            />
            <Table
              columns={detailColumns}
              rows={result.detail ?? []}
              rowKey={(d) => d.currency}
              empty={<EmptyState title="No detail" message="No non-base balances were revalued." icon={<DollarSign size={16} />} />}
            />
          </Card>
        )}
      </div>

      <div>
        <CardHeader title="Past revaluations" subtitle="Previously booked FX revaluation runs." />
        <Table
          columns={pastColumns}
          rows={pastData?.revaluations}
          loading={pastLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No revaluations" message="No FX revaluations have been booked yet." icon={<DollarSign size={16} />} />}
        />
      </div>
    </div>
  );
}
