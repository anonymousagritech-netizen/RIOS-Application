/**
 * Underwriting Analytics — an executive, tabbed dashboard over the submission
 * book: portfolio mix, catastrophe accumulation (modelled by the CAT adapter)
 * and a risk console. Read-only, gated on treaty:read. Money is integer minor
 * units → divided by 100 for display; risk scores are 0–100.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Inbox, TrendingUp, Gauge, CheckCircle2, Percent,
  Layers, DollarSign, Building2, Waves, Flame, Sigma, ShieldAlert, AlertTriangle,
  Receipt, ArrowLeftRight, Undo2, Wallet, Activity, Landmark,
} from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { DonutChart, type DonutDatum } from '../components/DonutChart';
import { BarChart, type BarDatum } from '../components/BarChart';
import { Tabs } from '../components/Tabs';
import { titleCase } from '../lib/format';
import type { TokenColor } from '../lib/status';
import styles from './UnderwritingAnalyticsPage.module.css';

/* ---------------- Formatting helpers (minor units → display) ---------------- */
const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
const compact = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);

const BAND_COLOR: Record<string, TokenColor> = {
  LOW: 'green', MODERATE: 'amber', ELEVATED: 'orange', HIGH: 'red', UNSCORED: 'gray',
};
const PERIL_COLOR: Record<string, TokenColor> = {
  HURRICANE: 'blue', WINDSTORM: 'teal', EARTHQUAKE: 'orange', FLOOD: 'indigo', WILDFIRE: 'red',
};
const perilIcon = (peril: string) =>
  /QUAKE|EARTH/.test(peril) ? <AlertTriangle size={13} /> : /FIRE/.test(peril) ? <Flame size={13} /> : <Waves size={13} />;

/* ---------------- API types (mirror server responses) ---------------- */
interface Kpis {
  open: number; bound: number; declined: number; lapsed: number;
  pipelineEpiMinor: number; avgRiskScore: number; hitRatioPct: number;
  byStage: Record<string, number>;
}
interface KeyN { key: string; n: number; }
interface KeyNEpi extends KeyN { epi: number; }
interface Portfolio {
  totalSubmissions: number; totalEpiMinor: number; avgRiskScore: number;
  byStructure: KeyNEpi[]; byLineOfBusiness: KeyNEpi[]; byRiskBand: KeyN[]; topCedents: KeyNEpi[];
}
interface EpPoint { returnPeriod: number; exceedanceProb: number; lossMinor: number; }
interface CatZone {
  zone: string; submissions: number; aggregateExposureMinor: number; peril: string;
  aalMinor: number; pmlMinor: Record<number, number>; epCurve: EpPoint[]; tvar99Minor: number;
}
interface CatAnalytics {
  provider: string; returnPeriods: number[]; totalExposureMinor: number; totalAalMinor: number;
  bookPmlMinor: Record<number, number>; bookEpCurve: EpPoint[]; bookTvar99Minor: number; zones: CatZone[];
}
interface RiskDist { band: string; n: number; }
interface HeatCell { structure: string; band: string; n: number; }
interface HighRisk {
  id: string; reference: string; title: string; riskScore: number | null; riskBand: string | null;
  stage: string; estPremiumMinor: number | null; currency: string; cedentName: string | null;
}
interface RiskAnalytics { distribution: RiskDist[]; heatmap: HeatCell[]; highRisk: HighRisk[]; }
interface RenewalBook {
  upForRenewal: number; renewed: number; lapsed: number; inProgress: number;
  expiringPremiumMinor: number; renewedPremiumMinor: number;
  retentionRatePct: number; premiumRetentionPct: number; avgRateChangePct: number | null;
}
interface RenewalRow {
  id: string; reference: string; title: string; stage: string; currency: string;
  cedentName: string | null; expiringPremiumMinor: number; renewalPremiumMinor: number; rateChangePct: number | null;
}
interface RenewalAnalytics { book: RenewalBook; renewals: RenewalRow[]; }
interface KeyIncurred { key: string; incurredMinor: number; n: number; }
interface TechAccount { premiumMinor: number; commissionMinor: number; claimsMinor: number; expensesMinor: number; lossRatioPct: number; commissionRatioPct: number; expenseRatioPct: number; combinedRatioPct: number; technicalResultMinor: number; }
interface ClaimsAnalytics {
  totals: { claimCount: number; incurredMinor: number; paidMinor: number; outstandingMinor: number; recoveredMinor: number; premiumMinor: number };
  lossRatioPct: number;
  frequencySeverity: { frequency: number; severityMinor: number; claimCount: number };
  technicalAccount: TechAccount;
  byLine: KeyIncurred[]; byStatus: { key: string; n: number; incurredMinor: number }[]; byYear: KeyIncurred[];
  topClaims: { id: string; reference: string; description: string | null; lossDate: string | null; status: string; currency: string; grossLossMinor: number; outstandingMinor: number; cedentName: string | null }[];
}
interface FinanceAnalytics {
  technicalAccount: TechAccount;
  totals: { premiumMinor: number; commissionMinor: number; claimsMinor: number; otherMinor: number };
  byType: { key: string; amountMinor: number; n: number }[];
  cashflow: { key: string; inflowMinor: number; outflowMinor: number; netMinor: number }[];
}
interface RetroAnalytics {
  summary: { programmes: number; layers: number; cededPremiumMinor: number; recoveredMinor: number; outstandingMinor: number };
  byStructure: { key: string; n: number }[];
  programmes: { id: string; reference: string | null; name: string; basis: string; npType: string | null; status: string; currency: string; periodStart: string | null; periodEnd: string | null }[];
}

