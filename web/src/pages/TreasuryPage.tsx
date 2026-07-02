/**
 * Treasury, investments & tax (brief §9, §13). Two consoles: the investment
 * portfolio (holdings + a domain-computed summary with book-weighted yield and
 * unrealised P&L) and the tax/levy stack (configured levies + a live calculator
 * that runs the pure computeLevies engine on the server). Authoring is gated on
 * treasury:write. A Deals sub-ledger (Wave-2) exposes the CAPTURED→CONFIRMED→
 * SETTLED trade lifecycle with balanced GL settlement journals.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatNumber, formatPercent, formatDate, titleCase } from '../lib/format';
import {
  Hash, Wallet, TrendingUp, Plus, Percent, Sigma, Scale, Info,
  RefreshCw, ShoppingCart, CheckCheck, ArrowRightLeft,
} from 'lucide-react';
import shared from './shared.module.css';
import styles from './TreasuryPage.module.css';

interface Holding {
  id: string; portfolio: string; name: string; instrumentType: string; currency: string;
  faceValueMinor: number; bookValueMinor: number; marketValueMinor: number;
  couponRate?: number | null; maturityDate?: string | null; status: string;
}
interface Summary { currency: string; count: number; bookValueMinor: number; marketValueMinor: number; unrealisedMinor: number; accruedInterestMinor: number; bookYield: number }
interface Levy { id: string; code: string; name: string; jurisdiction?: string | null; rate: number; basis: string; active: boolean }
interface LevyResult { baseMinor: number; lines: { code: string; name?: string; rate: number; amountMinor: number }[]; totalLevyMinor: number; grossInclusiveMinor: number }
interface Trade {
  id: string; instrument: string; tradeType: 'BUY' | 'SELL';
  tradeDate?: string | null; settleDate?: string | null;
  quantity: number; priceMinor: number; grossMinor: number; feesMinor: number;
  currency: string; status: string; journalId?: string | null; createdAt?: string | null;
}

const INSTRUMENT_TYPES = ['BOND', 'BILL', 'EQUITY', 'CASH', 'FUND'] as const;

export function TreasuryPage() {
  const [tab, setTab] = useState('portfolio');
  return (
    <>
      <PageHeader
        title="Treasury"
        description="Investment portfolio, tax/levy stack and the dealing sub-ledger — valued and settled by pure, reconcilable engines."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Treasury' }]}
      />
      <Card padded={false}>
        <Tabs
          tabs={[
            { id: 'portfolio', label: 'Investments' },
            { id: 'trades', label: 'Deals' },
            { id: 'tax', label: 'Tax & levies' },
          ]}
          active={tab}
          onChange={setTab}
        />
        <div style={{ padding: 'var(--space-5)' }}>
          {tab === 'portfolio' && <Portfolio />}
          {tab === 'trades' && <Deals />}
          {tab === 'tax' && <TaxLevies />}
        </div>
      </Card>
    </>
  );
}

/* ----------------------------- Investments ----------------------------- */

