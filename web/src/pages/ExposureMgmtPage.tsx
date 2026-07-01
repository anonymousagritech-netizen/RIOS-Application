/**
 * Exposure Management — the underwriting aggregation / accumulation console.
 * Geographic (country / admin1 / CRESTA) and peril aggregation of insured
 * values (TIV) and modelled loss (PML), an accumulation table, a peril ×
 * country heatmap, and a raw exposure item register. Money is integer minor
 * units → divided by 100 for display. Writes gated on exposure:write.
 *
 * This is a distinct page from the existing /exposure accumulation view.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DollarSign, TrendingUp, Layers, MapPin, Plus, Flame, Waves, Grid3x3,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { BarChart, type BarDatum } from '../components/BarChart';
import { DonutChart, type DonutDatum } from '../components/DonutChart';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { titleCase } from '../lib/format';
import type { TokenColor } from '../lib/status';
import { useAuth } from '../lib/auth';
import styles from './ExposureMgmtPage.module.css';

/* ---------------- Formatting helpers (minor units → display) ---------------- */
const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
const compact = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);

const PERIL_COLOR: Record<string, TokenColor> = {
  HURRICANE: 'blue', WINDSTORM: 'teal', EARTHQUAKE: 'orange', FLOOD: 'indigo',
  WILDFIRE: 'red', HAIL: 'violet', TORNADO: 'amber', TERROR: 'rose',
};
const perilColor = (peril: string | null | undefined): TokenColor =>
  peril ? (PERIL_COLOR[peril.toUpperCase()] ?? 'slate') : 'gray';

/** Colour a concentration / share percentage: >40 red, >25 amber, else green. */
const shareColor = (pct: number | null | undefined): TokenColor =>
  pct == null ? 'gray' : pct > 40 ? 'red' : pct > 25 ? 'amber' : 'green';
const shareBar = (pct: number | null | undefined): 'red' | 'amber' | 'blue' =>
  pct == null ? 'blue' : pct > 40 ? 'red' : pct > 25 ? 'amber' : 'blue';

/* ---------------- API types (mirror server responses) ---------------- */
interface Bucket {
  key: string;
  items: number;
  tivMinor: number;
  pmlMinor: number;
  sharePct: number;
}
interface PeakZone {
  key: string;
  items: number;
  tivMinor: number;
  pmlMinor: number;
  sharePct: number;
}
interface HeatCell { row: string; col: string; tivMinor: number; }
interface Heatmap { rows: string[]; cols: string[]; cells: HeatCell[]; }
interface ExposureSummary {
  summary: {
    totalTivMinor: number;
    totalPmlMinor: number;
    itemCount: number;
    peakZone: PeakZone | null;
    concentrationPct: number;
    byCountry: Bucket[];
    byPeril: Bucket[];
    byLineOfBusiness: Bucket[];
  };
  byCresta: Bucket[];
  byAdmin1: Bucket[];
  heatmap: Heatmap;
}
interface ExposureItem {
  id: string;
  name: string;
  country: string;
  admin1: string;
  city: string;
  cresta: string;
  peril: string;
  lineOfBusiness: string;
  tivMinor: number;
  pmlMinor: number;
}
interface ItemsResponse { items: ExposureItem[]; }

interface NewExposureBody {
  name?: string;
  country?: string;
  admin1?: string;
  city?: string;
  cresta?: string;
  postal?: string;
  peril?: string;
  lineOfBusiness?: string;
  tiv: number;
  pml?: number;
}

/* ---------------- Data hooks ---------------- */
const useSummary = () => useQuery({
  queryKey: ['expmgmt', 'summary'],
  queryFn: () => api<ExposureSummary>('/api/underwriting/exposure/summary'),
});
const useItems = () => useQuery({
  queryKey: ['expmgmt', 'items'],
  queryFn: () => api<ItemsResponse>('/api/underwriting/exposure/items'),
});

