/**
 * Territory Management — a cross-module geographic roll-up combining the exposure
 * register (TIV / PML) with geographic capacity (available / consumed) per
 * country, so an underwriter sees concentration and remaining capacity together.
 * Read-only, gated on exposure:read. Money is integer minor units.
 */

import { useQuery } from '@tanstack/react-query';
import { Globe2, Layers, Gauge, ShieldAlert, Download } from 'lucide-react';
import { api, downloadFile } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { BarChart } from '../components/BarChart';
import { titleCase } from '../lib/format';
import type { TokenColor } from '../lib/status';
import styles from './TerritoriesPage.module.css';

interface Territory {
  code: string; name: string; items: number; tivMinor: number; pmlMinor: number;
  availableMinor: number; consumedMinor: number; remainingMinor: number; utilisationPct: number; status: string; sharePct: number;
}
interface TerritoriesResp {
  territories: Territory[];
  totals: { count: number; tivMinor: number; pmlMinor: number; availableMinor: number; consumedMinor: number };
}

const money = (m?: number | null, ccy = 'USD') => (m == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(m / 100));
const compact = (m?: number | null, ccy = 'USD') => (m == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(m / 100));

const STATUS_COLOR: Record<string, TokenColor> = { OK: 'green', WATCH: 'blue', WARN: 'amber', BREACH: 'red' };
const shareColor = (s: number): TokenColor => (s > 40 ? 'red' : s > 25 ? 'amber' : 'blue');

export function TerritoriesPage() {
  const q = useQuery({ queryKey: ['territories'], queryFn: () => api<TerritoriesResp>('/api/territories') });
  const d = q.data;
  const t = d?.totals;
  const util = t && t.availableMinor > 0 ? Math.round((t.consumedMinor / t.availableMinor) * 100) : 0;

  const columns: Column<Territory>[] = [
    { key: 'name', header: 'Territory', sortValue: (r) => r.name, render: (r) => (<div><div className={styles.cellMain}>{r.name}</div><div className={styles.cellSub}>{r.code} · {r.items} location(s)</div></div>) },
    { key: 'tiv', header: 'Exposure TIV', align: 'right', sortValue: (r) => r.tivMinor, render: (r) => <span className={styles.num}>{money(r.tivMinor)}</span> },
    { key: 'pml', header: 'PML', align: 'right', render: (r) => <span className={styles.num}>{money(r.pmlMinor)}</span> },
    { key: 'share', header: 'Share', align: 'right', render: (r) => <Badge color={shareColor(r.sharePct)}>{r.sharePct}%</Badge> },
    { key: 'cap', header: 'Capacity', align: 'right', render: (r) => <span className={styles.num}>{compact(r.availableMinor)}</span> },
    { key: 'util', header: 'Utilisation', align: 'right', render: (r) => r.availableMinor > 0 ? <Badge color={STATUS_COLOR[r.status] ?? 'gray'}>{r.utilisationPct}%</Badge> : <span className={styles.cellSub}>—</span> },
  ];

  return (
    <>
      <PageHeader
        title="Territory Management"
        description="Geographic concentration and remaining capacity by territory — exposure and capacity in one view."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Underwriting', to: '/underwriting' }, { label: 'Territories' }]}
        actions={<Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadFile('/api/territories/export.csv', 'territories.csv')}>Export CSV</Button>}
      />

      <div className={styles.kpis}>
        <KpiCard label="Territories" value={String(t?.count ?? 0)} hint="Countries in the book" icon={<Globe2 size={20} />} accent="var(--primary)" loading={q.isLoading} />
        <KpiCard label="Total TIV" value={t ? compact(t.tivMinor) : '—'} hint="Insured value" icon={<Layers size={20} />} accent="var(--accent-cyan)" loading={q.isLoading} />
        <KpiCard label="Total PML" value={t ? compact(t.pmlMinor) : '—'} hint="Probable maximum loss" icon={<ShieldAlert size={20} />} accent="var(--accent-rose)" loading={q.isLoading} />
        <KpiCard label="Capacity utilisation" value={`${util}%`} hint={`${t ? compact(t.consumedMinor) : '—'} of ${t ? compact(t.availableMinor) : '—'}`} icon={<Gauge size={20} />} accent="var(--accent-orange)" loading={q.isLoading} />
      </div>

      <Card padded={false}>
        <CardHeader title="Exposure by territory" subtitle="TIV concentration — bars flag heavy zones" actions={<Globe2 size={16} />} />
        <div className={styles.chartBody}>
          <BarChart
            data={(d?.territories ?? []).slice(0, 10).map((r) => ({ label: r.name, value: r.tivMinor / 100, status: r.sharePct > 40 ? 'red' : r.sharePct > 25 ? 'amber' : 'blue' }))}
            metaColors={{ red: 'var(--c-red)', amber: 'var(--c-amber)', blue: 'var(--c-blue)' }}
            emptyLabel="No exposure yet"
          />
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader title="Territories" subtitle="Exposure and capacity, largest first" />
        <div className={styles.tableWrap}>
          <Table columns={columns} rows={d?.territories} loading={q.isLoading} rowKey={(r) => r.code}
            empty={<EmptyState icon={<Globe2 size={18} />} title="No territories" message="Register exposure or geographic capacity to build the territory view." />}
            skeletonRows={6} />
        </div>
      </Card>
    </>
  );
}
