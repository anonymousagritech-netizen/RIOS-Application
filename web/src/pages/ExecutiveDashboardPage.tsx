import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Crown, Landmark, Gavel, Activity, Banknote, ShieldAlert, Globe2, Radar,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { BarChart } from '../components/BarChart';
import { DonutChart } from '../components/DonutChart';
import { PageLoader } from '../components/Feedback';
import { formatMoneyCompact, formatNumber, formatPercent } from '../lib/format';
import styles from './ExecutiveDashboardPage.module.css';

/* ---------------- Types (mirror the /api/executive contract) ---------------- */
type Fmt = 'MONEY' | 'INT' | 'PCT';
type Intent = 'good' | 'warn' | 'bad';
interface Kpi { label: string; value: number; format: Fmt; hint?: string; intent?: Intent }
interface ChartDatum { label: string; value: number; status?: string }
interface Chart { title: string; kind: 'bar' | 'donut'; data: ChartDatum[]; money?: boolean }
interface Pack { kpis: Kpi[]; charts: Chart[] }
interface Persona { key: string; label: string; tagline: string }
interface ExecResponse { personas: Persona[]; statusMeta: Record<string, string>; packs: Record<string, Pack> }

const PERSONA_ICON: Record<string, LucideIcon> = {
  CEO: Crown, CFO: Landmark, CHIEF_UW: Gavel, OPERATIONS: Activity,
  FINANCE: Banknote, CLAIMS: ShieldAlert, PORTFOLIO: Globe2, RISK: Radar,
};

// Risk-band colours for the Risk persona's country-score chart.
const BAND_META: Record<string, string> = {
  LOW: 'slate', MODERATE: 'blue', ELEVATED: 'amber', HIGH: 'orange', SEVERE: 'red',
};

const ACCENT: Record<Intent | 'none', string> = {
  good: 'var(--accent-emerald)', warn: 'var(--accent-amber, var(--c-amber))',
  bad: 'var(--c-red)', none: 'var(--primary)',
};

function kpiValue(k: Kpi): string {
  if (k.format === 'MONEY') return formatMoneyCompact(k.value, 'USD');
  if (k.format === 'PCT') return formatPercent(k.value);
  return formatNumber(k.value);
}

export function ExecutiveDashboardPage() {
  const [active, setActive] = useState('CEO');
  const { data, isLoading } = useQuery({
    queryKey: ['executive'],
    queryFn: () => api<ExecResponse>('/api/executive'),
  });

  if (isLoading || !data) {
    return (
      <div className={styles.page}>
        <PageHeader title="Executive Intelligence" description="Real-time boardroom KPIs across the whole platform." />
        <PageLoader />
      </div>
    );
  }

  const personas = data.personas;
  const pack = data.packs[active];
  const current = personas.find((p) => p.key === active);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Executive Intelligence"
        description="Real-time boardroom KPIs aggregated live across treaties, finance, claims, exposure, capacity and operations."
        crumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'Executive Intelligence' }]}
      />

      {/* Persona selector */}
      <div className={styles.tabRow} role="tablist" aria-label="Executive personas">
        {personas.map((p) => {
          const Icon = PERSONA_ICON[p.key] ?? Activity;
          return (
            <button
              key={p.key}
              role="tab"
              aria-selected={active === p.key}
              className={`${styles.tab} ${active === p.key ? styles.tabActive : ''}`}
              onClick={() => setActive(p.key)}
            >
              <Icon size={16} aria-hidden />
              <span>{p.label}</span>
            </button>
          );
        })}
      </div>

      {current && <p className={styles.tagline}>{current.tagline}</p>}

      {!pack ? (
        <Card><p className={styles.empty}>No data available for this view yet.</p></Card>
      ) : (
        <>
          <div className={styles.kpiGrid}>
            {pack.kpis.map((k, i) => {
              const Icon = PERSONA_ICON[active] ?? Activity;
              return (
                <KpiCard
                  key={`${k.label}-${i}`}
                  label={k.label}
                  value={kpiValue(k)}
                  hint={k.hint}
                  icon={<Icon size={18} />}
                  accent={ACCENT[k.intent ?? 'none']}
                />
              );
            })}
          </div>

          <div className={styles.chartGrid}>
            {pack.charts.map((c, i) => {
              const meta = c.data.some((d) => d.status && BAND_META[d.status]) ? BAND_META : data.statusMeta;
              // Money charts carry raw minor units — scale to USD millions for a legible axis.
              const chartData = c.money
                ? c.data.map((d) => ({ ...d, value: Math.round((d.value / 100 / 1_000_000) * 10) / 10 }))
                : c.data;
              const total = chartData.reduce((s, d) => s + d.value, 0);
              const title = c.money ? `${c.title} (USD m)` : c.title;
              return (
                <Card key={`${c.title}-${i}`}>
                  <CardHeader title={title} />
                  {c.kind === 'donut' ? (
                    <DonutChart
                      data={chartData}
                      metaColors={meta}
                      centerValue={formatNumber(total)}
                      centerLabel="total"
                    />
                  ) : (
                    <BarChart data={chartData} metaColors={meta} />
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
