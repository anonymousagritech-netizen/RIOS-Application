import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Layers, Gauge, Wallet, PiggyBank, TrendingUp, AlertTriangle,
  ShieldAlert, PlusCircle, SlidersHorizontal,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { BarChart } from '../components/BarChart';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Select, TextField } from '../components/Form';
import type { TokenColor } from '../lib/status';
import { titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';
import styles from './CapacityPage.module.css';

/* ---------------- Types (mirror the /api/underwriting/capacity contract) ---------------- */
type Dimension = 'OVERALL' | 'GEOGRAPHY' | 'LINE_OF_BUSINESS' | 'PERIL' | 'BROKER' | 'CEDENT';
type LineStatus = 'OK' | 'WATCH' | 'WARN' | 'BREACH';

interface CapacityLine {
  id?: string;
  dimension: string;
  dimKey: string;
  label: string;
  availableMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  utilisationPct: number;
  status: LineStatus;
  warnPct: number;
}
interface CapacityBook {
  availableMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  utilisationPct: number;
  breaches: number;
  warnings: number;
  lines: CapacityLine[];
}
interface CapacityAlert {
  dimension: string;
  dimKey: string;
  label: string;
  severity: 'high' | 'medium';
  utilisationPct: number;
  message: string;
}
interface CapacityForecast {
  projectedConsumedMinor: number;
  projectedUtilisationPct: number;
  willBreach: boolean;
}
interface CapacityResponse {
  book: CapacityBook;
  alerts: CapacityAlert[];
  forecast: CapacityForecast;
  fractionElapsed: number;
}

/* ---------------- Constants ---------------- */
const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: 'OVERALL', label: 'All' },
  { key: 'GEOGRAPHY', label: 'Geography' },
  { key: 'LINE_OF_BUSINESS', label: 'Line' },
  { key: 'PERIL', label: 'Peril' },
  { key: 'BROKER', label: 'Broker' },
  { key: 'CEDENT', label: 'Cedent' },
];
const NEW_LINE_DIMENSIONS: Dimension[] = ['GEOGRAPHY', 'LINE_OF_BUSINESS', 'PERIL', 'BROKER', 'CEDENT'];

const STATUS_COLOR: Record<LineStatus, TokenColor> = {
  OK: 'green', WATCH: 'blue', WARN: 'orange', BREACH: 'red',
};
const DIM_COLOR: Record<string, TokenColor> = {
  OVERALL: 'slate', GEOGRAPHY: 'teal', LINE_OF_BUSINESS: 'indigo',
  PERIL: 'violet', BROKER: 'blue', CEDENT: 'amber',
};
// So the BarChart maps our status strings straight through to token colours.
const BAR_META: Record<string, string> = { red: 'red', amber: 'amber', blue: 'blue', green: 'green' };

const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
const compact = (minor: number, ccy = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);
const dimLabel = (d: string) => titleCase(d.replace(/_/g, ' '));
const barStatus = (s: LineStatus) => (s === 'BREACH' ? 'red' : s === 'WARN' ? 'amber' : s === 'WATCH' ? 'blue' : 'green');

/* ---------------- Data hook ---------------- */
function useCapacity(dimension: Dimension) {
  return useQuery({
    queryKey: ['capacity', dimension],
    queryFn: () => api<CapacityResponse>(`/api/underwriting/capacity${dimension !== 'OVERALL' ? `?dimension=${dimension}` : ''}`),
  });
}

