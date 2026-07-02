/**
 * Analytics & data warehouse (brief §13). Two consoles over the pure engines:
 * a Pivot builder (pick a fact source, dimensions and measures; the server
 * aggregates with the @rios/domain pivot) and a Catastrophe console (real
 * per-event loss summary; assign an annual rate per event to compute AAL, the
 * EP curve and a PML profile - rates are explicit assumptions, never invented).
 */

import { Columns3, DollarSign, Grid2x2, Hash, Sigma, Target, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { FormField, Select, Input, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatNumber, formatPercent, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './AnalyticsPage.module.css';

interface SourceMeta { key: string; label: string; dimensions: { key: string; label: string }[]; measures: { field: string; label: string }[] }
interface PivotCell { key: Record<string, unknown>; values: Record<string, number>; count: number }
interface PivotResult { source: string; dimensions: string[]; cells: PivotCell[]; totals: Record<string, number>; factCount: number }
interface GridRow { row: string; cells: Record<string, number>; total: number; count: number }
interface GridResult {
  source: string; rowDimension: string; columnDimension: string;
  measure: { field?: string; agg: string };
  columns: string[]; rows: GridRow[];
  columnTotals: Record<string, number>; grandTotal: number; factCount: number;
}

export function AnalyticsPage() {
  const [tab, setTab] = useState('pivot');
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Pivot the data warehouse and model catastrophe loss - built on pure, reconcilable engines."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Analytics' }]}
        actions={<Badge color="indigo">Reconcilable engines</Badge>}
      />
      <Card>
        <Tabs
          tabs={[{ id: 'pivot', label: 'Data warehouse' }, { id: 'reports', label: 'Reports' }, { id: 'dashboards', label: 'Dashboards' }, { id: 'cat', label: 'Catastrophe' }, { id: 'forecast', label: 'Forecast' }]}
          active={tab}
          onChange={setTab}
        />
        <div className={styles.tabBody}>
          {tab === 'pivot' && <PivotBuilder />}
          {tab === 'reports' && <ReportsConsole />}
          {tab === 'dashboards' && <DashboardsConsole />}
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
  const [rowDim, setRowDim] = useState('');
  const [colDim, setColDim] = useState('');
  const [measureField, setMeasureField] = useState('');
  const [agg, setAgg] = useState<'sum' | 'avg' | 'count'>('sum');
  const [result, setResult] = useState<GridResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = sources.data?.sources.find((s) => s.key === sourceKey);
  const dims = source?.dimensions ?? [];
  const measures = source?.measures ?? [];
  const activeRow = rowDim || dims[0]?.key || '';
  // Default the column dimension to a different one so the grid is genuinely 2-D.
  const activeCol = colDim || dims.find((d) => d.key !== activeRow)?.key || '';
  const activeMeasure = measureField || measures[0]?.field || '';
  const needsField = agg !== 'count';

  const run = async () => {
    setError(null);
    if (activeRow === activeCol) { setError('Pick two different dimensions for the rows and columns.'); return; }
    setBusy(true);
    try {
      const r = await api<GridResult>('/api/analytics/grid', {
        body: {
          source: sourceKey,
          rowDimension: activeRow,
          columnDimension: activeCol,
          measure: needsField ? { field: activeMeasure, agg } : { agg },
        },
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not run the pivot.');
    } finally {
      setBusy(false);
    }
  };

  if (sources.isLoading) return <PageLoader label="Loading sources…" />;

  // Money measures are minor units; count/plain measures render as numbers.
  const isMoney = (result?.measure.agg ?? '') !== 'count' && /Minor$/.test(result?.measure.field ?? '');
  const fmt = (v: number) => (isMoney ? formatMoney(v) : formatNumber(v));
  const dimLabel = (key: string) => dims.find((d) => d.key === key)?.label ?? key;

  return (
    <div className={styles.stack5}>
      <div className={styles.toolbar}>
        <div className={styles.field}>
          <FormField label="Fact source">
            <Select value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setRowDim(''); setColDim(''); setMeasureField(''); setResult(null); }}>
              {sources.data?.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
          </FormField>
        </div>
        <div className={styles.field}>
          <FormField label="Rows">
            <Select value={activeRow} onChange={(e) => setRowDim(e.target.value)}>
              {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </Select>
          </FormField>
        </div>
        <div className={styles.field}>
          <FormField label="Columns">
            <Select value={activeCol} onChange={(e) => setColDim(e.target.value)}>
              {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </Select>
          </FormField>
        </div>
        <div className={styles.field}>
          <FormField label="Aggregation">
            <Select value={agg} onChange={(e) => setAgg(e.target.value as 'sum' | 'avg' | 'count')}>
              <option value="sum">Sum</option>
              <option value="avg">Average</option>
              <option value="count">Count</option>
            </Select>
          </FormField>
        </div>
        {needsField && (
          <div className={styles.field}>
            <FormField label="Measure">
              <Select value={activeMeasure} onChange={(e) => setMeasureField(e.target.value)}>
                {measures.map((m) => <option key={m.field} value={m.field}>{m.label}</option>)}
              </Select>
            </FormField>
          </div>
        )}
        <Button variant="primary" onClick={run} loading={busy}>Run pivot</Button>
      </div>
      {error && <p className={shared.cellSub} style={{ color: 'var(--danger)' }}>{error}</p>}

      {result && (
        result.rows.length === 0 ? (
          <EmptyState title="No facts" message="No rows match this source yet." />
        ) : (
          <>
            <div className={shared.kpiGrid}>
              <KpiCard label="Rows" value={formatNumber(result.rows.length)} icon={<Grid2x2 size={20} />} accent="var(--primary)" />
              <KpiCard label="Columns" value={formatNumber(result.columns.length)} icon={<Columns3 size={20} />} accent="var(--accent-violet)" />
              <KpiCard label="Facts" value={formatNumber(result.factCount)} icon={<Hash size={20} />} accent="var(--accent-cyan)" />
              <KpiCard label="Grand total" value={fmt(result.grandTotal)} icon={<DollarSign size={20} />} accent="var(--accent-emerald)" />
            </div>
            <div className={styles.gridScroll}>
              <table className={styles.pivotGrid}>
                <thead>
                  <tr>
                    <th className={styles.pivotCorner}>{dimLabel(result.rowDimension)} \ {dimLabel(result.columnDimension)}</th>
                    {result.columns.map((c) => <th key={c} className={styles.pivotColHead}>{titleCase(c)}</th>)}
                    <th className={styles.pivotTotalHead}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.row}>
                      <th className={styles.pivotRowHead}>{titleCase(r.row)}</th>
                      {result.columns.map((c) => (
                        <td key={c} className={styles.pivotCell}>
                          {r.cells[c] !== undefined ? fmt(r.cells[c]!) : <span className={styles.pivotEmpty}>–</span>}
                        </td>
                      ))}
                      <td className={styles.pivotRowTotal}>{fmt(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th className={styles.pivotRowHead}>Total</th>
                    {result.columns.map((c) => <td key={c} className={styles.pivotColTotal}>{fmt(result.columnTotals[c] ?? 0)}</td>)}
                    <td className={styles.pivotGrand}>{fmt(result.grandTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )
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
    { key: 'peril', header: 'Peril', render: (e) => e.peril ?? '-' },
    { key: 'claims', header: 'Claims', align: 'right', render: (e) => formatNumber(e.claimCount) },
    { key: 'gross', header: 'Gross loss', align: 'right', sortValue: (e) => e.grossLossMinor, render: (e) => formatMoney(e.grossLossMinor) },
    {
      key: 'rate', header: 'Annual rate λ', align: 'right',
      render: (e) => (
        <Input
          type="number" step="0.01" min="0" className={styles.rateInput}
          value={rates[e.id] ?? '0.04'}
          onChange={(ev) => setRates((r) => ({ ...r, [e.id]: ev.target.value }))}
          disabled={e.grossLossMinor === 0}
        />
      ),
    },
  ];

  return (
    <div className={styles.stack5}>
      <p className={shared.cellSub}>
        Per-event losses are aggregated from real claims. Assign each event an annual occurrence rate (λ - e.g. 0.04 for a 1-in-25-year event)
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
            <KpiCard label="Average Annual Loss" value={formatMoney(metrics.averageAnnualLossMinor)} icon={<Sigma size={20} />} accent="var(--accent-orange)" />
            {metrics.pmlProfile.filter((p) => [50, 100, 250].includes(p.returnPeriod)).map((p, i) => (
              <KpiCard key={p.returnPeriod} label={`PML 1-in-${p.returnPeriod}`} value={formatMoney(p.lossMinor)} icon={<TrendingUp size={20} />} accent={['var(--primary)', 'var(--accent-violet)', 'var(--accent-rose)'][i % 3]} />
            ))}
          </div>

          <Card>
            <CardHeader title="Exceedance probability (OEP) curve" subtitle="Annual probability and return period at each modelled loss level." />
            <div className={styles.cardBody}>
              <Table
                columns={[
                  { key: 'loss', header: 'Loss level', align: 'right', render: (p: EpPoint) => formatMoney(p.lossMinor) },
                  { key: 'prob', header: 'P(exceed / yr)', align: 'right', render: (p: EpPoint) => formatPercent(p.probability) },
                  { key: 'rp', header: 'Return period', align: 'right', render: (p: EpPoint) => Number.isFinite(p.returnPeriod) ? `1-in-${Math.round(p.returnPeriod)}` : '-' },
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
    <div className={styles.forecastForm}>
      <p className={shared.cellSub}>Project a metric forward from a historical series (e.g. monthly premium). Linear fits an OLS trend; smoothing uses exponential smoothing.</p>
      <FormField label="Historical series" error={error ?? undefined}>
        <Textarea rows={3} value={series} onChange={(e) => setSeries(e.target.value)} />
      </FormField>
      <div className={styles.toolbar}>
        <div className={styles.field}>
          <FormField label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="linear">Linear trend</option>
              <option value="smoothing">Exponential smoothing</option>
            </Select>
          </FormField>
        </div>
        <div className={styles.fieldNarrow}>
          <FormField label="Periods ahead">
            <Input type="number" min="1" max="60" value={periods} onChange={(e) => setPeriods(e.target.value)} />
          </FormField>
        </div>
        <Button variant="primary" onClick={run} loading={busy}>Forecast</Button>
      </div>
      {result && (
        <>
          <div className={shared.kpiGrid}>
            <KpiCard label="Trend slope" value={formatNumber(Math.round(result.fit.slope))} icon={<TrendingUp size={20} />} accent="var(--primary)" />
            <KpiCard label="Fit R²" value={formatPercent(result.fit.r2)} icon={<Target size={20} />} accent={result.fit.r2 >= 0.8 ? 'var(--accent-emerald)' : 'var(--accent-orange)'} />
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

/* ----------------------------- Reports ----------------------------- */

interface SavedReport { key: string; name: string; body: { source: string; dimensions: string[]; measures: { field?: string; agg: string; as?: string }[] } }

function ReportsConsole() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = hasPermission('reporting:write');
  const sources = useQuery({ queryKey: ['analytics-sources'], queryFn: () => api<{ sources: SourceMeta[] }>('/api/analytics/sources') });
  const reports = useQuery({ queryKey: ['analytics-reports'], queryFn: () => api<{ reports: SavedReport[] }>('/api/analytics/reports') });

  const [name, setName] = useState('');
  const [sourceKey, setSourceKey] = useState('claim');
  const [dimension, setDimension] = useState('');
  const [measureField, setMeasureField] = useState('');
  const [result, setResult] = useState<PivotResult | null>(null);

  const source = sources.data?.sources.find((s) => s.key === sourceKey);
  const dims = source?.dimensions ?? [];
  const measures = source?.measures ?? [];
  const activeDim = dimension || dims[0]?.key || '';
  const activeMeasure = measureField || measures[0]?.field || '';
  const keyFromName = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const save = useMutation({
    mutationFn: () => api('/api/analytics/reports', {
      body: { key: keyFromName, name: name.trim(), source: sourceKey, dimensions: activeDim ? [activeDim] : [], measures: [{ field: activeMeasure, agg: 'sum', as: 'total' }, { agg: 'count' }] },
    }),
    onSuccess: () => { toast.success('Report saved'); setName(''); qc.invalidateQueries({ queryKey: ['analytics-reports'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save report'),
  });
  const run = useMutation({
    mutationFn: (key: string) => api<PivotResult>(`/api/analytics/reports/${key}/run`, { body: {} }),
    onSuccess: (r) => setResult(r),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not run report'),
  });

  if (sources.isLoading || reports.isLoading) return <PageLoader label="Loading reports…" />;

  return (
    <div className={styles.stack5}>
      <Card>
        <CardHeader title="Saved reports" subtitle="Named definitions over the fact sources - run on demand." />
        <div className={styles.cardBody}>
          <Table
            columns={[
              { key: 'name', header: 'Report', render: (r: SavedReport) => <span className={shared.cellMain}>{r.name}</span> },
              { key: 'source', header: 'Source', render: (r: SavedReport) => r.body.source },
              { key: 'dims', header: 'Grouped by', render: (r: SavedReport) => (r.body.dimensions ?? []).join(', ') || '-' },
              { key: 'act', header: '', align: 'right', render: (r: SavedReport) => <Button variant="primary" onClick={() => run.mutate(r.key)} loading={run.isPending}>Run</Button> },
            ]}
            rows={reports.data?.reports}
            rowKey={(r) => r.key}
            empty={<EmptyState title="No reports" message="No reports saved yet." />}
          />
        </div>
      </Card>

      {result && (
        <Card>
          <CardHeader title="Result" actions={<Badge color="slate">{result.factCount} facts</Badge>} />
          <div className={styles.cardBody}>
            <Table
              columns={[
                { key: 'k', header: 'Group', render: (c: PivotCell) => <span className={shared.cellMain}>{Object.values(c.key).map(String).join(' · ') || 'All'}</span> },
                { key: 't', header: 'Total', align: 'right', render: (c: PivotCell) => formatMoney(c.values.total) },
                { key: 'n', header: 'Facts', align: 'right', render: (c: PivotCell) => formatNumber(c.count) },
              ]}
              rows={result.cells}
              rowKey={(c) => JSON.stringify(c.key)}
            />
          </div>
        </Card>
      )}

      {canWrite && (
        <Card>
          <CardHeader title="Design a report" subtitle="Pick a source, a grouping and a measure, then save it by name." />
          <div className={styles.reportForm}>
            <div className={styles.reportField}><FormField label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claims by status" /></FormField></div>
            <div className={styles.reportFieldSm}>
              <FormField label="Source">
                <Select value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setDimension(''); setMeasureField(''); }}>
                  {sources.data?.sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </Select>
              </FormField>
            </div>
            <div className={styles.reportFieldSm}>
              <FormField label="Group by">
                <Select value={activeDim} onChange={(e) => setDimension(e.target.value)}>
                  {dims.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </Select>
              </FormField>
            </div>
            <div className={styles.reportFieldSm}>
              <FormField label="Measure (sum)">
                <Select value={activeMeasure} onChange={(e) => setMeasureField(e.target.value)}>
                  {measures.map((m) => <option key={m.field} value={m.field}>{m.label}</option>)}
                </Select>
              </FormField>
            </div>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={keyFromName.length < 2}>Save report</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ----------------------------- Dashboards ----------------------------- */

interface DashboardDef { key: string; name: string; body: { name: string; widgets: { title: string; reportKey: string }[] } }
interface RenderedWidget { title: string; reportKey: string; total?: number; groups?: number; factCount?: number; error?: string }

function DashboardsConsole() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = hasPermission('reporting:write');
  const dashboards = useQuery({ queryKey: ['analytics-dashboards'], queryFn: () => api<{ dashboards: DashboardDef[] }>('/api/analytics/dashboards') });
  const reports = useQuery({ queryKey: ['analytics-reports'], queryFn: () => api<{ reports: { key: string; name: string }[] }>('/api/analytics/reports') });
  const [rendered, setRendered] = useState<{ name: string; widgets: RenderedWidget[] } | null>(null);

  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const render = useMutation({
    mutationFn: (key: string) => api<{ name: string; widgets: RenderedWidget[] }>(`/api/analytics/dashboards/${key}/render`, { body: {} }),
    onSuccess: (r) => setRendered(r),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not render'),
  });
  const save = useMutation({
    mutationFn: () => api('/api/analytics/dashboards', {
      body: {
        key: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
        name: name.trim(),
        widgets: picked.map((rk) => ({ title: reports.data?.reports.find((r) => r.key === rk)?.name ?? rk, reportKey: rk })),
      },
    }),
    onSuccess: () => { toast.success('Dashboard saved'); setName(''); setPicked([]); qc.invalidateQueries({ queryKey: ['analytics-dashboards'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save dashboard'),
  });

  if (dashboards.isLoading) return <PageLoader label="Loading dashboards…" />;

  return (
    <div className={styles.stack5}>
      <Card>
        <CardHeader title="Dashboards" subtitle="Composed of saved-report widget tiles." />
        <div className={styles.cardBody}>
          <Table
            columns={[
              { key: 'name', header: 'Dashboard', render: (d: DashboardDef) => <span className={shared.cellMain}>{d.name}</span> },
              { key: 'widgets', header: 'Widgets', align: 'right', render: (d: DashboardDef) => String((d.body.widgets ?? []).length) },
              { key: 'act', header: '', align: 'right', render: (d: DashboardDef) => <Button variant="primary" onClick={() => render.mutate(d.key)} loading={render.isPending}>Render</Button> },
            ]}
            rows={dashboards.data?.dashboards}
            rowKey={(d) => d.key}
            empty={<EmptyState title="No dashboards" message="No dashboards saved yet." />}
          />
        </div>
      </Card>

      {rendered && (
        <Card>
          <CardHeader title={rendered.name} />
          <div className={`${shared.kpiGrid} ${styles.cardBody}`}>
            {rendered.widgets.map((w, i) => (
              <KpiCard key={w.title} label={w.title} value={w.error ? '-' : formatMoney(w.total)} hint={w.error ?? `${w.groups} groups · ${w.factCount} facts`} icon={<Grid2x2 size={20} />} accent={['var(--primary)', 'var(--accent-violet)', 'var(--accent-cyan)', 'var(--accent-emerald)', 'var(--accent-orange)'][i % 5]} />
            ))}
          </div>
        </Card>
      )}

      {canWrite && (
        <Card>
          <CardHeader title="Compose a dashboard" subtitle="Name it and pick the saved reports to show as tiles." />
          <div className={styles.dashForm}>
            <div className={styles.dashNameField}><FormField label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claims overview" /></FormField></div>
            <div className={styles.chipRow}>
              {(reports.data?.reports ?? []).map((r) => {
                const on = picked.includes(r.key);
                return (
                  <button key={r.key} type="button" onClick={() => setPicked((p) => on ? p.filter((k) => k !== r.key) : [...p, r.key])}
                    className={styles.chipButton}>
                    <Badge color={on ? 'green' : 'slate'}>{r.name}</Badge>
                  </button>
                );
              })}
              {(reports.data?.reports ?? []).length === 0 && <span className={shared.cellSub}>Save a report first (Reports tab).</span>}
            </div>
            <div><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim() || picked.length === 0}>Save dashboard</Button></div>
          </div>
        </Card>
      )}
    </div>
  );
}
