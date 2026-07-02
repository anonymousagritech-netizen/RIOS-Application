import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileText, CheckCircle2, Users, ShieldAlert, Wallet, PiggyBank,
  Plus, ArrowRight, BarChart3, Clock, LayoutDashboard, Pencil,
  ArrowUp, ArrowDown, X, Trash2, Save, Activity, type LucideIcon,
} from 'lucide-react';
import { useDashboard, useStatusColors } from '../lib/queries';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { KpiCard } from '../components/KpiCard';
import { Card, CardHeader } from '../components/Card';
import { DonutChart } from '../components/DonutChart';
import { BarChart } from '../components/BarChart';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { ErrorState, PageLoader } from '../components/Feedback';
import { formatMoneyCompact, formatNumber, formatPercent } from '../lib/format';
import { CHART_DRILL } from './ExecutiveDashboardPage';
import type { DashboardSummary } from '../lib/types';
import shared from './shared.module.css';
import styles from './DashboardPage.module.css';

type RecentTreaty = DashboardSummary['recentTreaties'][number];

const QUICK_ACTIONS = [
  { label: 'New treaty', to: '/treaties', icon: Plus, accent: 'var(--primary)' },
  { label: 'Parties', to: '/parties', icon: Users, accent: 'var(--accent-cyan)' },
  { label: 'Claims', to: '/claims', icon: ShieldAlert, accent: 'var(--accent-orange)' },
  { label: 'Reports', to: '/reports', icon: BarChart3, accent: 'var(--accent-emerald)' },
  { label: 'Attendance', to: '/attendance', icon: Clock, accent: 'var(--accent-violet)' },
];

/* ---------------- Executive pack contract (mirrors /api/executive) ---------------- */
type Fmt = 'MONEY' | 'INT' | 'PCT';
type Intent = 'good' | 'warn' | 'bad';
interface Kpi { label: string; value: number; format: Fmt; hint?: string; intent?: Intent }
interface ChartDatum { label: string; value: number; status?: string }
interface Chart { title: string; kind: 'bar' | 'donut'; data: ChartDatum[]; money?: boolean }
interface Pack { kpis: Kpi[]; charts: Chart[] }
interface Persona { key: string; label: string; tagline: string }
interface ExecResponse { personas: Persona[]; statusMeta: Record<string, string>; packs: Record<string, Pack> }

/* ---------------- Saved layout contract (mirrors /api/dashboards/layouts) ---------------- */
type TileSize = 'sm' | 'md' | 'lg';
interface Tile { persona: string; kind: 'kpi' | 'chart'; ref: string; size: TileSize }
interface Layout { id: string; name: string; tiles: Tile[]; isDefault: boolean; shared: boolean; owned: boolean }

const PERSONA_ICON: Record<string, LucideIcon> = {
  CEO: Wallet, CFO: PiggyBank, CHIEF_UW: FileText, OPERATIONS: Activity,
  FINANCE: BarChart3, CLAIMS: ShieldAlert, PORTFOLIO: Users, RISK: ShieldAlert,
};
const BAND_META: Record<string, string> = { LOW: 'slate', MODERATE: 'blue', ELEVATED: 'amber', HIGH: 'orange', SEVERE: 'red' };
const ACCENT: Record<Intent | 'none', string> = {
  good: 'var(--accent-emerald)', warn: 'var(--accent-amber, var(--c-amber))',
  bad: 'var(--c-red)', none: 'var(--primary)',
};
const sizeClass = (s: TileSize): string =>
  (s === 'sm' ? styles.tileSm : s === 'md' ? styles.tileMd : styles.tileLg) ?? '';

function kpiValue(k: Kpi): string {
  if (k.format === 'MONEY') return formatMoneyCompact(k.value, 'USD');
  if (k.format === 'PCT') return formatPercent(k.value);
  return formatNumber(k.value);
}