const PERIL_OPTIONS = ['HURRICANE', 'WINDSTORM', 'EARTHQUAKE', 'FLOOD', 'WILDFIRE', 'HAIL', 'TORNADO', 'TERROR'];
const LOB_OPTIONS = ['PROPERTY', 'MARINE', 'ENERGY', 'ENGINEERING', 'AGRICULTURE', 'AVIATION', 'CASUALTY'];

/* ==================================================================== */
export function ExposureMgmtPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('exposure:write');
  const [addOpen, setAddOpen] = useState(false);

  const summaryQ = useSummary();
  const itemsQ = useItems();
  const s = summaryQ.data?.summary;
  const heatmap = summaryQ.data?.heatmap;
  const peak = s?.peakZone ?? null;

  // Prefer CRESTA accumulation; fall back to country when no CRESTA data.
  const accumulation: Bucket[] = useMemo(() => {
    const cresta = summaryQ.data?.byCresta ?? [];
    return cresta.length ? cresta : (s?.byCountry ?? []);
  }, [summaryQ.data, s]);
  const accumulationLabel = (summaryQ.data?.byCresta?.length ?? 0) > 0 ? 'CRESTA zone' : 'Country';

  /* Charts */
  const perilDonut: DonutDatum[] = useMemo(
    () => (s?.byPeril ?? []).filter((b) => b.tivMinor > 0)
      .map((b) => ({ label: titleCase(b.key), value: Math.round(b.tivMinor / 100), status: b.key })),
    [s],
  );
  const accumBar: BarDatum[] = useMemo(
    () => accumulation.slice(0, 8).map((b) => ({
      label: b.key,
      value: Math.round(b.tivMinor / 100),
      status: shareBar(b.sharePct),
    })),
    [accumulation],
  );

  return (
    <>
      <PageHeader
        title="Exposure Management"
        description="Geographic and peril aggregation of insured values, accumulation control, and concentration heatmaps across the underwriting exposure book."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Underwriting', to: '/underwriting' }, { label: 'Exposure' }]}
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
              Add exposure
            </Button>
          ) : (
            <Badge color="slate">Read-only</Badge>
          )
        }
      />

      {/* ---- KPIs ---- */}
      <div className={styles.kpis}>
        <KpiCard
          label="Total TIV" value={compact(s?.totalTivMinor)}
          hint="Total insured value" icon={<DollarSign size={20} />}
          accent="var(--primary)" loading={summaryQ.isLoading}
        />
        <KpiCard
          label="Total PML" value={compact(s?.totalPmlMinor)}
          hint="Probable maximum loss" icon={<TrendingUp size={20} />}
          accent="var(--accent-rose)" loading={summaryQ.isLoading}
        />
        <KpiCard
          label="Exposure items" value={String(s?.itemCount ?? 0)}
          hint="Aggregated locations" icon={<Layers size={20} />}
          accent="var(--accent-cyan)" loading={summaryQ.isLoading}
        />
        <KpiCard
          label="Peak zone"
          value={peak?.key ? titleCase(peak.key) : '—'}
          hint={peak
            ? `${s?.concentrationPct ?? 0}% of TIV · ${money(peak.tivMinor)}`
            : 'No accumulation yet'}
          icon={<MapPin size={20} />}
          accent={
            (s?.concentrationPct ?? 0) > 40 ? 'var(--accent-rose)'
              : (s?.concentrationPct ?? 0) > 25 ? 'var(--accent-orange)'
                : 'var(--accent-emerald)'
          }
          loading={summaryQ.isLoading}
        />
      </div>

      {/* ---- Charts ---- */}
      <div className={styles.grid2}>
        <Card padded={false}>
          <CardHeader title="Exposure by peril" subtitle="Share of TIV by natural / man-made peril" actions={<Flame size={16} />} />
          <div className={styles.chartBody}>
            {summaryQ.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <DonutChart data={perilDonut} centerValue={compact(s?.totalTivMinor)} centerLabel="TIV" emptyLabel="No peril-tagged exposure yet." />}
          </div>
        </Card>
        <Card padded={false}>
          <CardHeader title={`Top accumulation by ${accumulationLabel.toLowerCase()}`} subtitle="TIV concentration — bars flag heavy zones" actions={<Waves size={16} />} />
          <div className={styles.chartBody}>
            {summaryQ.isLoading ? <p className={styles.cellSub}>Loading…</p>
              : <BarChart data={accumBar} emptyLabel="No accumulation to show yet." />}
          </div>
        </Card>
      </div>

      {/* ---- Heatmap ---- */}
      <Card padded={false}>
        <CardHeader title="Peril × country heatmap" subtitle="TIV intensity relative to the heaviest cell" actions={<Grid3x3 size={16} />} />
        <Heatmap loading={summaryQ.isLoading} heatmap={heatmap} />
      </Card>

      {/* ---- Accumulation table ---- */}
      <Card padded={false}>
        <CardHeader
          title={`${accumulationLabel} accumulation`}
          subtitle="Aggregated insured value and modelled loss with concentration share"
        />
        <div className={styles.tableWrap}>
          <Table
            columns={accumColumns(accumulationLabel)}
            rows={summaryQ.isLoading ? undefined : accumulation}
            loading={summaryQ.isLoading}
            rowKey={(r) => r.key}
            empty={<EmptyState icon={<MapPin size={18} />} title="No accumulation" message="Add exposure items to build the accumulation view." />}
            skeletonRows={5}
          />
        </div>
      </Card>

      {/* ---- Exposure items register ---- */}
      <Card padded={false}>
        <CardHeader title="Exposure items" subtitle="The underlying locations feeding the aggregation" />
        <div className={styles.tableWrap}>
          <Table
            columns={itemColumns}
            rows={itemsQ.data?.items}
            loading={itemsQ.isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<Layers size={18} />} title="No exposure items" message={canWrite ? 'Use “Add exposure” to record an insured location.' : 'No insured locations recorded yet.'} />}
            skeletonRows={6}
          />
        </div>
      </Card>

      {canWrite && <AddExposureModal open={addOpen} onClose={() => setAddOpen(false)} />}
    </>
  );
}