/* ---------------- Data hooks ---------------- */
const useKpis = () => useQuery({ queryKey: ['uwa', 'kpis'], queryFn: () => api<Kpis>('/api/underwriting/kpis') });
const usePortfolio = () => useQuery({ queryKey: ['uwa', 'portfolio'], queryFn: () => api<Portfolio>('/api/underwriting/analytics/portfolio') });
const useCat = () => useQuery({ queryKey: ['uwa', 'cat'], queryFn: () => api<CatAnalytics>('/api/underwriting/analytics/cat') });
const useRisk = () => useQuery({ queryKey: ['uwa', 'risk'], queryFn: () => api<RiskAnalytics>('/api/underwriting/analytics/risk') });
const useRenewal = () => useQuery({ queryKey: ['uwa', 'renewal'], queryFn: () => api<RenewalAnalytics>('/api/underwriting/analytics/renewal') });
const useClaimsA = () => useQuery({ queryKey: ['uwa', 'claims'], queryFn: () => api<ClaimsAnalytics>('/api/underwriting/analytics/claims') });
const useFinanceA = () => useQuery({ queryKey: ['uwa', 'finance'], queryFn: () => api<FinanceAnalytics>('/api/underwriting/analytics/finance') });
const useRetroA = () => useQuery({ queryKey: ['uwa', 'retro'], queryFn: () => api<RetroAnalytics>('/api/underwriting/analytics/retro') });

/* ==================================================================== */
export function UnderwritingAnalyticsPage() {
  const [tab, setTab] = useState('executive');
  return (
    <>
      <PageHeader
        title="Underwriting Analytics"
        description="Portfolio mix, catastrophe accumulation and risk concentration across the submission book — one console for the underwriting leadership view."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Underwriting', to: '/underwriting' }, { label: 'Analytics' }]}
        actions={<Badge color="indigo">Live book</Badge>}
      />
      <Card padded={false}>
        <Tabs
          tabs={[
            { id: 'executive', label: 'Executive' },
            { id: 'portfolio', label: 'Portfolio' },
            { id: 'cat', label: 'Catastrophe' },
            { id: 'risk', label: 'Risk' },
            { id: 'renewal', label: 'Renewals' },
            { id: 'claims', label: 'Claims' },
            { id: 'finance', label: 'Finance' },
            { id: 'retro', label: 'Retrocession' },
          ]}
          active={tab}
          onChange={setTab}
        />
        <div className={styles.tabBody}>
          {tab === 'executive' && <ExecutiveTab />}
          {tab === 'portfolio' && <PortfolioTab />}
          {tab === 'cat' && <CatTab />}
          {tab === 'risk' && <RiskTab />}
          {tab === 'renewal' && <RenewalTab />}
          {tab === 'claims' && <ClaimsTab />}
          {tab === 'finance' && <FinanceTab />}
          {tab === 'retro' && <RetroTab />}
        </div>
      </Card>
    </>
  );
}