function Portfolio() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('treasury:write');
  const toast = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const q = useQuery({
    queryKey: ['treasury-holdings'],
    queryFn: () => api<{ holdings: Holding[]; summaries: Summary[] }>('/api/treasury/holdings'),
  });

  const refreshPrices = async () => {
    setRefreshing(true);
    try {
      const r = await api<{ refreshed: number; source: string }>('/api/treasury/market-data/refresh', { body: {} });
      toast.success(`Refreshed ${r.refreshed} instrument price(s) from ${r.source}`);
      qc.invalidateQueries({ queryKey: ['treasury-holdings'] });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Market data refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  if (q.isLoading) return <PageLoader label="Loading portfolio…" />;
  const summary = q.data?.summaries[0];

  const cols: Column<Holding>[] = [
    { key: 'name', header: 'Holding', render: (h) => <span className={shared.cellMain}>{h.name}</span> },
    { key: 'type', header: 'Type', render: (h) => <Badge color="slate">{titleCase(h.instrumentType)}</Badge> },
    { key: 'coupon', header: 'Coupon', align: 'right', render: (h) => h.couponRate != null ? formatPercent(h.couponRate) : '-' },
    { key: 'maturity', header: 'Maturity', render: (h) => h.maturityDate ? formatDate(h.maturityDate) : '-' },
    { key: 'book', header: 'Book', align: 'right', sortValue: (h) => h.bookValueMinor, render: (h) => formatMoney(h.bookValueMinor, h.currency) },
    { key: 'market', header: 'Market', align: 'right', sortValue: (h) => h.marketValueMinor, render: (h) => formatMoney(h.marketValueMinor, h.currency) },
    { key: 'pnl', header: 'Unrealised', align: 'right', sortValue: (h) => h.marketValueMinor - h.bookValueMinor, render: (h) => {
      const d = h.marketValueMinor - h.bookValueMinor;
      return <span className={d >= 0 ? styles.pos : styles.neg}>{formatMoney(d, h.currency)}</span>;
    } },
  ];

  return (
    <div className={styles.stack}>
      {summary && (
        <div className={styles.kpiRow}>
          <KpiCard label="Book value" value={formatMoney(summary.bookValueMinor, summary.currency)} accent="var(--primary)" icon={<Wallet size={20} />} />
          <KpiCard label="Market value" value={formatMoney(summary.marketValueMinor, summary.currency)} accent="var(--accent-cyan)" icon={<TrendingUp size={20} />} />
          <KpiCard label="Unrealised P&L" value={formatMoney(summary.unrealisedMinor, summary.currency)} accent={summary.unrealisedMinor >= 0 ? 'var(--accent-emerald)' : 'var(--accent-rose)'} icon={<Plus size={20} />} />
          <KpiCard label="Book yield" value={formatPercent(summary.bookYield)} accent="var(--accent-violet)" icon={<Percent size={20} />} />
          <KpiCard label="Holdings" value={formatNumber(summary.count)} accent="var(--accent-orange)" icon={<Hash size={20} />} />
        </div>
      )}
      <Card padded={false}>
        <div className={shared.toolbar} style={{ padding: 'var(--space-4)' }}>
          <CardHeader title="Holdings" subtitle="Positions valued by the pure portfolio engine — book, market and unrealised P&L." />
          {canWrite && (
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="secondary" size="sm" onClick={refreshPrices} loading={refreshing} icon={<RefreshCw size={14} />} title="Refresh market prices from the mock provider (seam for a real feed)">
                Refresh prices
              </Button>
              <Button variant="primary" size="sm" onClick={() => setShowAdd(true)} icon={<Plus size={14} />}>
                Add holding
              </Button>
            </div>
          )}
        </div>
        <Table columns={cols} rows={q.data?.holdings} rowKey={(h) => h.id}
          empty={<EmptyState title="No holdings" message="No investment holdings have been recorded." icon={<Wallet size={16} />} />} />
      </Card>

      <AddHoldingModal open={showAdd} onClose={() => setShowAdd(false)} />
    </div>
  );
}

function AddHoldingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [portfolio, setPortfolio] = useState('GENERAL');
  const [instrumentType, setInstrumentType] = useState<typeof INSTRUMENT_TYPES[number]>('BOND');
  const [currency, setCurrency] = useState('USD');
  const [bookMajor, setBookMajor] = useState('');
  const [marketMajor, setMarketMajor] = useState('');
  const [couponPct, setCouponPct] = useState('');
  const [maturityDate, setMaturityDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (body: object) => api<{ id: string }>('/api/treasury/holdings', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['treasury-holdings'] });
    },
  });

  const reset = () => {
    setName(''); setPortfolio('GENERAL'); setInstrumentType('BOND');
    setCurrency('USD'); setBookMajor(''); setMarketMajor('');
    setCouponPct(''); setMaturityDate(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const bookValueMinor = Math.round((Number(bookMajor) || 0) * 100);
    const marketValueMinor = marketMajor ? Math.round((Number(marketMajor) || 0) * 100) : bookValueMinor;
    const couponRate = couponPct ? Number(couponPct) / 100 : null;
    try {
      const res = await add.mutateAsync({
        name: name.trim(),
        portfolio: portfolio.trim() || 'GENERAL',
        instrumentType,
        currency: currency.trim().toUpperCase(),
        bookValueMinor,
        marketValueMinor,
        faceValueMinor: bookValueMinor,
        couponRate: couponRate ?? undefined,
        maturityDate: maturityDate || undefined,
      });
      toast.success(`Holding recorded (id ${res.id.slice(0, 8)}…)`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add holding');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add holding"
      description="Record a new investment position. Values in major currency units (e.g. 1 000 000 = USD 1M)."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={!name.trim() || !currency.trim()}>
            Add holding
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <TextField label="Name / description" value={name} onChange={setName} required placeholder="e.g. US Treasury 4.25% 2035" hint="Descriptive name shown in the holdings table." />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <FormField label="Instrument type" required>
            <Select value={instrumentType} onChange={(e) => setInstrumentType(e.target.value as typeof INSTRUMENT_TYPES[number])}>
              {INSTRUMENT_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency" required hint="ISO 4217, e.g. USD">
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              maxLength={3}
              placeholder="USD"
              style={{ textTransform: 'uppercase' }}
            />
          </FormField>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <FormField label="Book value (major units)" required hint="Cost / amortised cost">
            <Input type="number" min="0" step="0.01" value={bookMajor} onChange={(e) => setBookMajor(e.target.value)} placeholder="1000000" />
          </FormField>
          <FormField label="Market value (major units)" hint="Mark-to-market; defaults to book value">
            <Input type="number" min="0" step="0.01" value={marketMajor} onChange={(e) => setMarketMajor(e.target.value)} placeholder="same as book" />
          </FormField>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <FormField label="Coupon rate (%)" hint="Annual coupon — bonds only">
            <Input type="number" min="0" max="100" step="0.001" value={couponPct} onChange={(e) => setCouponPct(e.target.value)} placeholder="4.25" />
          </FormField>
          <FormField label="Maturity date" hint="ISO date (YYYY-MM-DD) — bonds/bills only">
            <Input type="date" value={maturityDate} onChange={(e) => setMaturityDate(e.target.value)} />
          </FormField>
        </div>
        <TextField label="Portfolio" value={portfolio} onChange={setPortfolio} placeholder="GENERAL" hint="Portfolio bucket; defaults to GENERAL." />
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ----------------------------- Deals sub-ledger ----------------------------- */

function Deals() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('treasury:write');
  const toast = useToast();
  const qc = useQueryClient();
  const [showCapture, setShowCapture] = useState(false);

  const q = useQuery({
    queryKey: ['treasury-trades'],
    queryFn: () => api<{ trades: Trade[] }>('/api/treasury/trades'),
  });

  const confirm = useMutation({
    mutationFn: (id: string) => api<{ id: string; status: string }>(`/api/treasury/trades/${id}/confirm`, { body: {} }),
    onSuccess: (res) => {
      toast.success(`Trade confirmed (${res.id.slice(0, 8)}…)`);
      qc.invalidateQueries({ queryKey: ['treasury-trades'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Confirm failed'),
  });

  const settle = useMutation({
    mutationFn: (id: string) => api<{ id: string; status: string; journalId: string }>(`/api/treasury/trades/${id}/settle`, { body: {} }),
    onSuccess: (res) => {
      toast.success(`Trade settled — GL journal ${res.journalId?.slice(0, 8)}…`);
      qc.invalidateQueries({ queryKey: ['treasury-trades'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Settlement failed'),
  });

  const actionCol: Column<Trade> = {
    key: 'actions',
    header: '',
    render: (t: Trade) => (
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        {t.status === 'CAPTURED' && (
          <Button size="sm" variant="secondary" loading={confirm.isPending} onClick={() => confirm.mutate(t.id)} icon={<CheckCheck size={12} />}>
            Confirm
          </Button>
        )}
        {t.status === 'CONFIRMED' && (
          <Button size="sm" variant="primary" loading={settle.isPending} onClick={() => settle.mutate(t.id)} icon={<ArrowRightLeft size={12} />}>
            Settle
          </Button>
        )}
      </div>
    ),
  };

  const cols: Column<Trade>[] = [
    { key: 'instrument', header: 'Instrument', render: (t) => <span className={shared.cellMain}>{t.instrument}</span> },
    { key: 'type', header: 'Type', render: (t) => <Badge color={t.tradeType === 'BUY' ? 'blue' : 'teal'}>{t.tradeType}</Badge> },
    { key: 'qty', header: 'Qty', align: 'right', render: (t) => formatNumber(t.quantity) },
    { key: 'price', header: 'Price', align: 'right', render: (t) => formatMoney(t.priceMinor, t.currency) },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (t) => t.grossMinor, render: (t) => <span className={shared.money}>{formatMoney(t.grossMinor, t.currency)}</span> },
    { key: 'settle', header: 'Settle', render: (t) => t.settleDate ? formatDate(t.settleDate) : '-' },
    { key: 'status', header: 'Status', render: (t) => <Badge color={t.status === 'SETTLED' ? 'green' : t.status === 'CONFIRMED' ? 'blue' : 'gray'}>{titleCase(t.status)}</Badge> },
    ...(canWrite ? [actionCol] : []),
  ];

  return (
    <div className={styles.stack}>
      <Card padded={false}>
        <div className={shared.toolbar} style={{ padding: 'var(--space-4)' }}>
          <CardHeader
            title="Investment deals"
            subtitle="CAPTURED → CONFIRMED → SETTLED lifecycle; settlement books a balanced GL journal (Dr 1200 investments / Cr 1000 cash for buys)."
          />
          {canWrite && (
            <Button variant="primary" size="sm" onClick={() => setShowCapture(true)} icon={<ShoppingCart size={14} />}>
              Capture trade
            </Button>
          )}
        </div>
        <Table
          columns={cols}
          rows={q.data?.trades}
          loading={q.isLoading}
          rowKey={(t) => t.id}
          empty={<EmptyState title="No trades" message="Capture a buy or sell to start the dealing sub-ledger." icon={<ShoppingCart size={16} />} />}
        />
      </Card>
      <CaptureTradeModal open={showCapture} onClose={() => setShowCapture(false)} />
    </div>
  );
}

function CaptureTradeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();

  const [instrument, setInstrument] = useState('');
  const [tradeType, setTradeType] = useState<'BUY' | 'SELL'>('BUY');
  const [quantity, setQuantity] = useState('');
  const [priceMajor, setPriceMajor] = useState('');
  const [feesMajor, setFeesMajor] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [tradeDate, setTradeDate] = useState('');
  const [settleDate, setSettleDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const capture = useMutation({
    mutationFn: (body: object) => api<{ id: string; status: string; grossMinor: number }>('/api/treasury/trades', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['treasury-trades'] }),
  });

  const reset = () => {
    setInstrument(''); setTradeType('BUY'); setQuantity(''); setPriceMajor('');
    setFeesMajor(''); setCurrency('USD'); setTradeDate(''); setSettleDate(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    if (!qty || qty <= 0) { setError('Quantity must be positive'); return; }
    const priceMinor = Math.round((Number(priceMajor) || 0) * 100);
    const feesMinor = Math.round((Number(feesMajor) || 0) * 100);
    try {
      const res = await capture.mutateAsync({
        instrument: instrument.trim(),
        tradeType,
        quantity: qty,
        priceMinor,
        feesMinor,
        currency: currency.trim().toUpperCase(),
        tradeDate: tradeDate || undefined,
        settleDate: settleDate || undefined,
      });
      toast.success(`Trade captured — gross ${formatMoney(res.grossMinor, currency.trim().toUpperCase())} (${res.status})`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not capture trade');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Capture trade"
      description="Record a buy or sell. The trade enters CAPTURED status; confirm then settle to post a balanced GL journal."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={capture.isPending} disabled={!instrument.trim() || !quantity}>
            Capture
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 'var(--space-4)', alignItems: 'end' }}>
          <TextField label="Instrument" value={instrument} onChange={setInstrument} required placeholder="e.g. US-TBILL-2025-06" hint="Name / ISIN / ticker." />
          <FormField label="Side" required>
            <Select value={tradeType} onChange={(e) => setTradeType(e.target.value as 'BUY' | 'SELL')}>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </Select>
          </FormField>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)' }}>
          <FormField label="Quantity" required>
            <Input type="number" min="0.0001" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="10000" />
          </FormField>
          <FormField label="Price (major units)" required hint="Per unit, e.g. 98.50">
            <Input type="number" min="0" step="0.01" value={priceMajor} onChange={(e) => setPriceMajor(e.target.value)} placeholder="98.50" />
          </FormField>
          <FormField label="Currency" required>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} placeholder="USD" style={{ textTransform: 'uppercase' }} />
          </FormField>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)' }}>
          <FormField label="Fees (major units)" hint="Brokerage / settlement fees">
            <Input type="number" min="0" step="0.01" value={feesMajor} onChange={(e) => setFeesMajor(e.target.value)} placeholder="0" />
          </FormField>
          <FormField label="Trade date">
            <Input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} />
          </FormField>
          <FormField label="Settle date">
            <Input type="date" value={settleDate} onChange={(e) => setSettleDate(e.target.value)} />
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ----------------------------- Tax & levies ----------------------------- */

function TaxLevies() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('treasury:write');
  const toast = useToast();
  const qc = useQueryClient();
  const [showAddLevy, setShowAddLevy] = useState(false);
  const [baseMajor, setBaseMajor] = useState('1000000');
  const [result, setResult] = useState<LevyResult | null>(null);
  const [busy, setBusy] = useState(false);

  const levies = useQuery({ queryKey: ['treasury-levies'], queryFn: () => api<{ levies: Levy[] }>('/api/treasury/levies') });

  const compute = async () => {
    setBusy(true);
    try {
      const baseMinor = Math.round((Number(baseMajor) || 0) * 100);
      const r = await api<{ result: LevyResult }>('/api/treasury/levies/compute', { body: { baseMinor } });
      setResult(r.result);
    } finally {
      setBusy(false);
    }
  };

  if (levies.isLoading) return <PageLoader label="Loading levies…" />;

  const cols: Column<Levy>[] = [
    { key: 'code', header: 'Code', render: (l) => <span className={shared.cellRef}>{l.code}</span> },
    { key: 'name', header: 'Name', render: (l) => <span className={shared.cellMain}>{l.name}</span> },
    { key: 'jur', header: 'Jurisdiction', render: (l) => l.jurisdiction ?? '-' },
    { key: 'basis', header: 'Basis', render: (l) => titleCase(l.basis) },
    { key: 'rate', header: 'Rate', align: 'right', render: (l) => formatPercent(l.rate) },
    { key: 'active', header: 'Active', render: (l) => <Badge color={l.active ? 'green' : 'gray'}>{l.active ? 'Active' : 'Inactive'}</Badge> },
  ];

  return (
    <div className={styles.stack}>
      <Card padded={false}>
        <div className={shared.toolbar} style={{ padding: 'var(--space-4)' }}>
          <CardHeader title="Configured levies" subtitle="The active premium-tax and levy stack, by jurisdiction and basis." />
          {canWrite && (
            <Button variant="primary" size="sm" onClick={() => setShowAddLevy(true)} icon={<Plus size={14} />}>
              Add / update levy
            </Button>
          )}
        </div>
        <Table columns={cols} rows={levies.data?.levies} rowKey={(l) => l.id}
          empty={<EmptyState title="No levies" message="No tax levies are configured." icon={<Scale size={16} />} />} />
      </Card>

      <Card padded={false}>
        <CardHeader title="Levy calculator" subtitle="Apply the active levy stack to a premium base - lines reconcile to the total." />
        <div className={styles.calcForm}>
          <div className={styles.calcRow}>
            <div className={styles.baseField}>
              <FormField label="Premium base (major units)">
                <Input type="number" min="0" step="1000" value={baseMajor} onChange={(e) => setBaseMajor(e.target.value)} />
              </FormField>
            </div>
            <Button variant="primary" onClick={compute} loading={busy}>Compute levies</Button>
          </div>
          {result && (
            <>
              <div className={styles.kpiRow}>
                <KpiCard label="Base" value={formatMoney(result.baseMinor)} accent="var(--primary)" icon={<Wallet size={20} />} />
                <KpiCard label="Total levies" value={formatMoney(result.totalLevyMinor)} accent="var(--accent-orange)" icon={<Sigma size={20} />} />
                <KpiCard label="Gross inclusive" value={formatMoney(result.grossInclusiveMinor)} accent="var(--accent-emerald)" icon={<Scale size={20} />} />
              </div>
              <Table
                columns={[
                  { key: 'code', header: 'Levy', render: (l: LevyResult['lines'][number]) => <span className={shared.cellMain}>{l.name ?? l.code}</span> },
                  { key: 'rate', header: 'Rate', align: 'right', render: (l: LevyResult['lines'][number]) => formatPercent(l.rate) },
                  { key: 'amt', header: 'Amount', align: 'right', render: (l: LevyResult['lines'][number]) => <span className={shared.money}>{formatMoney(l.amountMinor)}</span> },
                ]}
                rows={result.lines}
                rowKey={(l) => l.code}
              />
            </>
          )}
          {!canWrite && (
            <p className={styles.note}><Info size={14} aria-hidden /> You have read-only treasury access; levy configuration requires the treasury:write permission.</p>
          )}
        </div>
      </Card>

      <AddLevyModal
        open={showAddLevy}
        onClose={() => setShowAddLevy(false)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['treasury-levies'] }); }}
      />
    </div>
  );
}

function AddLevyModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [ratePct, setRatePct] = useState('');
  const [basis, setBasis] = useState('premium');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const upsert = useMutation({
    mutationFn: (body: object) => api<{ id: string }>('/api/treasury/levies', { body }),
    onSuccess: onSaved,
  });

  const reset = () => {
    setCode(''); setName(''); setJurisdiction(''); setRatePct(''); setBasis('premium'); setActive(true); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const rate = Number(ratePct) / 100;
    if (isNaN(rate) || rate < 0) { setError('Rate must be a non-negative number'); return; }
    try {
      await upsert.mutateAsync({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        jurisdiction: jurisdiction.trim() || undefined,
        rate,
        basis: basis.trim() || 'premium',
        active,
      });
      toast.success(`Levy ${code.trim().toUpperCase()} saved (upsert)`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save levy');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Add / update levy"
      description="Insert or update a premium-tax or levy entry by code. The levy calculator uses the active set."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={upsert.isPending} disabled={!code.trim() || !name.trim()}>
            Save levy
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 'var(--space-4)' }}>
          <TextField label="Code" value={code} onChange={setCode} required placeholder="IPT_GB" hint="Unique code (upserted on conflict)." />
          <TextField label="Name" value={name} onChange={setName} required placeholder="UK Insurance Premium Tax" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)' }}>
          <FormField label="Rate (%)" required hint="e.g. 12 for 12%">
            <Input type="number" min="0" step="0.001" value={ratePct} onChange={(e) => setRatePct(e.target.value)} placeholder="12" />
          </FormField>
          <TextField label="Jurisdiction" value={jurisdiction} onChange={setJurisdiction} placeholder="GB" hint="Optional ISO country code." />
          <FormField label="Basis" hint="premium / gross_written_premium / etc.">
            <Input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="premium" />
          </FormField>
        </div>
        <FormField label="Active">
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Include in the active levy stack
          </label>
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