/* ---------------- Accumulation table columns ---------------- */
function accumColumns(zoneLabel: string): Column<Bucket>[] {
  return [
    { key: 'zone', header: zoneLabel, sortValue: (r) => r.key, render: (r) => <span className={styles.cellMain}>{r.key}</span> },
    { key: 'items', header: 'Items', align: 'right', sortValue: (r) => r.items, render: (r) => <span className={styles.num}>{r.items}</span> },
    { key: 'tiv', header: 'TIV', align: 'right', sortValue: (r) => r.tivMinor, render: (r) => <span className={styles.num}>{money(r.tivMinor)}</span> },
    { key: 'pml', header: 'PML', align: 'right', sortValue: (r) => r.pmlMinor, render: (r) => <span className={styles.num}>{money(r.pmlMinor)}</span> },
    {
      key: 'share', header: 'Share', align: 'right', sortValue: (r) => r.sharePct,
      render: (r) => <Badge color={shareColor(r.sharePct)}>{r.sharePct}%</Badge>,
    },
  ];
}

/* ---------------- Exposure item table columns ---------------- */
const itemColumns: Column<ExposureItem>[] = [
  {
    key: 'name', header: 'Location', sortValue: (r) => r.name,
    render: (r) => (
      <div>
        <div className={styles.cellMain}>{r.name || 'Unnamed location'}</div>
        {r.city && <div className={styles.cellSub}>{r.city}</div>}
      </div>
    ),
  },
  {
    key: 'geo', header: 'Geography', sortValue: (r) => `${r.country}${r.admin1}`,
    render: (r) => (
      <div>
        <div className={styles.cellMain}>{[r.country, r.admin1].filter(Boolean).join(' · ') || '—'}</div>
        {r.cresta && <div className={styles.cellSub}>CRESTA {r.cresta}</div>}
      </div>
    ),
  },
  {
    key: 'peril', header: 'Peril',
    render: (r) => r.peril ? <Badge color={perilColor(r.peril)}>{titleCase(r.peril)}</Badge> : <span className={styles.cellSub}>—</span>,
  },
  { key: 'lob', header: 'Line', render: (r) => <span className={styles.cellSub}>{r.lineOfBusiness ? titleCase(r.lineOfBusiness) : '—'}</span> },
  { key: 'tiv', header: 'TIV', align: 'right', sortValue: (r) => r.tivMinor, render: (r) => <span className={styles.num}>{money(r.tivMinor)}</span> },
  { key: 'pml', header: 'PML', align: 'right', sortValue: (r) => r.pmlMinor, render: (r) => <span className={styles.num}>{money(r.pmlMinor)}</span> },
];