/* Render a single saved tile by resolving its ref against the LIVE exec packs. */
function TileView({ tile, exec }: { tile: Tile; exec: ExecResponse }) {
  const navigate = useNavigate();
  const pack = exec.packs[tile.persona];
  if (tile.kind === 'kpi') {
    const k = pack?.kpis.find((x) => x.label === tile.ref);
    if (!k) return <div className={styles.tileMissing}>Tile unavailable: {tile.ref}</div>;
    const Icon = PERSONA_ICON[tile.persona] ?? Activity;
    return <KpiCard label={k.label} value={kpiValue(k)} hint={k.hint} icon={<Icon size={18} />} accent={ACCENT[k.intent ?? 'none']} />;
  }
  const c = pack?.charts.find((x) => x.title === tile.ref);
  if (!c) return <div className={styles.tileMissing}>Tile unavailable: {tile.ref}</div>;
  const meta = c.data.some((d) => d.status && BAND_META[d.status]) ? BAND_META : exec.statusMeta;
  const chartData = c.money
    ? c.data.map((d) => ({ ...d, value: Math.round((d.value / 100 / 1_000_000) * 10) / 10 }))
    : c.data;
  const total = chartData.reduce((s, d) => s + d.value, 0);
  const title = c.money ? `${c.title} (USD m)` : c.title;
  const drill = CHART_DRILL[c.title];
  const onSegmentClick = drill ? (d: ChartDatum) => navigate(drill(d.label)) : undefined;
  return (
    <Card>
      <CardHeader title={title} />
      {c.kind === 'donut'
        ? <DonutChart data={chartData} metaColors={meta} centerValue={formatNumber(total)} centerLabel="total" onSegmentClick={onSegmentClick} />
        : <BarChart data={chartData} metaColors={meta} onSegmentClick={onSegmentClick} />}
    </Card>
  );
}

/* ---------------- Overview tab (the existing default dashboard) ---------------- */
function OverviewTab() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useDashboard();
  const statusColors = useStatusColors('contract_status');
  const k = data?.kpis;

  const columns: Column<RecentTreaty>[] = [
    { key: 'reference', header: 'Reference', render: (r) => <span className={shared.cellRef}>{r.reference}</span> },
    { key: 'name', header: 'Treaty', render: (r) => <span className={shared.cellMain}>{r.name}</span> },
    { key: 'currency', header: 'Currency', render: (r) => r.currency },
    { key: 'status', header: 'Status', align: 'right', render: (r) => <StatusPill status={r.status} metaColors={statusColors} /> },
  ];

  if (isError) return <Card><ErrorState message="Could not load the dashboard summary." /></Card>;

  return (
    <>
      <div className={shared.kpiGrid}>
        <KpiCard label="Treaties" value={formatNumber(k?.treaties)} loading={isLoading} icon={<FileText size={20} />} accent="var(--primary)" onClick={() => navigate('/treaties')} />
        <KpiCard label="Active treaties" value={formatNumber(k?.activeTreaties)} loading={isLoading} icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" onClick={() => navigate('/treaties')} />
        <KpiCard label="Parties" value={formatNumber(k?.parties)} loading={isLoading} icon={<Users size={20} />} accent="var(--accent-cyan)" onClick={() => navigate('/parties')} />
        <KpiCard label="Open claims" value={formatNumber(k?.openClaims)} loading={isLoading} icon={<ShieldAlert size={20} />} accent="var(--accent-orange)" onClick={() => navigate('/claims')} />
        <KpiCard label="Gross written premium" value={k ? formatMoneyCompact(k.gwpMinor, k.currency) : '-'} hint={k?.currency} loading={isLoading} icon={<Wallet size={20} />} accent="var(--accent-indigo)" />
        <KpiCard label="Outstanding reserves" value={k ? formatMoneyCompact(k.outstandingMinor, k.currency) : '-'} hint={k?.currency} loading={isLoading} icon={<PiggyBank size={20} />} accent="var(--accent-rose)" />
      </div>

      <Card padded>
        <CardHeader title="Quick actions" subtitle="Jump straight into the most common workflows" />
        <div className={shared.quickActions}>
          {QUICK_ACTIONS.map((a) => (
            <button key={a.to} className={shared.quickAction} onClick={() => navigate(a.to)}>
              <span className={shared.quickIcon} style={{ color: a.accent }}><a.icon size={18} /></span>
              <span className={shared.quickLabel}>{a.label}</span>
              <ArrowRight size={15} className={shared.quickArrow} />
            </button>
          ))}
        </div>
      </Card>

      <div className={shared.cols}>
        <Card>
          <CardHeader title="Recent treaties" subtitle="Latest activity across the book" />
          <Table
            columns={columns}
            rows={data?.recentTreaties}
            loading={isLoading}
            rowKey={(r) => r.reference}
            onRowClick={() => navigate('/treaties')}
            empty={<EmptyState title="No treaties yet" message="New treaties will appear here." />}
            skeletonRows={5}
          />
        </Card>
        <Card>
          <CardHeader title="Treaties by status" subtitle="Distribution across the lifecycle" />
          {isLoading ? (
            <div className={shared.cellSub}>Loading...</div>
          ) : (
            <DonutChart
              data={(data?.treatiesByStatus ?? []).map((s) => ({ label: s.status, value: s.n, status: s.status }))}
              metaColors={statusColors}
              centerLabel="treaties"
              onSegmentClick={(d) => navigate(`/treaties?status=${encodeURIComponent(d.label)}`)}
            />
          )}
        </Card>
      </div>
    </>
  );
}

