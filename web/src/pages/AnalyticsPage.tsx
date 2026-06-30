/**
 * Analytics & data warehouse (brief §13). Two consoles over the pure engines:
 * a Pivot builder (pick a fact source, dimensions and measures; the server
 * aggregates with the @rios/domain pivot) and a Catastrophe console (real
 * per-event loss summary; assign an annual rate per event to compute AAL, the
 * EP curve and a PML profile — rates are explicit assumptions, never invented).
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Select, Input, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatNumber, formatPercent, titleCase } from '../lib/format';
import shared from './shared.module.css';

interface SourceMeta { key: string; label: string; dimensions: { key: string; label: string }[]; measures: { field: string; label: string }[] }
interface PivotCell { key: Record<string, unknown>; values: Record<string, number>; count: number }
interface PivotResult { source: string; dimensions: string[]; cells: PivotCell[]; totals: Record<string, number>; factCount: number }

export function AnalyticsPage() {
  const [tab, setTab] = useState('pivot');
  return (
    <>
      <PageHeader title="Analytics" description="Pivot the data warehouse and model catastrophe loss — built on pure, reconcilable engines." />
      <Card>
        <Tabs
          tabs={[{ id: 'pivot', label: 'Data warehouse' }, { id: 'cat', label: 'Catastrophe' }, { id: 'forecast', label: 'Forecast' }]}
          active={tab}
          onChange={setTab}
        />
        <div style={{ padding: 'var(--space-5)' }}>
          {tab === 'pivot' && <PivotBuilder />}
          {tab === 'cat' && <CatConsole />}
          {tab === 'forecast' && <ForecastConsole />}
        </div>
      </Card>
    </>
  );
}

/* ----------------------------- Pivot builder ----------------------------- */

function PivotBuilder() {
  const sources = useQuery({ queryKey: ['analytics-sources'], queryFn: () => api<{ sources: SourceMeta[] }>('/api/analytics/sources') });
  const [sourceKey, setSourceKey] = useState('claim');
  const [dimension, setDimension] = useState('');
  const [measureField, setMeasureField] = useState('');
  const [result, setResult] = useState<PivotResult | null>(null);
  const [busy, setBusy] = useState(false);

  const source = sources.data?.sources.find((s) => s.key === sourceKey);
  const dims = source?.dimensions ?? [];
  const measures = source?.measures ?? [];
  const activeDim = dimension || dims[0]?.key || '';
  const activeMeasure = measureField || measures[0]?.field || '';

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<PivotResult>('/api/analytics/pivot', {
        body: {
          source: sourceKey,
          dimensions: activeDim ? [activeDim] : [],
          measures: [{ field: activeMeasure, agg: 'sum', as: 'total' }, { agg: 'count' }],
        },
      });
      setResult(r);
    } finally {
      setBusy(false);
    }
  };

  if (sources.isLoading) return <PageLoader label="Loading sources…" />;

  const cols: Column<PivotCell>[] = [
    { key: 'dim', header: dims.find((d) => d.key === activeDim)?.label ?? 'Group', render: (c) => <span className={shared.cellMain}>{String(c.key[activeDim] ?? '—')}</span> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (c) => c.values.total ?? 0, render: (c) => formatMoney(c.values.total) },
    { key: 'count', header: 'Facts', align: 'right', render: (c) => formatNumber(c.count) },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 180 }}>
          <FormField label="Fact source">
            <Select value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setDimension(''); setMeasureField(''); setResult(null); }}>
              {sources.data?.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
          </FormField>
        </div>
        <div style={{ minWidth: 180 }}>
          <FormField label="Group by">
            <Select value={activeDim} onChange={(e) => setDimension(e.target.value)}>
              {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </Select>
          </FormField>
        </div>
        <div style={{ minWidth: 180 }}>
          <FormField label="Measure (sum)">
            <Select value={activeMeasure} onChange={(e) => setMeasureField(e.target.value)}>
              {measures.map((m) => <option key={m.field} value={m.field}>{m.label}</option>)}
            </Select>
          </FormField>
        </div>
        <Button variant="primary" onClick={run} loading={busy}>Run pivot</Button>
      </div>

      {result && (
        <>
          <div className={shared.kpiGrid}>
            <KpiCard label="Groups" value={formatNumber(result.cells.length)} icon="▦" />
            <KpiCard label="Facts" value={formatNumber(result.factCount)} icon="≡" />
            <KpiCard label="Grand total" value={formatMoney(result.totals.total)} icon="$" />
          </div>
          <Table columns={cols} rows={result.cells} rowKey={(c) => JSON.stringify(c.key)}
            empty={<EmptyState title="No facts" message="No rows match this source yet." />} />
        </>
      )}
    </div>
  );
}