/* ---------------- Heatmap (peril rows × country cols) ---------------- */
function Heatmap({ loading, heatmap }: { loading: boolean; heatmap: Heatmap | undefined }) {
  const { rows, cols, get, maxTiv } = useMemo(() => {
    const r = heatmap?.rows ?? [];
    const c = heatmap?.cols ?? [];
    const m = new Map<string, number>();
    let mx = 0;
    for (const cell of heatmap?.cells ?? []) {
      m.set(`${cell.row}|${cell.col}`, cell.tivMinor);
      if (cell.tivMinor > mx) mx = cell.tivMinor;
    }
    return { rows: r, cols: c, get: (row: string, col: string) => m.get(`${row}|${col}`) ?? 0, maxTiv: Math.max(1, mx) };
  }, [heatmap]);

  if (loading) return <div className={styles.chartBody}><p className={styles.cellSub}>Loading…</p></div>;
  if (rows.length === 0 || cols.length === 0) {
    return (
      <div className={styles.chartBody}>
        <EmptyState icon={<Grid3x3 size={18} />} title="No heatmap" message="No exposure to cross-tabulate by peril and country yet." />
      </div>
    );
  }

  return (
    <div className={styles.heatScroll}>
      <div
        className={styles.heat}
        style={{ gridTemplateColumns: `minmax(7rem, auto) repeat(${cols.length}, minmax(4rem, 1fr))` }}
      >
        <div className={styles.heatCorner}>Peril</div>
        {cols.map((c) => <div key={c} className={styles.heatColHead}>{c}</div>)}
        {rows.map((r) => (
          <HeatRow key={r} peril={r} cols={cols} get={get} maxTiv={maxTiv} />
        ))}
      </div>
      <div className={styles.heatKey}>
        <span>Lower TIV</span>
        <span className={styles.heatKeyBar} aria-hidden />
        <span>Higher TIV</span>
      </div>
    </div>
  );
}

function HeatRow({
  peril, cols, get, maxTiv,
}: { peril: string; cols: string[]; get: (row: string, col: string) => number; maxTiv: number }) {
  return (
    <>
      <div className={styles.heatRowHead}>{titleCase(peril)}</div>
      {cols.map((c) => {
        const tiv = get(peril, c);
        const intensity = Math.round((tiv / maxTiv) * 100);
        const bg = tiv === 0
          ? 'var(--surface-2)'
          : `color-mix(in srgb, var(--primary) ${intensity}%, var(--surface-2))`;
        return (
          <div
            key={c}
            className={styles.heatCell}
            data-empty={tiv === 0}
            style={{ background: bg }}
            title={`${titleCase(peril)} · ${c}: ${money(tiv)}`}
          >
            {tiv === 0 ? '·' : compact(tiv)}
          </div>
        );
      })}
    </>
  );
}