/* ---------------- Designer tab (compose + save a dashboard from tiles) ---------------- */
function DesignerTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canShare = hasPermission('platform:write');

  const execQ = useQuery({ queryKey: ['executive'], queryFn: () => api<ExecResponse>('/api/executive') });
  const layoutsQ = useQuery({ queryKey: ['dashboard-layouts'], queryFn: () => api<{ layouts: Layout[] }>('/api/dashboards/layouts') });

  const layouts = layoutsQ.data?.layouts ?? [];
  // The active layout is the caller's default, else the tenant default, else the first.
  const active = useMemo(
    () => layouts.find((l) => l.isDefault && l.owned) ?? layouts.find((l) => l.isDefault) ?? layouts[0],
    [layouts],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current = layouts.find((l) => l.id === selectedId) ?? active;

  // Editor draft state.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Tile[]>([]);
  const [name, setName] = useState('My dashboard');
  const [isDefault, setIsDefault] = useState(true);
  const [shareIt, setShareIt] = useState(false);

  const save = useMutation({
    mutationFn: (body: { name: string; tiles: Tile[]; isDefault: boolean; shared: boolean }) =>
      api<{ id: string }>('/api/dashboards/layouts', { method: 'POST', body }),
    onSuccess: async () => {
      toast.success('Dashboard saved.');
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ['dashboard-layouts'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the dashboard.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/dashboards/layouts/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Dashboard removed.');
      setSelectedId(null);
      await qc.invalidateQueries({ queryKey: ['dashboard-layouts'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove the dashboard.'),
  });

  function startEdit(base?: Layout) {
    setDraft(base ? base.tiles.map((t) => ({ ...t })) : []);
    setName(base && base.owned ? base.name : 'My dashboard');
    setIsDefault(base ? base.isDefault : true);
    setShareIt(base ? base.shared && canShare : false);
    setEditing(true);
  }

  // Flatten every pack into an addable catalog, grouped by persona.
  const catalog = useMemo(() => {
    const exec = execQ.data;
    if (!exec) return [];
    return exec.personas.map((p) => {
      const pack = exec.packs[p.key];
      const items: { kind: 'kpi' | 'chart'; ref: string }[] = [
        ...(pack?.kpis ?? []).map((k) => ({ kind: 'kpi' as const, ref: k.label })),
        ...(pack?.charts ?? []).map((c) => ({ kind: 'chart' as const, ref: c.title })),
      ];
      return { persona: p.key, label: p.label, items };
    });
  }, [execQ.data]);

  const has = (t: { persona: string; kind: string; ref: string }) =>
    draft.some((d) => d.persona === t.persona && d.kind === t.kind && d.ref === t.ref);

  function addTile(persona: string, kind: 'kpi' | 'chart', ref: string) {
    if (has({ persona, kind, ref })) return;
    setDraft((d) => [...d, { persona, kind, ref, size: kind === 'kpi' ? 'sm' : 'md' }]);
  }
  function move(i: number, dir: -1 | 1) {
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.length) return d;
      const next = d.slice();
      const a = next[i]!;
      next[i] = next[j]!;
      next[j] = a;
      return next;
    });
  }
  function setSize(i: number, size: TileSize) {
    setDraft((d) => d.map((t, k) => (k === i ? { ...t, size } : t)));
  }
  function removeTile(i: number) {
    setDraft((d) => d.filter((_, k) => k !== i));
  }

  if (execQ.isLoading || layoutsQ.isLoading) return <PageLoader />;
  if (execQ.isError) return <Card><ErrorState message="Could not load the tile catalogue." /></Card>;
  const exec = execQ.data!;

  const personaLabel = (key: string) => exec.personas.find((p) => p.key === key)?.label ?? key;

  return (
    <>
      {/* Toolbar: choose a saved layout, or start editing. */}
      {!editing && (
        <div className={shared.toolbar} style={{ marginBottom: 'var(--space-4)' }}>
          <div className={styles.layoutBar}>
            <span className={shared.filterLabel}>Dashboard</span>
            <select
              className={styles.layoutSelect}
              value={current?.id ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {layouts.length === 0 && <option value="">No saved dashboards</option>}
              {layouts.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.shared ? ' (shared)' : ''}{l.isDefault ? ' - default' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className={shared.spacer} />
          {current && current.owned && (
            <Button variant="ghost" icon={<Trash2 size={16} />} loading={remove.isPending} onClick={() => remove.mutate(current.id)}>
              Delete
            </Button>
          )}
          <Button variant="secondary" icon={<Plus size={16} />} onClick={() => startEdit(undefined)}>New dashboard</Button>
          <Button variant="primary" icon={<Pencil size={16} />} onClick={() => startEdit(current)}>Edit layout</Button>
        </div>
      )}

      {/* Editor */}
      {editing && (
        <Card padded>
          <CardHeader title="Compose dashboard" subtitle="Add tiles from the live executive packs, then order and size them." />
          <div className={styles.meta}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="dash-name">Name</label>
              <input id="dash-name" className={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="My dashboard" />
            </div>
            <label className={styles.toggle}>
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Show on load (default)
            </label>
            {canShare && (
              <label className={styles.toggle}>
                <input type="checkbox" checked={shareIt} onChange={(e) => setShareIt(e.target.checked)} />
                Share with the whole tenant
              </label>
            )}
            <div className={shared.spacer} />
            <Button variant="ghost" icon={<X size={16} />} onClick={() => setEditing(false)}>Cancel</Button>
            <Button
              variant="primary"
              icon={<Save size={16} />}
              loading={save.isPending}
              disabled={!name.trim() || draft.length === 0}
              onClick={() => save.mutate({ name: name.trim(), tiles: draft, isDefault, shared: shareIt })}
            >
              Save dashboard
            </Button>
          </div>

          <div className={styles.editor}>
            {/* Catalog */}
            <div>
              <p className={styles.fieldLabel} style={{ marginBottom: 'var(--space-3)' }}>Available tiles</p>
              {catalog.map((g) => (
                <div key={g.persona} className={styles.personaGroup}>
                  <p className={styles.personaName}>{g.label}</p>
                  <div className={styles.catalogRow}>
                    {g.items.map((it) => (
                      <button
                        key={`${it.kind}:${it.ref}`}
                        className={styles.catalogChip}
                        disabled={has({ persona: g.persona, ...it })}
                        onClick={() => addTile(g.persona, it.kind, it.ref)}
                      >
                        <Plus size={13} />
                        <span>{it.ref}</span>
                        <span className={styles.chipKind}>{it.kind}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Current tiles */}
            <div>
              <p className={styles.fieldLabel} style={{ marginBottom: 'var(--space-3)' }}>Your layout ({draft.length})</p>
              {draft.length === 0 ? (
                <div className={styles.emptyTiles}>No tiles yet. Add tiles from the catalogue on the left.</div>
              ) : (
                <div className={styles.tileList}>
                  {draft.map((t, i) => (
                    <div key={`${t.persona}:${t.kind}:${t.ref}`} className={styles.tileItem}>
                      <div className={styles.tileItemMain}>
                        <div className={styles.tileItemName}>{t.ref}</div>
                        <div className={styles.tileItemMeta}>{personaLabel(t.persona)} · {t.kind}</div>
                      </div>
                      <div className={styles.tileControls}>
                        <select className={styles.sizeSelect} value={t.size} onChange={(e) => setSize(i, e.target.value as TileSize)} aria-label="Tile size">
                          <option value="sm">1/4</option>
                          <option value="md">1/2</option>
                          <option value="lg">Full</option>
                        </select>
                        <button className={styles.iconBtn} onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={14} /></button>
                        <button className={styles.iconBtn} onClick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
                        <button className={styles.iconBtn} onClick={() => removeTile(i)} aria-label="Remove tile"><X size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Live preview of the draft */}
          {draft.length > 0 && (
            <>
              <p className={styles.fieldLabel} style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>Preview</p>
              <div className={styles.designGrid}>
                {draft.map((t) => (
                  <div key={`p:${t.persona}:${t.kind}:${t.ref}`} className={sizeClass(t.size)}>
                    <TileView tile={t} exec={exec} />
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* Rendered saved layout (falls back to Overview when nothing is saved). */}
      {!editing && (
        current && current.tiles.length > 0 ? (
          <div className={styles.designGrid}>
            {current.tiles.map((t, i) => (
              <div key={`${t.persona}:${t.kind}:${t.ref}:${i}`} className={sizeClass(t.size)}>
                <TileView tile={t} exec={exec} />
              </div>
            ))}
          </div>
        ) : (
          <Card padded>
            <EmptyState
              title="No custom dashboard yet"
              message="Compose your own dashboard from KPI and chart tiles, or keep using the Overview tab."
            />
          </Card>
        )
      )}
    </>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'overview' | 'designer'>('overview');

  return (
    <>
      <PageHeader
        title="Executive overview"
        description="Portfolio health at a glance: treaty volumes, premium and claims exposure."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Dashboard' }]}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/treaties')}>
            New treaty
          </Button>
        }
      />

      <Tabs
        tabs={[
          { id: 'overview', label: <><BarChart3 size={15} /> Overview</> },
          { id: 'designer', label: <><LayoutDashboard size={15} /> My dashboard</> },
        ]}
        active={tab}
        onChange={(id) => setTab(id as 'overview' | 'designer')}
      />

      <div style={{ marginTop: 'var(--space-4)' }}>
        {tab === 'overview' ? <OverviewTab /> : <DesignerTab />}
      </div>
    </>
  );
}