export function CapacityPage() {
  const [dimension, setDimension] = useState<Dimension>('OVERALL');
  const [showNew, setShowNew] = useState(false);
  const [consumeLine, setConsumeLine] = useState<CapacityLine | null>(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('treaty:write');

  const { data, isLoading } = useCapacity(dimension);
  const book = data?.book;
  const alerts = data?.alerts ?? [];
  const forecast = data?.forecast;

  const utilAccent =
    book && book.utilisationPct >= 100 ? 'var(--accent-rose)'
      : book && book.utilisationPct >= 85 ? 'var(--accent-orange)'
        : 'var(--accent-emerald)';

  const barData = (book?.lines ?? []).map((l) => ({
    label: l.label || l.dimKey,
    value: l.utilisationPct,
    status: barStatus(l.status),
  }));

  const columns: Column<CapacityLine>[] = [
    {
      key: 'dimension', header: 'Dimension', sortValue: (r) => r.dimension,
      render: (r) => <Badge color={DIM_COLOR[r.dimension] ?? 'slate'}>{dimLabel(r.dimension)}</Badge>,
    },
    {
      key: 'line', header: 'Line', sortValue: (r) => r.label || r.dimKey,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.label || r.dimKey}</div>
          <div className={styles.cellSub}>{r.dimKey}</div>
        </div>
      ),
    },
    { key: 'available', header: 'Available', align: 'right', sortValue: (r) => r.availableMinor, render: (r) => <span className={styles.num}>{money(r.availableMinor)}</span> },
    { key: 'consumed', header: 'Consumed', align: 'right', sortValue: (r) => r.consumedMinor, render: (r) => <span className={styles.num}>{money(r.consumedMinor)}</span> },
    { key: 'remaining', header: 'Remaining', align: 'right', sortValue: (r) => r.remainingMinor, render: (r) => <span className={styles.num}>{money(r.remainingMinor)}</span> },
    {
      key: 'util', header: 'Utilisation', align: 'right', sortValue: (r) => r.utilisationPct,
      render: (r) => (
        <div className={styles.utilCell}>
          <div className={styles.utilBar}>
            <span className={styles.utilFill} data-status={r.status} style={{ width: `${Math.min(100, r.utilisationPct)}%` }} />
          </div>
          <Badge color={STATUS_COLOR[r.status] ?? 'gray'}>{r.utilisationPct}%</Badge>
        </div>
      ),
    },
  ];
  if (canWrite) {
    columns.push({
      key: 'actions', header: '', align: 'right',
      render: (r) => r.id ? (
        <Button size="sm" variant="ghost" icon={<SlidersHorizontal size={13} />} onClick={(e) => { e.stopPropagation(); setConsumeLine(r); }}>Set consumed</Button>
      ) : <span className={styles.cellSub}>—</span>,
    });
  }

  return (
    <>
      <PageHeader
        title="Capacity Management"
        description="Track available, consumed and remaining underwriting capacity across the book, with breach and warning alerts before you overcommit."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Underwriting', to: '/underwriting' }, { label: 'Capacity' }]}
        actions={canWrite ? (
          <Button variant="primary" icon={<PlusCircle size={16} />} onClick={() => setShowNew(true)}>New capacity line</Button>
        ) : undefined}
      />

      <div className={styles.kpis}>
        <KpiCard label="Available" value={book ? compact(book.availableMinor) : '—'} hint="Total underwriting capacity" icon={<Wallet size={20} />} accent="var(--primary)" loading={isLoading} />
        <KpiCard label="Consumed" value={book ? compact(book.consumedMinor) : '—'} hint="Committed to date" icon={<Layers size={20} />} accent="var(--accent-violet)" loading={isLoading} />
        <KpiCard label="Remaining" value={book ? compact(book.remainingMinor) : '—'} hint="Headroom to deploy" icon={<PiggyBank size={20} />} accent="var(--accent-emerald)" loading={isLoading} />
        <KpiCard
          label="Utilisation"
          value={book ? `${book.utilisationPct}%` : '—'}
          hint={book ? `${book.breaches} breaches / ${book.warnings} warnings` : undefined}
          icon={<Gauge size={20} />}
          accent={utilAccent}
          loading={isLoading}
        />
        <KpiCard
          label="Forecast utilisation"
          value={forecast ? `${forecast.projectedUtilisationPct}%` : '—'}
          hint={forecast ? (
            forecast.willBreach
              ? <span className={styles.forecastBreach}><AlertTriangle size={12} /> Projected to breach</span>
              : <span className={styles.forecastOk}>Within capacity at year-end</span>
          ) : undefined}
          icon={<TrendingUp size={20} />}
          accent={forecast?.willBreach ? 'var(--accent-rose)' : 'var(--accent-cyan)'}
          loading={isLoading}
        />
      </div>

      {alerts.length > 0 && (
        <Card padded style={{ marginBottom: 'var(--space-5)' }}>
          <CardHeader
            title={<span className={styles.chipRow}><ShieldAlert size={16} /> Capacity alerts</span>}
            subtitle="Lines at or near their capacity limit"
          />
          <ul className={styles.alertList}>
            {alerts.map((a) => (
              <li key={`${a.dimension}:${a.dimKey}`} className={`${styles.alertItem} ${a.severity === 'high' ? styles.alertHigh : styles.alertMedium}`}>
                <span className={styles.alertIcon}>
                  {a.severity === 'high' ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}
                </span>
                <div className={styles.alertMain}>
                  <span className={styles.alertLabel}>{a.label || a.dimKey} · {dimLabel(a.dimension)}</span>
                  <span className={styles.alertMsg}>{a.message}</span>
                </div>
                <span className={styles.alertUtil}>{a.utilisationPct}%</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card padded style={{ marginBottom: 'var(--space-5)' }}>
        <CardHeader title="Utilisation by line" subtitle="Capacity consumed as a percentage of the limit" />
        {isLoading ? (
          <p className={styles.cellSub}>Loading capacity…</p>
        ) : (
          <BarChart data={barData} metaColors={BAR_META} emptyLabel="No capacity lines defined yet" />
        )}
      </Card>

      <Card padded={false}>
        <CardHeader title="Capacity lines" subtitle="Every capacity control and how much of it is committed" />
        <div className={styles.filterBar}>
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              className={`${styles.filterChip} ${dimension === d.key ? styles.filterActive : ''}`}
              onClick={() => setDimension(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={book?.lines}
            loading={isLoading}
            rowKey={(r) => r.id ?? `${r.dimension}:${r.dimKey}`}
            empty={<EmptyState icon={<Gauge size={18} />} title="No capacity lines" message="Define a capacity line to start tracking utilisation, warnings and breaches." />}
            skeletonRows={5}
          />
        </div>
      </Card>

      <NewLineModal open={showNew} onClose={() => setShowNew(false)} />
      <ConsumeModal line={consumeLine} onClose={() => setConsumeLine(null)} />
    </>
  );
}

/* ---------------- New capacity line ---------------- */
function NewLineModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    dimension: 'GEOGRAPHY' as Dimension, dimKey: '', label: '', period: '',
    available: '', consumed: '', warnPct: '85', notes: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const numv = (v: string) => (v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/underwriting/capacity/lines', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['capacity'] });
      toast.success('Capacity line created');
      onClose();
      setF({ dimension: 'GEOGRAPHY', dimKey: '', label: '', period: '', available: '', consumed: '', warnPct: '85', notes: '' });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the capacity line.'),
  });

  const submit = () => {
    setError(null);
    create.mutate({
      dimension: f.dimension,
      dimKey: f.dimKey.trim(),
      label: f.label.trim() || undefined,
      period: f.period.trim() || undefined,
      available: numv(f.available),
      consumed: numv(f.consumed),
      warnPct: numv(f.warnPct),
      notes: f.notes.trim() || undefined,
    });
  };

  const validAvailable = numv(f.available) !== undefined && (numv(f.available) as number) > 0;

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="New capacity line"
      description="Define an underwriting capacity control. Amounts are in major currency units."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!f.dimKey.trim() || !validAvailable}>Create line</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Scope">
          <FormField label="Dimension">
            <Select value={f.dimension} onChange={(e) => set('dimension')(e.target.value)}>
              {NEW_LINE_DIMENSIONS.map((d) => <option key={d} value={d}>{dimLabel(d)}</option>)}
            </Select>
          </FormField>
          <TextField label="Dimension key" value={f.dimKey} onChange={set('dimKey')} required placeholder="e.g. WINDSTORM / US / PROPERTY" hint="The specific value this capacity controls." />
          <TextField label="Label" value={f.label} onChange={set('label')} placeholder="Human-friendly name (optional)" />
          <TextField label="Period" value={f.period} onChange={set('period')} placeholder="e.g. 2026" />
        </FormSection>

        <FormSection title="Limits" description="Enter amounts in major units (e.g. 50000000).">
          <TextField label="Available capacity (major)" type="number" value={f.available} onChange={set('available')} required placeholder="e.g. 50000000" />
          <TextField label="Consumed so far (major)" type="number" value={f.consumed} onChange={set('consumed')} placeholder="e.g. 12000000" />
          <TextField label="Warn threshold %" type="number" value={f.warnPct} onChange={set('warnPct')} placeholder="e.g. 85" hint="Utilisation at which this line warns." />
        </FormSection>

        <FormSection title="Notes">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Notes" value={f.notes} onChange={set('notes')} placeholder="Optional context" />
          </div>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/* ---------------- Set consumed ---------------- */
function ConsumeModal({ line, onClose }: { line: CapacityLine | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Seed the input with the current consumed amount (major) whenever a new line opens.
  const seededFor = line?.id ?? null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (line && seededFor !== seeded) {
    setSeeded(seededFor);
    setValue(String(line.consumedMinor / 100));
    setError(null);
  }

  const consume = useMutation({
    mutationFn: (body: { consumed: number }) => api(`/api/underwriting/capacity/lines/${line!.id}/consume`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['capacity'] });
      toast.success('Capacity updated');
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not update capacity.'),
  });

  const submit = () => {
    setError(null);
    const n = Number(value);
    if (value.trim() === '' || Number.isNaN(n) || n < 0) { setError('Enter a valid consumed amount.'); return; }
    consume.mutate({ consumed: n });
  };

  return (
    <Modal
      open={!!line} onClose={onClose} size="sm"
      title="Set consumed capacity"
      description={line ? `${line.label || line.dimKey} · ${dimLabel(line.dimension)}` : undefined}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={consume.isPending}>Update</Button>
      </>}
    >
      {line && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <p className={styles.cellSub}>
            Available {money(line.availableMinor)} · currently {money(line.consumedMinor)} consumed ({line.utilisationPct}%).
          </p>
          <TextField label="Consumed (major)" type="number" value={value} onChange={setValue} placeholder="e.g. 25000000" />
          {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