/* ---------------- Add-exposure modal ---------------- */
function AddExposureModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [admin1, setAdmin1] = useState('');
  const [city, setCity] = useState('');
  const [cresta, setCresta] = useState('');
  const [postal, setPostal] = useState('');
  const [peril, setPeril] = useState('');
  const [lineOfBusiness, setLineOfBusiness] = useState('');
  const [tiv, setTiv] = useState('');
  const [pml, setPml] = useState('');

  const reset = () => {
    setName(''); setCountry(''); setAdmin1(''); setCity(''); setCresta('');
    setPostal(''); setPeril(''); setLineOfBusiness(''); setTiv(''); setPml('');
  };

  const mutation = useMutation({
    mutationFn: (body: NewExposureBody) =>
      api<ExposureItem>('/api/underwriting/exposure/items', { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['expmgmt', 'summary'] });
      void qc.invalidateQueries({ queryKey: ['expmgmt', 'items'] });
      toast.success('Exposure item added.');
      reset();
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Could not add exposure item.');
    },
  });

  const tivNum = Number(tiv);
  const pmlNum = pml.trim() === '' ? undefined : Number(pml);
  const countryValid = country.trim() === '' || /^[A-Za-z]{2}$/.test(country.trim());
  const tivValid = tiv.trim() !== '' && Number.isFinite(tivNum) && tivNum > 0;
  const pmlValid = pmlNum === undefined || (Number.isFinite(pmlNum) && pmlNum >= 0);
  const canSubmit = tivValid && countryValid && pmlValid && !mutation.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const body: NewExposureBody = {
      name: name.trim() || undefined,
      country: country.trim() ? country.trim().toUpperCase() : undefined,
      admin1: admin1.trim() || undefined,
      city: city.trim() || undefined,
      cresta: cresta.trim() || undefined,
      postal: postal.trim() || undefined,
      peril: peril || undefined,
      lineOfBusiness: lineOfBusiness || undefined,
      tiv: tivNum,
      pml: pmlNum,
    };
    mutation.mutate(body);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add exposure"
      description="Record an insured location. Amounts are entered in major currency units (e.g. dollars)."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-exposure-form" loading={mutation.isPending} disabled={!canSubmit}>
            Add exposure
          </Button>
        </>
      }
    >
      <form id="add-exposure-form" onSubmit={submit} className={styles.form}>
        <FormSection title="Location">
          <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Downtown Miami tower" />
          <TextField
            label="Country" value={country} onChange={setCountry}
            placeholder="2-letter, e.g. US"
            hint="ISO 3166-1 alpha-2 code"
            error={countryValid ? undefined : 'Use a 2-letter country code.'}
          />
          <TextField label="State / province (admin1)" value={admin1} onChange={setAdmin1} placeholder="e.g. FL" />
          <TextField label="City" value={city} onChange={setCity} placeholder="e.g. Miami" />
          <TextField label="CRESTA zone" value={cresta} onChange={setCresta} placeholder="e.g. US_12" />
          <TextField label="Postal code" value={postal} onChange={setPostal} placeholder="e.g. 33101" />
        </FormSection>

        <FormSection title="Classification">
          <FormField label="Peril">
            <Select value={peril} onChange={(e) => setPeril(e.target.value)}>
              <option value="">— Select peril —</option>
              {PERIL_OPTIONS.map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}
            </Select>
          </FormField>
          <FormField label="Line of business">
            <Select value={lineOfBusiness} onChange={(e) => setLineOfBusiness(e.target.value)}>
              <option value="">— Select line —</option>
              {LOB_OPTIONS.map((l) => <option key={l} value={l}>{titleCase(l)}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Values" description="Major units — TIV is required.">
          <TextField
            label="TIV" value={tiv} onChange={setTiv} type="number" required
            placeholder="e.g. 25000000"
            hint="Total insured value"
            error={tiv.trim() !== '' && !tivValid ? 'Enter a positive amount.' : undefined}
          />
          <TextField
            label="PML" value={pml} onChange={setPml} type="number"
            placeholder="Optional"
            hint="Probable maximum loss"
            error={!pmlValid ? 'Enter a non-negative amount.' : undefined}
          />
        </FormSection>
      </form>
    </Modal>
  );
}