/* ----------------------------- Catastrophe ----------------------------- */

interface CatEvent {
  id: string; eventCode: string; name: string; peril?: string | null; region?: string | null;
  eventDate?: string | null; status: string; claimCount: number;
  grossLossMinor: number; outstandingMinor: number; paidMinor: number;
}
interface EpPoint { lossMinor: number; rate: number; probability: number; returnPeriod: number }
interface Metrics { averageAnnualLossMinor: number; exceedanceCurve: EpPoint[]; pmlProfile: { returnPeriod: number; lossMinor: number }[] }

function CatConsole() {
  const events = useQuery({ queryKey: ['cat-events'], queryFn: () => api<{ events: CatEvent[] }>('/api/analytics/catastrophe/events') });
  // Per-event annual rate assumptions (λ). Default 0.04 ≈ a 1-in-25-year event.
  const [rates, setRates] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [busy, setBusy] = useState(false);

  const withLoss = useMemo(() => (events.data?.events ?? []).filter((e) => e.grossLossMinor > 0), [events.data]);

  const compute = async () => {
    setBusy(true);
    try {
      const elt = withLoss.map((e) => ({ id: e.eventCode, name: e.name, rate: Number(rates[e.id] ?? '0.04') || 0.04, lossMinor: e.grossLossMinor }));
      const r = await api<Metrics>('/api/analytics/catastrophe/metrics', { body: { elt, returnPeriods: [10, 25, 50, 100, 250] } });
      setMetrics(r);
    } finally {
      setBusy(false);
    }
  };

  if (events.isLoading) return <PageLoader label="Loading catastrophe events…" />;

  const eventCols: Column<CatEvent>[] = [
    { key: 'code', header: 'Event', render: (e) => <span className={shared.cellRef}>{e.eventCode}</span> },
    { key: 'name', header: 'Name', render: (e) => <span className={shared.cellMain}>{e.name}</span> },
    { key: 'peril', header: 'Peril', render: (e) => e.peril ?? '—' },
    { key: 'claims', header: 'Claims', align: 'right', render: (e) => formatNumber(e.claimCount) },
    { key: 'gross', header: 'Gross loss', align: 'right', sortValue: (e) => e.grossLossMinor, render: (e) => formatMoney(e.grossLossMinor) },
    {
      key: 'rate', header: 'Annual rate λ', align: 'right',
      render: (e) => (
        <Input
          type="number" step="0.01" min="0" style={{ width: 90, textAlign: 'right' }}
          value={rates[e.id] ?? '0.04'}
          onChange={(ev) => setRates((r) => ({ ...r, [e.id]: ev.target.value }))}
          disabled={e.grossLossMinor === 0}
        />
      ),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <p className={shared.cellSub}>
        Per-event losses are aggregated from real claims. Assign each event an annual occurrence rate (λ — e.g. 0.04 for a 1-in-25-year event)
        to compute the Average Annual Loss, exceedance-probability curve and PML profile. Rates are your modelling assumptions.
      </p>
      <Table columns={eventCols} rows={events.data?.events} rowKey={(e) => e.id}
        empty={<EmptyState title="No catastrophe events" message="No catastrophe events have been recorded." />} />
      <div>
        <Button variant="primary" onClick={compute} loading={busy} disabled={withLoss.length === 0}>Compute cat metrics</Button>
      </div>

      {metrics && (
        <>
          <div className={shared.kpiGrid}>
            <KpiCard label="Average Annual Loss" value={formatMoney(metrics.averageAnnualLossMinor)} icon="∑" accent="var(--c-amber)" />
            {metrics.pmlProfile.filter((p) => [50, 100, 250].includes(p.returnPeriod)).map((p) => (
              <KpiCard key={p.returnPeriod} label={`PML 1-in-${p.returnPeriod}`} value={formatMoney(p.lossMinor)} icon="◭" />
            ))}
          </div>

          <Card>
            <CardHeader title="Exceedance probability (OEP) curve" subtitle="Annual probability and return period at each modelled loss level." />
            <div style={{ padding: 'var(--space-4)' }}>
              <Table
                columns={[
                  { key: 'loss', header: 'Loss level', align: 'right', render: (p: EpPoint) => formatMoney(p.lossMinor) },
                  { key: 'prob', header: 'P(exceed / yr)', align: 'right', render: (p: EpPoint) => formatPercent(p.probability) },
                  { key: 'rp', header: 'Return period', align: 'right', render: (p: EpPoint) => Number.isFinite(p.returnPeriod) ? `1-in-${Math.round(p.returnPeriod)}` : '—' },
                ]}
                rows={metrics.exceedanceCurve}
                rowKey={(p) => String(p.lossMinor)}
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/* ----------------------------- Forecast ----------------------------- */

interface FitResult { slope: number; intercept: number; r2: number }
interface ForecastResponse { method: string; fit: FitResult; forecast: { index: number; value: number }[] }

function ForecastConsole() {
  const [series, setSeries] = useState('1200, 1350, 1290, 1480, 1600, 1720');
  const [method, setMethod] = useState('linear');
  const [periods, setPeriods] = useState('3');
  const [result, setResult] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setError(null);
    const nums = series.split(/[\s,]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (nums.length < 2) { setError('Enter at least two numeric data points.'); return; }
    setBusy(true);
    try {
      const r = await api<ForecastResponse>('/api/analytics/forecast', {
        body: { series: nums, periods: Math.max(1, Number(periods) || 3), method },
      });
      setResult(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 680 }}>
      <p className={shared.cellSub}>Project a metric forward from a historical series (e.g. monthly premium). Linear fits an OLS trend; smoothing uses exponential smoothing.</p>
      <FormField label="Historical series" error={error ?? undefined}>
        <Textarea rows={3} value={series} onChange={(e) => setSeries(e.target.value)} />
      </FormField>
      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 180 }}>
          <FormField label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="linear">Linear trend</option>
              <option value="smoothing">Exponential smoothing</option>
            </Select>
          </FormField>
        </div>
        <div style={{ width: 140 }}>
          <FormField label="Periods ahead">
            <Input type="number" min="1" max="60" value={periods} onChange={(e) => setPeriods(e.target.value)} />
          </FormField>
        </div>
        <Button variant="primary" onClick={run} loading={busy}>Forecast</Button>
      </div>
      {result && (
        <>
          <div className={shared.kpiGrid}>
            <KpiCard label="Trend slope" value={formatNumber(Math.round(result.fit.slope))} icon="↗" />
            <KpiCard label="Fit R²" value={formatPercent(result.fit.r2)} icon="◎" accent={result.fit.r2 >= 0.8 ? 'var(--c-green)' : 'var(--c-amber)'} />
          </div>
          <Table
            columns={[
              { key: 'period', header: 'Period ahead', render: (p: { index: number; value: number }) => `+${p.index - (result.forecast[0]!.index - 1)}` },
              { key: 'value', header: 'Forecast', align: 'right', render: (p: { index: number; value: number }) => formatNumber(p.value) },
            ]}
            rows={result.forecast}
            rowKey={(p) => String(p.index)}
          />
        </>
      )}
    </div>
  );
}