/* ---------------- Executive ---------------- */
function ExecutiveTab() {
  const kpis = useKpis();
  const portfolio = usePortfolio();
  const k = kpis.data;

  const stageData: BarDatum[] = useMemo(() => {
    const bs = k?.byStage ?? {};
    return Object.entries(bs)
      .map(([key, n]) => ({ label: titleCase(key), value: n, status: key }))
      .sort((a, b) => b.value - a.value);
  }, [k]);

  const bandData: DonutDatum[] = useMemo(
    () => (portfolio.data?.byRiskBand ?? []).map((b) => ({ label: b.key, value: b.n, status: b.key })),
    [portfolio.data],
  );

  return (
    <>
      <div className={styles.kpis}>
        <KpiCard label="Open submissions" value={String(k?.open ?? 0)} hint="In the pipeline" icon={<Inbox size={20} />} accent="var(--primary)" loading={kpis.isLoading} />
        <KpiCard label="Pipeline EPI" value={compact(k?.pipelineEpiMinor)} hint="Estimated premium in flight" icon={<TrendingUp size={20} />} accent="var(--accent-cyan)" loading={kpis.isLoading} />
        <KpiCard label="Avg risk score" value={String(k?.avgRiskScore ?? 0)} hint="0 = benign · 100 = severe" icon={<Gauge size={20} />} accent="var(--accent-violet)" loading={kpis.isLoading} />
        <KpiCard label="Bound" value={String(k?.bound ?? 0)} hint="Won this book" icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" loading={kpis.isLoading} />
        <KpiCard label="Hit ratio" value={`${k?.hitRatioPct ?? 0}%`} hint="Bound of decided" icon={<Percent size={20} />} accent="var(--accent-orange)" loading={kpis.isLoading} />
      </div>

      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="Pipeline by stage" subtitle="Submissions at each lifecycle stage" />
          <div className={styles.chartBody}>
            {kpis.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <BarChart data={stageData} emptyLabel="No submissions in the pipeline yet." />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Risk band distribution" subtitle="How the book scores overall" />
          <div className={styles.chartBody}>
            {portfolio.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <DonutChart data={bandData} centerLabel="risks" emptyLabel="No scored submissions yet." />}
          </div>
        </Card>
      </div>
    </>
  );
}

/* ---------------- Portfolio ---------------- */
function PortfolioTab() {
  const q = usePortfolio();
  const p = q.data;

  // Business mix by structure — value is EPI (major units so the legend reads sensibly).
  const structureData: DonutDatum[] = useMemo(
    () => (p?.byStructure ?? []).filter((s) => s.epi > 0).map((s) => ({ label: titleCase(s.key), value: Math.round(s.epi / 100), status: s.key })),
    [p],
  );
  const lobData: BarDatum[] = useMemo(
    () => (p?.byLineOfBusiness ?? []).map((l) => ({ label: titleCase(l.key), value: l.n, status: l.key })),
    [p],
  );
  const bandData: DonutDatum[] = useMemo(
    () => (p?.byRiskBand ?? []).map((b) => ({ label: b.key, value: b.n, status: b.key })),
    [p],
  );

  const cedentCols: Column<KeyNEpi>[] = [
    { key: 'name', header: 'Cedent', render: (r) => <span className={styles.cellMain}>{r.key}</span> },
    { key: 'n', header: 'Submissions', align: 'right', sortValue: (r) => r.n, render: (r) => <span className={styles.num}>{r.n}</span> },
    { key: 'epi', header: 'EPI', align: 'right', sortValue: (r) => r.epi, render: (r) => <span className={styles.num}>{money(r.epi)}</span> },
  ];

  return (
    <>
      <div className={styles.kpis}>
        <KpiCard label="Total submissions" value={String(p?.totalSubmissions ?? 0)} hint="Across the book" icon={<Layers size={20} />} accent="var(--primary)" loading={q.isLoading} />
        <KpiCard label="Total EPI" value={compact(p?.totalEpiMinor)} hint="Estimated premium income" icon={<DollarSign size={20} />} accent="var(--accent-emerald)" loading={q.isLoading} />
        <KpiCard label="Avg risk score" value={String(p?.avgRiskScore ?? 0)} hint="0–100 across the book" icon={<Gauge size={20} />} accent="var(--accent-violet)" loading={q.isLoading} />
      </div>

      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="Business mix by structure" subtitle="Share of estimated premium income" />
          <div className={styles.chartBody}>
            {q.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <DonutChart data={structureData} centerValue={compact(p?.totalEpiMinor)} centerLabel="EPI" emptyLabel="No premium booked yet." />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Submissions by line of business" subtitle="Count per class" />
          <div className={styles.chartBody}>
            {q.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <BarChart data={lobData} emptyLabel="No submissions yet." />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Risk band distribution" subtitle="Concentration by score band" />
          <div className={styles.chartBody}>
            {q.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <DonutChart data={bandData} centerLabel="risks" emptyLabel="No scored submissions yet." />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Top cedents" subtitle="Largest relationships by EPI" actions={<Building2 size={16} />} />
          <div className={styles.tableWrap}>
            <Table
              columns={cedentCols}
              rows={p?.topCedents}
              loading={q.isLoading}
              rowKey={(r) => r.key}
              empty={<EmptyState icon={<Building2 size={18} />} title="No cedents" message="No submissions attributed to a cedent yet." />}
              skeletonRows={5}
            />
          </div>
        </Card>
      </div>
    </>
  );
}

/* ---------------- Catastrophe ---------------- */
function CatTab() {
  const q = useCat();
  const c = q.data;

  const pmlData: BarDatum[] = useMemo(() => {
    if (!c) return [];
    return c.returnPeriods
      .filter((rp) => c.bookPmlMinor[rp] != null)
      .map((rp) => ({ label: `1-in-${rp}`, value: Math.round((c.bookPmlMinor[rp] ?? 0) / 100), status: 'blue' }));
  }, [c]);

  const zoneCols: Column<CatZone>[] = [
    { key: 'zone', header: 'Zone', render: (r) => <span className={styles.cellMain}>{r.zone}</span> },
    { key: 'peril', header: 'Peril', render: (r) => <Badge color={PERIL_COLOR[r.peril] ?? 'slate'}>{titleCase(r.peril)}</Badge> },
    { key: 'exp', header: 'Exposure', align: 'right', sortValue: (r) => r.aggregateExposureMinor, render: (r) => <span className={styles.num}>{money(r.aggregateExposureMinor)}</span> },
    { key: 'aal', header: 'AAL', align: 'right', sortValue: (r) => r.aalMinor, render: (r) => <span className={styles.num}>{money(r.aalMinor)}</span> },
    { key: 'pml', header: 'PML 1-in-250', align: 'right', sortValue: (r) => r.pmlMinor[250] ?? 0, render: (r) => <span className={styles.num}>{money(r.pmlMinor[250])}</span> },
    { key: 'tvar', header: 'TVaR 99%', align: 'right', sortValue: (r) => r.tvar99Minor, render: (r) => <span className={styles.num}>{money(r.tvar99Minor)}</span> },
  ];

  return (
    <>
      <p className={styles.provider}><ShieldAlert size={13} /> Modelled by {c?.provider ?? 'the CAT adapter'} · occurrence PML / AAL / EP over the cat-exposed accumulation.</p>

      <div className={styles.kpis}>
        <KpiCard label="Total exposure" value={compact(c?.totalExposureMinor)} hint="Cat-exposed aggregate" icon={<Waves size={20} />} accent="var(--primary)" loading={q.isLoading} />
        <KpiCard label="Book AAL" value={compact(c?.totalAalMinor)} hint="Average annual loss" icon={<Sigma size={20} />} accent="var(--accent-orange)" loading={q.isLoading} />
        <KpiCard label="PML 1-in-250" value={compact(c?.bookPmlMinor?.[250])} hint="Occurrence, 0.4% EP" icon={<TrendingUp size={20} />} accent="var(--accent-rose)" loading={q.isLoading} />
        <KpiCard label="TVaR 99%" value={compact(c?.bookTvar99Minor)} hint="Tail value-at-risk" icon={<AlertTriangle size={20} />} accent="var(--accent-violet)" loading={q.isLoading} />
      </div>

      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="PML by return period" subtitle="Occurrence probable maximum loss" />
          <div className={styles.chartBody}>
            {q.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <BarChart data={pmlData} emptyLabel="No cat-exposed accumulation yet." />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Exceedance-probability curve" subtitle="Modelled loss at each return period" />
          {q.isLoading ? <div className={styles.chartBody}><p className={styles.cellSub}>Loading…</p></div>
            : <EpCurve points={c?.bookEpCurve ?? []} />}
        </Card>
      </div>

      <Card padded={false}>
        <CardHeader title="Zone accumulation" subtitle="Exposure and modelled loss by peril zone" />
        <div className={styles.tableWrap}>
          <Table
            columns={zoneCols}
            rows={c?.zones}
            loading={q.isLoading}
            rowKey={(r) => r.zone}
            empty={<EmptyState icon={<Waves size={18} />} title="No cat accumulation" message="No cat-exposed submissions in the live book." />}
            skeletonRows={4}
          />
        </div>
      </Card>
    </>
  );
}

/** Hand-rolled SVG EP curve: x = return-period index (evenly spaced), y = loss. */
function EpCurve({ points }: { points: EpPoint[] }) {
  if (!points.length) return <div className={styles.chartBody}><p className={styles.cellSub}>No exceedance curve to plot.</p></div>;

  // viewBox coordinate space (unitless — safe to hardcode per the brief).
  const W = 200, H = 100, padL = 8, padR = 6, padT = 8, padB = 14;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxLoss = Math.max(1, ...points.map((p) => p.lossMinor));
  const n = points.length;
  const x = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (loss: number) => padT + plotH - (loss / maxLoss) * plotH;

  const linePts = points.map((p, i) => `${x(i).toFixed(2)},${y(p.lossMinor).toFixed(2)}`).join(' ');
  const areaPts = `${x(0).toFixed(2)},${(padT + plotH).toFixed(2)} ${linePts} ${x(n - 1).toFixed(2)},${(padT + plotH).toFixed(2)}`;
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => padT + plotH - f * plotH);
  const peak = points.reduce((m, p) => (p.lossMinor > m.lossMinor ? p : m), points[0]!);

  return (
    <div className={styles.epWrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.epChart} role="img" aria-label="Exceedance probability curve" preserveAspectRatio="none">
        {gridY.map((gy, i) => <line key={i} className={styles.epGrid} x1={padL} y1={gy} x2={W - padR} y2={gy} />)}
        <polygon className={styles.epArea} points={areaPts} />
        <polyline className={styles.epLine} points={linePts} />
        {points.map((p, i) => <circle key={p.returnPeriod} className={styles.epDot} cx={x(i)} cy={y(p.lossMinor)} r={1.2} />)}
        {points.map((p, i) => (
          <text key={`t-${p.returnPeriod}`} className={styles.epAxis} x={x(i)} y={H - 4} textAnchor="middle">{p.returnPeriod}</text>
        ))}
      </svg>
      <div className={styles.epLegend}>
        <span>Return period (years) →</span>
        <span>Peak modelled loss <strong>{money(peak.lossMinor)}</strong> at 1-in-{peak.returnPeriod}</span>
      </div>
    </div>
  );
}

/* ---------------- Risk ---------------- */
const RISK_BANDS = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'UNSCORED'] as const;

function RiskTab() {
  const q = useRisk();
  const r = q.data;

  const bandData: DonutDatum[] = useMemo(
    () => (r?.distribution ?? []).map((d) => ({ label: d.band, value: d.n, status: d.band })),
    [r],
  );

  // Pivot the heatmap into structure rows × band columns.
  const { structures, bands, matrix, maxN } = useMemo(() => {
    const cells = r?.heatmap ?? [];
    const structs = Array.from(new Set(cells.map((c) => c.structure)));
    const presentBands = RISK_BANDS.filter((b) => cells.some((c) => c.band === b));
    const bandsList = presentBands.length ? presentBands : (RISK_BANDS as readonly string[]).slice(0, 4);
    const m = new Map<string, number>();
    let mx = 0;
    for (const c of cells) { m.set(`${c.structure}|${c.band}`, c.n); if (c.n > mx) mx = c.n; }
    return { structures: structs, bands: bandsList, matrix: m, maxN: Math.max(1, mx) };
  }, [r]);

  const highRiskCols: Column<HighRisk>[] = [
    {
      key: 'ref', header: 'Submission', sortValue: (h) => h.reference,
      render: (h) => (
        <div>
          <div className={styles.cellMain}>{h.title}</div>
          <div className={styles.cellRef}>{h.reference} · {h.cedentName ?? 'Cedent TBC'}</div>
        </div>
      ),
    },
    { key: 'stage', header: 'Stage', render: (h) => <span className={styles.cellSub}>{titleCase(h.stage)}</span> },
    { key: 'epi', header: 'EPI', align: 'right', sortValue: (h) => h.estPremiumMinor ?? 0, render: (h) => <span className={styles.num}>{money(h.estPremiumMinor, h.currency)}</span> },
    { key: 'score', header: 'Score', align: 'right', sortValue: (h) => h.riskScore ?? 0, render: (h) => <span className={styles.num}>{h.riskScore ?? '—'}</span> },
    { key: 'band', header: 'Band', align: 'right', render: (h) => h.riskBand ? <Badge color={BAND_COLOR[h.riskBand] ?? 'gray'}>{titleCase(h.riskBand)}</Badge> : <span className={styles.cellSub}>—</span> },
  ];

  return (
    <>
      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="Risk band distribution" subtitle="Submissions per score band" />
          <div className={styles.chartBody}>
            {q.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <DonutChart data={bandData} centerLabel="risks" emptyLabel="No scored submissions yet." />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Structure × band heatmap" subtitle="Where risk concentrates by structure" />
          {q.isLoading ? <div className={styles.chartBody}><p className={styles.cellSub}>Loading…</p></div>
            : structures.length === 0
              ? <div className={styles.chartBody}><EmptyState title="No heatmap" message="No submissions to cross-tabulate yet." /></div>
              : (
                <div className={styles.heatScroll}>
                  <div className={styles.heat} style={{ gridTemplateColumns: `minmax(7rem, auto) repeat(${bands.length}, 1fr)` }}>
                    <div className={styles.heatCorner}>Structure</div>
                    {bands.map((b) => <div key={b} className={styles.heatColHead}>{titleCase(b)}</div>)}
                    {structures.map((s) => (
                      <HeatRow key={s} structure={s} bands={bands} matrix={matrix} maxN={maxN} />
                    ))}
                  </div>
                  <div className={styles.heatKey}>
                    <span>Fewer</span><span className={styles.heatKeyBar} aria-hidden /><span>More submissions</span>
                  </div>
                </div>
              )}
        </Card>
      </div>

      <Card padded={false}>
        <CardHeader title="High-risk queue" subtitle="Elevated & high-band submissions still in the pipeline" actions={<AlertTriangle size={16} />} />
        <div className={styles.tableWrap}>
          <Table
            columns={highRiskCols}
            rows={r?.highRisk}
            loading={q.isLoading}
            rowKey={(h) => h.id}
            empty={<EmptyState icon={<CheckCircle2 size={18} />} title="Queue clear" message="No elevated or high-risk submissions awaiting a decision." />}
            skeletonRows={5}
          />
        </div>
      </Card>
    </>
  );
}

function HeatRow({ structure, bands, matrix, maxN }: { structure: string; bands: readonly string[]; matrix: Map<string, number>; maxN: number }) {
  return (
    <>
      <div className={styles.heatRowHead}>{titleCase(structure)}</div>
      {bands.map((b) => {
        const n = matrix.get(`${structure}|${b}`) ?? 0;
        const intensity = Math.round((n / maxN) * 100);
        const bg = n === 0
          ? 'var(--surface-2)'
          : `color-mix(in srgb, var(--primary) ${intensity}%, var(--surface-2))`;
        return (
          <div key={b} className={styles.heatCell} data-empty={n === 0} style={{ background: bg }} title={`${titleCase(structure)} · ${titleCase(b)}: ${n}`}>
            {n === 0 ? '·' : n}
          </div>
        );
      })}
    </>
  );
}

/* ---------------- Renewals ---------------- */
function RenewalTab() {
  const renewal = useRenewal();
  const b = renewal.data?.book;
  const rows = renewal.data?.renewals ?? [];

  const columns: Column<RenewalRow>[] = [
    {
      key: 'sub', header: 'Renewal', sortValue: (r) => r.reference,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.title}</div>
          <div className={styles.cellSub}>{r.reference} · {r.cedentName ?? 'Cedent TBC'}</div>
        </div>
      ),
    },
    { key: 'expiring', header: 'Expiring', align: 'right', render: (r) => <span className={styles.num}>{money(r.expiringPremiumMinor, r.currency)}</span> },
    { key: 'renewal', header: 'Renewal', align: 'right', render: (r) => <span className={styles.num}>{money(r.renewalPremiumMinor, r.currency)}</span> },
    {
      key: 'rate', header: 'Rate Δ', align: 'right',
      render: (r) => r.rateChangePct == null
        ? <span className={styles.cellSub}>—</span>
        : <Badge color={r.rateChangePct >= 0 ? 'green' : 'red'}>{r.rateChangePct > 0 ? '+' : ''}{r.rateChangePct}%</Badge>,
    },
    { key: 'stage', header: 'Stage', align: 'right', render: (r) => <Badge color="slate">{titleCase(r.stage)}</Badge> },
  ];

  return (
    <>
      <div className={styles.kpis}>
        <KpiCard label="Up for renewal" value={String(b?.upForRenewal ?? 0)} hint="Expiring book" icon={<Inbox size={20} />} accent="var(--primary)" loading={renewal.isLoading} />
        <KpiCard label="Retention" value={`${b?.retentionRatePct ?? 0}%`} hint="Renewed of expiring" icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" loading={renewal.isLoading} />
        <KpiCard label="Premium retention" value={`${b?.premiumRetentionPct ?? 0}%`} hint="Renewed vs expiring premium" icon={<DollarSign size={20} />} accent="var(--accent-cyan)" loading={renewal.isLoading} />
        <KpiCard label="Avg rate change" value={b?.avgRateChangePct == null ? '—' : `${b.avgRateChangePct > 0 ? '+' : ''}${b.avgRateChangePct}%`} hint="On renewed business" icon={<TrendingUp size={20} />} accent="var(--accent-orange)" loading={renewal.isLoading} />
      </div>

      <Card padded={false}>
        <CardHeader title="Renewal pipeline" subtitle={`${b?.renewed ?? 0} renewed · ${b?.inProgress ?? 0} in progress · ${b?.lapsed ?? 0} lapsed · expiring ${compact(b?.expiringPremiumMinor)}`} />
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={rows}
            loading={renewal.isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<TrendingUp size={18} />} title="No renewals" message="Mark a submission as a renewal of a prior one to build the renewal book." />}
            skeletonRows={5}
          />
        </div>
      </Card>
    </>
  );
}

/* ---------------- Combined-ratio band helper ---------------- */
const crStatus = (cr: number): string => (cr < 100 ? 'green' : cr <= 110 ? 'amber' : 'red');

/* ---------------- Claims integration ---------------- */
function ClaimsTab() {
  const q = useClaimsA();
  const d = q.data;
  const ta = d?.technicalAccount;
  const columns: Column<NonNullable<typeof d>['topClaims'][number]>[] = [
    { key: 'ref', header: 'Claim', render: (r) => (<div><div className={styles.cellMain}>{r.description ?? r.reference}</div><div className={styles.cellSub}>{r.reference} · {r.cedentName ?? '—'}</div></div>) },
    { key: 'loss', header: 'Loss date', render: (r) => <span className={styles.cellSub}>{r.lossDate ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge color="slate">{titleCase(r.status)}</Badge> },
    { key: 'incurred', header: 'Incurred', align: 'right', render: (r) => <span className={styles.num}>{money(r.grossLossMinor, r.currency)}</span> },
    { key: 'os', header: 'Outstanding', align: 'right', render: (r) => <span className={styles.num}>{money(r.outstandingMinor, r.currency)}</span> },
  ];
  return (
    <>
      <div className={styles.kpis}>
        <KpiCard label="Claims" value={String(d?.totals.claimCount ?? 0)} hint="On the book" icon={<ShieldAlert size={20} />} accent="var(--primary)" loading={q.isLoading} />
        <KpiCard label="Incurred" value={d ? compact(d.totals.incurredMinor) : '—'} hint="Gross incurred loss" icon={<TrendingUp size={20} />} accent="var(--accent-rose)" loading={q.isLoading} />
        <KpiCard label="Loss ratio" value={d ? `${d.lossRatioPct}%` : '—'} hint="Incurred / premium" icon={<Percent size={20} />} accent="var(--accent-orange)" loading={q.isLoading} />
        <KpiCard label="Outstanding" value={d ? compact(d.totals.outstandingMinor) : '—'} hint="Case reserves" icon={<Layers size={20} />} accent="var(--accent-violet)" loading={q.isLoading} />
        <KpiCard label="Avg severity" value={d ? compact(d.frequencySeverity.severityMinor) : '—'} hint={`${d?.frequencySeverity.frequency ?? 0} freq / contract`} icon={<Activity size={20} />} accent="var(--accent-cyan)" loading={q.isLoading} />
      </div>
      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="Incurred by line of business" subtitle="Where the losses sit" actions={<Layers size={16} />} />
          <div className={styles.chartBody}><BarChart data={(d?.byLine ?? []).map((r) => ({ label: titleCase(r.key), value: r.incurredMinor / 100 }))} emptyLabel="No claims yet" /></div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Claims by status" subtitle="Lifecycle distribution" actions={<ShieldAlert size={16} />} />
          <div className={styles.chartBody}><DonutChart data={(d?.byStatus ?? []).map((r) => ({ label: titleCase(r.key), value: r.n }))} /></div>
        </Card>
      </div>
      {ta && (
        <Card padded>
          <CardHeader title="Technical account" subtitle="Premium, commission and losses → combined ratio" />
          <div className={styles.statRow}>
            <Stat label="Premium" value={money(ta.premiumMinor)} />
            <Stat label="Commission" value={money(ta.commissionMinor)} />
            <Stat label="Claims" value={money(ta.claimsMinor)} />
            <Stat label="Loss ratio" value={`${ta.lossRatioPct}%`} />
            <Stat label="Combined ratio" value={`${ta.combinedRatioPct}%`} status={crStatus(ta.combinedRatioPct)} />
            <Stat label="Technical result" value={money(ta.technicalResultMinor)} status={ta.technicalResultMinor >= 0 ? 'green' : 'red'} />
          </div>
        </Card>
      )}
      <Card padded={false}>
        <CardHeader title="Largest claims" subtitle="By incurred loss" />
        <div className={styles.tableWrap}>
          <Table columns={columns} rows={d?.topClaims} loading={q.isLoading} rowKey={(r) => r.id} empty={<EmptyState icon={<ShieldAlert size={18} />} title="No claims" message="No claims are recorded against the book yet." />} skeletonRows={5} />
        </div>
      </Card>
    </>
  );
}

/* ---------------- Finance integration ---------------- */
function FinanceTab() {
  const q = useFinanceA();
  const d = q.data;
  const ta = d?.technicalAccount;
  return (
    <>
      <div className={styles.kpis}>
        <KpiCard label="Premium" value={d ? compact(d.totals.premiumMinor) : '—'} hint="Booked premium" icon={<Wallet size={20} />} accent="var(--primary)" loading={q.isLoading} />
        <KpiCard label="Commission" value={d ? compact(d.totals.commissionMinor) : '—'} hint="Ceding + brokerage" icon={<Receipt size={20} />} accent="var(--accent-violet)" loading={q.isLoading} />
        <KpiCard label="Claims paid" value={d ? compact(d.totals.claimsMinor) : '—'} hint="Loss settlements" icon={<ShieldAlert size={20} />} accent="var(--accent-rose)" loading={q.isLoading} />
        <KpiCard label="Combined ratio" value={ta ? `${ta.combinedRatioPct}%` : '—'} hint="Loss + commission" icon={<Percent size={20} />} accent="var(--accent-orange)" loading={q.isLoading} />
        <KpiCard label="Technical result" value={ta ? compact(ta.technicalResultMinor) : '—'} hint="Bottom line" icon={<Landmark size={20} />} accent="var(--accent-emerald)" loading={q.isLoading} />
      </div>
      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="Ledger by event type" subtitle="Financial event mix" actions={<DollarSign size={16} />} />
          <div className={styles.chartBody}><BarChart data={(d?.byType ?? []).map((r) => ({ label: titleCase(r.key.replace(/_/g, ' ')), value: r.amountMinor / 100 }))} emptyLabel="No financial events yet" /></div>
        </Card>
        <Card padded={false}>
          <CardHeader title="Net cash flow" subtitle="Inflow − outflow by month" actions={<TrendingUp size={16} />} />
          <div className={styles.chartBody}><BarChart data={(d?.cashflow ?? []).map((r) => ({ label: r.key, value: r.netMinor / 100, status: r.netMinor >= 0 ? 'green' : 'red' }))} metaColors={{ green: 'var(--c-green)', red: 'var(--c-red)' }} emptyLabel="No cash flow yet" /></div>
        </Card>
      </div>
      {ta && (
        <Card padded>
          <CardHeader title="Technical account" subtitle="The underwriting P&L" />
          <div className={styles.statRow}>
            <Stat label="Premium" value={money(ta.premiumMinor)} />
            <Stat label="Commission" value={money(ta.commissionMinor)} />
            <Stat label="Claims" value={money(ta.claimsMinor)} />
            <Stat label="Loss ratio" value={`${ta.lossRatioPct}%`} />
            <Stat label="Commission ratio" value={`${ta.commissionRatioPct}%`} />
            <Stat label="Combined ratio" value={`${ta.combinedRatioPct}%`} status={crStatus(ta.combinedRatioPct)} />
            <Stat label="Technical result" value={money(ta.technicalResultMinor)} status={ta.technicalResultMinor >= 0 ? 'green' : 'red'} />
          </div>
        </Card>
      )}
    </>
  );
}

/* ---------------- Retrocession ---------------- */
function RetroTab() {
  const q = useRetroA();
  const d = q.data;
  const columns: Column<NonNullable<typeof d>['programmes'][number]>[] = [
    { key: 'name', header: 'Programme', render: (r) => (<div><div className={styles.cellMain}>{r.name}</div><div className={styles.cellSub}>{r.reference ?? '—'}</div></div>) },
    { key: 'basis', header: 'Basis', render: (r) => <Badge color="indigo">{titleCase((r.npType ?? r.basis).replace(/_/g, ' '))}</Badge> },
    { key: 'period', header: 'Period', render: (r) => <span className={styles.cellSub}>{r.periodStart ? `${r.periodStart} → ${r.periodEnd ?? '?'}` : '—'}</span> },
    { key: 'status', header: 'Status', align: 'right', render: (r) => <Badge color="slate">{titleCase(r.status)}</Badge> },
  ];
  return (
    <>
      <div className={styles.kpis}>
        <KpiCard label="Retro programmes" value={String(d?.summary.programmes ?? 0)} hint="Outwards protections" icon={<ArrowLeftRight size={20} />} accent="var(--primary)" loading={q.isLoading} />
        <KpiCard label="Layers" value={String(d?.summary.layers ?? 0)} hint="Across programmes" icon={<Layers size={20} />} accent="var(--accent-violet)" loading={q.isLoading} />
        <KpiCard label="Ceded premium" value={d ? compact(d.summary.cededPremiumMinor) : '—'} hint="Outwards premium" icon={<Wallet size={20} />} accent="var(--accent-cyan)" loading={q.isLoading} />
        <KpiCard label="Recovered" value={d ? compact(d.summary.recoveredMinor) : '—'} hint="Retro recoveries" icon={<Undo2 size={20} />} accent="var(--accent-emerald)" loading={q.isLoading} />
      </div>
      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="Programme mix" subtitle="By structure" actions={<ArrowLeftRight size={16} />} />
          <div className={styles.chartBody}><DonutChart data={(d?.byStructure ?? []).map((r) => ({ label: titleCase(r.key.replace(/_/g, ' ')), value: r.n }))} /></div>
        </Card>
        <Card padded>
          <CardHeader title="Recoveries" subtitle="Ceded losses recovered vs outstanding" />
          <div className={styles.statRow}>
            <Stat label="Recovered" value={money(d?.summary.recoveredMinor)} status="green" />
            <Stat label="Outstanding" value={money(d?.summary.outstandingMinor)} status="amber" />
            <Stat label="Ceded premium" value={money(d?.summary.cededPremiumMinor)} />
          </div>
        </Card>
      </div>
      <Card padded={false}>
        <CardHeader title="Retrocession programmes" subtitle="Outwards / retro contracts" />
        <div className={styles.tableWrap}>
          <Table columns={columns} rows={d?.programmes} loading={q.isLoading} rowKey={(r) => r.id} empty={<EmptyState icon={<ArrowLeftRight size={18} />} title="No retrocession" message="No outwards or retrocession programmes are recorded yet." />} skeletonRows={5} />
        </div>
      </Card>
    </>
  );
}

/* ---------------- Small stat cell ---------------- */
function Stat({ label, value, status }: { label: string; value: string; status?: string }) {
  return (
    <div className={styles.stat} data-status={status}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}
