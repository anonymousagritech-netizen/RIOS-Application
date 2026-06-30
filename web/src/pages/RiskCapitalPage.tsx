/**
 * Risk & capital management + RDS (brief §13). Three consoles over the pure
 * @rios/domain engines: the capital position with an adequacy verdict, the
 * Realistic Disaster Scenario library (each netted to a post-event solvency
 * ratio), and a VaR / Tail-VaR calculator over a pasted loss sample.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Textarea, Input } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatNumber, formatDate } from '../lib/format';
import type { TokenColor } from '../lib/status';
import { Wallet, BookOpen, Plus, Percent, Gauge, TrendingDown, ShieldAlert, Sigma } from 'lucide-react';
import shared from './shared.module.css';
import styles from './RiskCapitalPage.module.css';

interface Position { asOfDate: string; currency: string; ownFundsMinor: number; scrMinor: number; mcrMinor: number; note?: string | null }
interface Adequacy { ownFundsMinor: number; scrMinor: number; solvencyRatio: number; surplusMinor: number; status: 'breach' | 'warning' | 'adequate' | 'strong' }
interface ScenarioResult { grossLossMinor: number; totalRecoveryMinor: number; netLossMinor: number; postEventOwnFundsMinor: number; postEventRatio: number }
interface Scenario { id: string; code: string; name: string; peril?: string | null; region?: string | null; currency: string; grossLossMinor: number; assumedRecoveryMinor: number; result: ScenarioResult }

const STATUS_COLOR: Record<Adequacy['status'], TokenColor> = { breach: 'red', warning: 'amber', adequate: 'blue', strong: 'green' };

function ratioLabel(r: number): string {
  return Number.isFinite(r) ? `${(r * 100).toFixed(0)}%` : '∞';
}

export function RiskCapitalPage() {
  const [tab, setTab] = useState('capital');
  return (
    <>
      <PageHeader
        title="Risk & capital"
        description="Capital adequacy, Realistic Disaster Scenarios and tail-risk - on pure, reconcilable engines."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Risk & capital' }]}
      />
      <Card padded={false}>
        <Tabs
          tabs={[{ id: 'capital', label: 'Capital adequacy' }, { id: 'rds', label: 'Disaster scenarios' }, { id: 'var', label: 'VaR calculator' }]}
          active={tab}
          onChange={setTab}
        />
        <div className={styles.tabBody}>
          {tab === 'capital' && <CapitalPanel />}
          {tab === 'rds' && <RdsPanel />}
          {tab === 'var' && <VarPanel />}
        </div>
      </Card>
    </>
  );
}

function CapitalPanel() {
  const q = useQuery({ queryKey: ['risk-capital'], queryFn: () => api<{ position: Position | null; adequacy: Adequacy | null }>('/api/risk/capital') });
  if (q.isLoading) return <PageLoader label="Loading capital position…" />;
  const { position, adequacy } = q.data ?? {};
  if (!position || !adequacy) return <EmptyState title="No capital position" message="No capital position has been recorded yet." />;

  return (
    <div className={styles.panel}>
      <div className={styles.kpiRow}>
        <KpiCard label="Own funds" value={formatMoney(position.ownFundsMinor, position.currency)} hint={position.currency} icon={<Wallet size={20} />} accent="var(--primary)" />
        <KpiCard label="SCR" value={formatMoney(position.scrMinor, position.currency)} hint="Solvency capital req." icon={<BookOpen size={20} />} accent="var(--accent-violet)" />
        <KpiCard label="Surplus" value={formatMoney(adequacy.surplusMinor, position.currency)} hint={adequacy.surplusMinor >= 0 ? 'Above requirement' : 'Below requirement'} accent={adequacy.surplusMinor >= 0 ? 'var(--c-green)' : 'var(--c-red)'} icon={<Plus size={20} />} />
        <KpiCard label="Solvency ratio" value={ratioLabel(adequacy.solvencyRatio)} hint="Own funds / SCR" icon={<Percent size={20} />} accent={`var(--c-${STATUS_COLOR[adequacy.status]})`} />
        <KpiCard label="MCR" value={formatMoney(position.mcrMinor, position.currency)} hint="Minimum capital req." icon={<Gauge size={20} />} accent="var(--accent-cyan)" />
      </div>
      <div className={styles.statusBar}>
        <Badge color={STATUS_COLOR[adequacy.status]}>{adequacy.status.toUpperCase()}</Badge>
        <span className={shared.cellSub}>As of {formatDate(position.asOfDate)}{position.note ? ` · ${position.note}` : ''}</span>
      </div>
    </div>
  );
}

function RdsPanel() {
  const q = useQuery({ queryKey: ['risk-scenarios'], queryFn: () => api<{ scenarios: Scenario[]; capital: Position | null }>('/api/risk/scenarios') });
  if (q.isLoading) return <PageLoader label="Loading scenarios…" />;

  const cols: Column<Scenario>[] = [
    { key: 'code', header: 'Scenario', render: (s) => <span className={shared.cellRef}>{s.code}</span> },
    { key: 'name', header: 'Name', render: (s) => <span className={shared.cellMain}>{s.name}</span> },
    { key: 'peril', header: 'Peril', render: (s) => s.peril ?? '-' },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (s) => s.grossLossMinor, render: (s) => formatMoney(s.grossLossMinor, s.currency) },
    { key: 'recovery', header: 'Recovery', align: 'right', render: (s) => formatMoney(s.result.totalRecoveryMinor, s.currency) },
    { key: 'net', header: 'Net loss', align: 'right', sortValue: (s) => s.result.netLossMinor, render: (s) => <strong>{formatMoney(s.result.netLossMinor, s.currency)}</strong> },
    {
      key: 'post', header: 'Post-event ratio', align: 'right',
      render: (s) => {
        const r = s.result.postEventRatio;
        const color = r < 1 ? 'var(--c-red)' : r < 1.25 ? 'var(--c-amber)' : 'var(--c-green)';
        return <span style={{ color }}>{ratioLabel(r)}</span>;
      },
    },
  ];

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        Each scenario's prescribed gross loss is netted by its assumed reinsurance recovery, then absorbed against current own funds to project the post-event solvency ratio.
      </p>
      <Card padded={false}>
        <div className={shared.tableWrap} style={{ paddingBottom: 0 }}>
          <CardHeader title="Realistic Disaster Scenarios" subtitle="Prescribed gross losses netted to a post-event solvency ratio." />
        </div>
        <Table columns={cols} rows={q.data?.scenarios} rowKey={(s) => s.id}
          empty={<EmptyState title="No scenarios" message="No Realistic Disaster Scenarios have been defined." icon={<ShieldAlert size={16} />} />} />
      </Card>
    </div>
  );
}

interface VarResult { confidence: number; sampleSize: number; valueAtRiskMinor: number; tailValueAtRiskMinor: number }

function VarPanel() {
  const [sample, setSample] = useState('100, 250, 400, 600, 900, 1300, 1800, 2500, 4000, 8000');
  const [confidence, setConfidence] = useState('0.99');
  const [result, setResult] = useState<VarResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const compute = async () => {
    setError(null);
    const losses = sample.split(/[\s,]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (losses.length === 0) { setError('Enter at least one numeric loss value.'); return; }
    setBusy(true);
    try {
      const r = await api<VarResult>('/api/risk/var', { body: { losses, confidence: Number(confidence) || 0.99 } });
      setResult(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.varPanel}>
      <p className={styles.intro}>Paste a loss sample (the loss in whole units per simulated year/event). VaR and Tail-VaR are computed empirically.</p>
      <FormField label="Loss sample" error={error ?? undefined}>
        <Textarea rows={3} value={sample} onChange={(e) => setSample(e.target.value)} />
      </FormField>
      <div className={styles.varControls}>
        <div className={styles.confField}>
          <FormField label="Confidence">
            <Input type="number" min="0" max="1" step="0.005" value={confidence} onChange={(e) => setConfidence(e.target.value)} />
          </FormField>
        </div>
        <Button variant="primary" onClick={compute} loading={busy}>Compute VaR</Button>
      </div>
      {result && (
        <div className={styles.kpiRow}>
          <KpiCard label={`VaR @ ${ratioLabel(result.confidence)}`} value={formatNumber(result.valueAtRiskMinor)} icon={<ShieldAlert size={20} />} accent="var(--c-amber)" />
          <KpiCard label={`Tail-VaR @ ${ratioLabel(result.confidence)}`} value={formatNumber(result.tailValueAtRiskMinor)} icon={<TrendingDown size={20} />} accent="var(--c-red)" />
          <KpiCard label="Sample size" value={formatNumber(result.sampleSize)} icon={<Sigma size={20} />} />
        </div>
      )}
    </div>
  );
}
