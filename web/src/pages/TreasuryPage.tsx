/**
 * Treasury, investments & tax (brief §9, §13). Two consoles: the investment
 * portfolio (holdings + a domain-computed summary with book-weighted yield and
 * unrealised P&L) and the tax/levy stack (configured levies + a live calculator
 * that runs the pure computeLevies engine on the server). Authoring is gated on
 * treasury:write.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Input } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatNumber, formatPercent, formatDate, titleCase } from '../lib/format';
import { Hash, Wallet, TrendingUp, Plus, Percent, Sigma, Scale, Info } from 'lucide-react';
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

export function TreasuryPage() {
  const [tab, setTab] = useState('portfolio');
  return (
    <>
      <PageHeader
        title="Treasury"
        description="Investment portfolio and the premium-tax / levy stack - valued by pure, reconcilable engines."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Treasury' }]}
      />
      <Card padded={false}>
        <Tabs tabs={[{ id: 'portfolio', label: 'Investments' }, { id: 'tax', label: 'Tax & levies' }]} active={tab} onChange={setTab} />
        <div style={{ padding: 'var(--space-5)' }}>
          {tab === 'portfolio' ? <Portfolio /> : <TaxLevies />}
        </div>
      </Card>
    </>
  );
}

/* ----------------------------- Investments ----------------------------- */

function Portfolio() {
  const q = useQuery({ queryKey: ['treasury-holdings'], queryFn: () => api<{ holdings: Holding[]; summaries: Summary[] }>('/api/treasury/holdings') });
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
        <CardHeader title="Holdings" subtitle="Positions valued by the pure portfolio engine - book, market and unrealised P&L." />
        <Table columns={cols} rows={q.data?.holdings} rowKey={(h) => h.id}
          empty={<EmptyState title="No holdings" message="No investment holdings have been recorded." icon={<Wallet size={16} />} />} />
      </Card>
    </div>
  );
}

/* ----------------------------- Tax & levies ----------------------------- */

function TaxLevies() {
  const { hasPermission } = useAuth();
  const levies = useQuery({ queryKey: ['treasury-levies'], queryFn: () => api<{ levies: Levy[] }>('/api/treasury/levies') });
  const [baseMajor, setBaseMajor] = useState('1000000');
  const [result, setResult] = useState<LevyResult | null>(null);
  const [busy, setBusy] = useState(false);

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
        <CardHeader title="Configured levies" subtitle="The active premium-tax and levy stack, by jurisdiction and basis." />
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
          {!hasPermission('treasury:write') && (
            <p className={styles.note}><Info size={14} aria-hidden /> You have read-only treasury access; levy configuration requires the treasury:write permission.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
