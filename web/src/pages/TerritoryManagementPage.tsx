import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Globe2, MapPin, Map, Radar, Layers, TriangleAlert, PlusCircle,
  Building2, ChevronRight,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { DonutChart } from '../components/DonutChart';
import { BarChart } from '../components/BarChart';
import { Modal } from '../components/Modal';
import { Drawer } from '../components/Drawer';
import { Tabs } from '../components/Tabs';
import { FormField, FormSection, Select, TextField } from '../components/Form';
import type { TokenColor } from '../lib/status';
import { formatMoney, formatMoneyCompact, formatNumber, formatPercent, titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';
import styles from './TerritoryManagementPage.module.css';

/* ---------------- Types (mirror the /api/territory-management contract) ---------------- */
type Grade = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH' | 'SEVERE';
type NodeKind = 'COUNTRY' | 'REGION' | 'STATE' | 'CITY' | 'CRESTA' | 'PERIL' | 'RISK' | 'POSTAL';
type ZoneTab = 'cresta' | 'peril' | 'risk' | 'postal';

interface Totals {
  countries: number;
  states: number;
  cities: number;
  zones: number;
  tivMinor: number;
  pmlMinor: number;
  highRisk: number;
}
interface ByKind {
  key: string;
  n: number;
}
interface TreeNode {
  id: string;
  code: string;
  name: string;
  kind: string;
  riskGrade: Grade | null;
  children: TreeNode[];
}
interface Zone {
  id: string;
  code: string;
  name: string;
  kind: string;
  countryCode: string;
  riskGrade: Grade | null;
  perils: string[];
  tivMinor: number;
  pmlMinor: number;
  itemCount: number;
}
interface BookRow {
  code: string;
  name: string;
  tivMinor: number;
  pmlMinor: number;
  itemCount: number;
  riskGrade: Grade | null;
  pmlRatioPct: number;
  sharePct: number;
  riskScore: number;
  band: Grade | null;
}
interface Book {
  territoryCount: number;
  totalTivMinor: number;
  totalPmlMinor: number;
  totalItems: number;
  bookPmlRatioPct: number;
  peakTivCode: string;
  peakTivSharePct: number;
  highRiskCount: number;
  rows: BookRow[];
}
interface TerritoryResponse {
  totals: Totals;
  byKind: ByKind[];
  tree: TreeNode[];
  zones: {
    cresta: Zone[];
    peril: Zone[];
    risk: Zone[];
    postal: Zone[];
  };
  countryBook: Book;
  crestaBook: Book;
}
interface TerritoryDetail {
  id: string;
  code: string;
  name: string;
  kind: string;
  parentId: string | null;
  countryCode: string | null;
  riskGrade: Grade | null;
  perils: string[];
  children: { id: string; code: string; name: string; kind: string; riskGrade: Grade | null }[];
  exposure: { tivMinor: number; pmlMinor: number; itemCount: number };
}

/* ---------------- Constants ---------------- */
const GRADE_COLOR: Record<Grade, TokenColor> = {
  LOW: 'slate', MODERATE: 'blue', ELEVATED: 'amber', HIGH: 'orange', SEVERE: 'red',
};
const gradeColor = (g: Grade | null | undefined): TokenColor => (g ? GRADE_COLOR[g] : 'slate');

// BarChart status strings are the raw band values, mapped straight through to token colours.
const BAND_META: Record<string, string> = {
  LOW: 'slate', MODERATE: 'blue', ELEVATED: 'amber', HIGH: 'orange', SEVERE: 'red',
};

// DonutChart keyed by the raw kind keys.
const KIND_META: Record<string, string> = {
  COUNTRY: 'teal', STATE: 'indigo', CITY: 'blue', CRESTA: 'violet',
  PERIL: 'orange', RISK: 'rose', POSTAL: 'slate', REGION: 'green',
};

const KIND_ICON: Record<string, typeof Globe2> = {
  COUNTRY: Globe2, REGION: Map, STATE: Map, CITY: Building2,
  CRESTA: Radar, PERIL: TriangleAlert, RISK: Layers, POSTAL: MapPin,
};

const NEW_KINDS: NodeKind[] = ['COUNTRY', 'REGION', 'STATE', 'CITY', 'CRESTA', 'POSTAL', 'PERIL', 'RISK'];
const GRADES: Grade[] = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'SEVERE'];

const ZONE_TABS: { id: ZoneTab; label: string }[] = [
  { id: 'cresta', label: 'CRESTA' },
  { id: 'peril', label: 'Peril' },
  { id: 'risk', label: 'Risk' },
  { id: 'postal', label: 'Postal' },
];

/* ---------------- Helpers ---------------- */
function KindIcon({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind.toUpperCase()] ?? MapPin;
  return <Icon size={15} aria-hidden />;
}

/** Flatten country/state nodes for the parent selector. */
function flattenParents(nodes: TreeNode[], depth = 0, acc: { id: string; label: string }[] = []) {
  for (const n of nodes) {
    if (n.kind === 'COUNTRY' || n.kind === 'STATE' || n.kind === 'REGION') {
      acc.push({ id: n.id, label: `${'— '.repeat(depth)}${n.name} (${n.code})` });
    }
    if (n.children?.length) flattenParents(n.children, depth + 1, acc);
  }
  return acc;
}

/* ---------------- Data hook ---------------- */
function useTerritory() {
  return useQuery({
    queryKey: ['territory-management'],
    queryFn: () => api<TerritoryResponse>('/api/territory-management'),
  });
}

export function TerritoryManagementPage() {
  const [showNew, setShowNew] = useState(false);
  const [zoneTab, setZoneTab] = useState<ZoneTab>('cresta');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { user } = useAuth();
  const canWrite = !!user && (user.permissions.includes('exposure:write') || user.permissions.includes('admin:manage'));

  const { data, isLoading } = useTerritory();
  const totals = data?.totals;
  const countryBook = data?.countryBook;
  const crestaBook = data?.crestaBook;

  const donutData = (data?.byKind ?? []).map((k) => ({
    label: titleCase(k.key),
    value: k.n,
    status: k.key,
  }));

  const barData = (countryBook?.rows ?? []).map((r) => ({
    label: r.code || r.name,
    value: Math.round(r.sharePct),
    status: r.band ?? 'LOW',
  }));

  const zoneRows = data?.zones[zoneTab] ?? [];

  const zoneColumns: Column<Zone>[] = [
    {
      key: 'code', header: 'Code', sortValue: (r) => r.code,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.code}</div>
          <div className={styles.cellSub}>{r.name}</div>
        </div>
      ),
    },
    { key: 'country', header: 'Country', sortValue: (r) => r.countryCode, render: (r) => <span className={styles.cellSub}>{r.countryCode || '—'}</span> },
    {
      key: 'perils', header: 'Perils',
      render: (r) => r.perils?.length ? (
        <span className={styles.perilRow}>
          {r.perils.map((p) => <Badge key={p} color="violet" variant="outline">{titleCase(p)}</Badge>)}
        </span>
      ) : <span className={styles.cellSub}>—</span>,
    },
    { key: 'tiv', header: 'TIV', align: 'right', sortValue: (r) => r.tivMinor, render: (r) => <span className={styles.num}>{formatMoney(r.tivMinor, 'USD')}</span> },
    { key: 'pml', header: 'PML', align: 'right', sortValue: (r) => r.pmlMinor, render: (r) => <span className={styles.num}>{formatMoney(r.pmlMinor, 'USD')}</span> },
    { key: 'items', header: 'Items', align: 'right', sortValue: (r) => r.itemCount, render: (r) => <span className={styles.num}>{formatNumber(r.itemCount)}</span> },
    {
      key: 'risk', header: 'Risk', align: 'right', sortValue: (r) => r.riskGrade ?? '',
      render: (r) => <Badge color={gradeColor(r.riskGrade)}>{titleCase(r.riskGrade) || '—'}</Badge>,
    },
  ];

  const bookColumns: Column<BookRow>[] = [
    {
      key: 'country', header: 'Country', sortValue: (r) => r.name,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.name}</div>
          <div className={styles.cellSub}>{r.code}</div>
        </div>
      ),
    },
    { key: 'tiv', header: 'TIV', align: 'right', sortValue: (r) => r.tivMinor, render: (r) => <span className={styles.num}>{formatMoney(r.tivMinor, 'USD')}</span> },
    { key: 'share', header: 'Share %', align: 'right', sortValue: (r) => r.sharePct, render: (r) => <span className={styles.num}>{formatPercent(r.sharePct)}</span> },
    { key: 'pml', header: 'PML', align: 'right', sortValue: (r) => r.pmlMinor, render: (r) => <span className={styles.num}>{formatMoney(r.pmlMinor, 'USD')}</span> },
    { key: 'pmlRatio', header: 'PML ratio', align: 'right', sortValue: (r) => r.pmlRatioPct, render: (r) => <span className={styles.num}>{formatPercent(r.pmlRatioPct)}</span> },
    {
      key: 'score', header: 'Risk score', align: 'right', sortValue: (r) => r.riskScore,
      render: (r) => (
        <div className={styles.scoreCell}>
          <div className={styles.scoreBar}>
            <span className={styles.scoreFill} data-band={r.band ?? 'LOW'} style={{ width: `${Math.min(100, r.riskScore)}%` }} />
          </div>
          <span className={styles.num}>{Math.round(r.riskScore)}</span>
        </div>
      ),
    },
    {
      key: 'band', header: 'Band', align: 'right', sortValue: (r) => r.band ?? '',
      render: (r) => <Badge color={gradeColor(r.band)}>{titleCase(r.band) || '—'}</Badge>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Territory Management"
        description="Geographic accumulation & zone risk — the country/state/city master joined to CRESTA, peril and postal zones with live TIV, modelled PML and blended risk banding."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Exposure', to: '/exposure' }, { label: 'Territory Management' }]}
        actions={canWrite ? (
          <Button variant="primary" icon={<PlusCircle size={16} />} onClick={() => setShowNew(true)}>New territory</Button>
        ) : undefined}
      />

      <div className={styles.kpis}>
        <KpiCard label="Countries" value={totals ? formatNumber(totals.countries) : '—'} hint={totals ? `${formatNumber(totals.states)} states · ${formatNumber(totals.cities)} cities` : undefined} icon={<Globe2 size={20} />} accent="var(--primary)" loading={isLoading} />
        <KpiCard label="Zones" value={totals ? formatNumber(totals.zones) : '—'} hint="Accumulation taxonomies" icon={<Radar size={20} />} accent="var(--accent-violet)" loading={isLoading} />
        <KpiCard label="Total TIV" value={totals ? formatMoneyCompact(totals.tivMinor, 'USD') : '—'} hint="Total insured value" icon={<Layers size={20} />} accent="var(--accent-teal)" loading={isLoading} />
        <KpiCard label="Modelled PML" value={totals ? formatMoneyCompact(totals.pmlMinor, 'USD') : '—'} hint="Probable maximum loss" icon={<TriangleAlert size={20} />} accent="var(--accent-orange)" loading={isLoading} />
        <KpiCard label="High-risk zones" value={totals ? formatNumber(totals.highRisk) : '—'} hint="Elevated & above" icon={<TriangleAlert size={20} />} accent="var(--accent-rose)" loading={isLoading} />
      </div>

      <div className={styles.chartGrid}>
        <Card padded>
          <CardHeader title="Territory mix" subtitle="Count of territories by kind" />
          {isLoading ? (
            <p className={styles.cellSub}>Loading…</p>
          ) : (
            <DonutChart data={donutData} metaColors={KIND_META} centerLabel="territories" emptyLabel="No territories defined yet" />
          )}
        </Card>
        <Card padded>
          <CardHeader title="Accumulation by country" subtitle="Share of total TIV, coloured by risk band" />
          {isLoading ? (
            <p className={styles.cellSub}>Loading…</p>
          ) : (
            <BarChart data={barData} metaColors={BAND_META} emptyLabel="No country accumulation yet" />
          )}
        </Card>
      </div>

      <Card padded={false} style={{ marginBottom: 'var(--space-5)' }}>
        <div className={styles.sectionHead}>
          <CardHeader title="Geographic hierarchy" subtitle="Country → state → city. Select a node for its exposure and children." />
        </div>
        <div className={styles.treeWrap}>
          {isLoading ? (
            <p className={styles.cellSub}>Loading hierarchy…</p>
          ) : (data?.tree.length ?? 0) === 0 ? (
            <EmptyState icon={<Globe2 size={18} />} title="No territories" message="Add a country to start building the geographic master." />
          ) : (
            <ul className={styles.tree}>
              {data!.tree.map((n) => <TreeRow key={n.id} node={n} depth={0} onSelect={setSelectedId} />)}
            </ul>
          )}
        </div>
      </Card>

      <Card padded={false} style={{ marginBottom: 'var(--space-5)' }}>
        <div className={styles.sectionHead}>
          <CardHeader title="Accumulation zones" subtitle="CRESTA, peril, risk and postal taxonomies joined to live exposure." />
        </div>
        <div className={styles.tabsBar}>
          <Tabs tabs={ZONE_TABS} active={zoneTab} onChange={(id) => setZoneTab(id as ZoneTab)} />
        </div>
        {zoneTab === 'cresta' && crestaBook && (
          <div className={styles.bookSummary}>
            <span><strong>Peak zone</strong> {crestaBook.peakTivCode || '—'} ({formatPercent(crestaBook.peakTivSharePct)})</span>
            <span className={styles.dotSep} aria-hidden />
            <span><strong>Concentration</strong> {formatPercent(crestaBook.peakTivSharePct)}</span>
            <span className={styles.dotSep} aria-hidden />
            <span><strong>High-risk</strong> {formatNumber(crestaBook.highRiskCount)}</span>
            <span className={styles.dotSep} aria-hidden />
            <span><strong>Book PML ratio</strong> {formatPercent(crestaBook.bookPmlRatioPct)}</span>
          </div>
        )}
        <div className={styles.tableWrap}>
          <Table
            columns={zoneColumns}
            rows={zoneRows}
            loading={isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<Radar size={18} />} title="No zones" message="No accumulation zones defined for this taxonomy yet." />}
            skeletonRows={5}
          />
        </div>
      </Card>

      <Card padded={false}>
        <div className={styles.sectionHead}>
          <CardHeader title="Portfolio accumulation" subtitle="Accumulation by country, ranked by total insured value." />
        </div>
        <div className={styles.tableWrap}>
          <Table
            columns={bookColumns}
            rows={countryBook?.rows}
            loading={isLoading}
            rowKey={(r) => r.code}
            empty={<EmptyState icon={<Globe2 size={18} />} title="No accumulation" message="No country-level accumulation to report yet." />}
            skeletonRows={5}
          />
        </div>
      </Card>

      <NewTerritoryModal open={showNew} onClose={() => setShowNew(false)} tree={data?.tree ?? []} />
      <TerritoryDrawer id={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

/* ---------------- Tree row ---------------- */
function TreeRow({ node, depth, onSelect }: { node: TreeNode; depth: number; onSelect: (id: string) => void }) {
  const hasChildren = node.children?.length > 0;
  return (
    <li>
      <button
        type="button"
        className={styles.treeNode}
        style={{ paddingLeft: `calc(var(--space-3) + ${depth} * var(--space-5))` }}
        onClick={() => onSelect(node.id)}
      >
        <span className={styles.treeIcon} data-has-children={hasChildren}><KindIcon kind={node.kind} /></span>
        <span className={styles.treeName}>{node.name}</span>
        <span className={styles.treeCode}>{node.code}</span>
        <span className={styles.treeGrade}>
          <Badge color={gradeColor(node.riskGrade)}>{titleCase(node.riskGrade) || '—'}</Badge>
        </span>
        <ChevronRight size={14} className={styles.treeChevron} aria-hidden />
      </button>
      {hasChildren && (
        <ul className={styles.tree}>
          {node.children.map((c) => <TreeRow key={c.id} node={c} depth={depth + 1} onSelect={onSelect} />)}
        </ul>
      )}
    </li>
  );
}

/* ---------------- Detail drawer ---------------- */
function TerritoryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['territory-management', id],
    queryFn: () => api<TerritoryDetail>(`/api/territory-management/${id}`),
    enabled: !!id,
  });

  const childColumns: Column<TerritoryDetail['children'][number]>[] = [
    {
      key: 'name', header: 'Name', sortValue: (r) => r.name,
      render: (r) => (
        <div className={styles.childName}>
          <KindIcon kind={r.kind} />
          <span className={styles.cellMain}>{r.name}</span>
        </div>
      ),
    },
    { key: 'code', header: 'Code', render: (r) => <span className={styles.cellSub}>{r.code}</span> },
    {
      key: 'grade', header: 'Risk', align: 'right', sortValue: (r) => r.riskGrade ?? '',
      render: (r) => <Badge color={gradeColor(r.riskGrade)}>{titleCase(r.riskGrade) || '—'}</Badge>,
    },
  ];

  return (
    <Drawer open={!!id} onClose={onClose} title={data?.name ?? 'Territory'} subtitle={data ? `${titleCase(data.kind)} · ${data.code}` : undefined} width={480}>
      {isLoading || !data ? (
        <p className={styles.cellSub}>Loading…</p>
      ) : (
        <div className={styles.drawerBody}>
          <div className={styles.statGrid}>
            <KpiCard label="TIV" value={formatMoneyCompact(data.exposure.tivMinor, 'USD')} icon={<Layers size={18} />} accent="var(--accent-teal)" />
            <KpiCard label="PML" value={formatMoneyCompact(data.exposure.pmlMinor, 'USD')} icon={<TriangleAlert size={18} />} accent="var(--accent-orange)" />
            <KpiCard label="Items" value={formatNumber(data.exposure.itemCount)} icon={<Building2 size={18} />} accent="var(--accent-violet)" />
          </div>

          <div className={styles.metaRow}>
            {data.countryCode && <Badge color="teal" variant="outline">{data.countryCode}</Badge>}
            {data.riskGrade && <Badge color={gradeColor(data.riskGrade)}>{titleCase(data.riskGrade)}</Badge>}
            {data.perils?.map((p) => <Badge key={p} color="violet" variant="outline">{titleCase(p)}</Badge>)}
          </div>

          <div>
            <h3 className={styles.drawerHeading}>Children</h3>
            <Table
              columns={childColumns}
              rows={data.children}
              rowKey={(r) => r.id}
              empty={<EmptyState title="No children" message="This territory has no sub-territories." />}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* ---------------- New territory ---------------- */
function NewTerritoryModal({ open, onClose, tree }: { open: boolean; onClose: () => void; tree: TreeNode[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    kind: 'COUNTRY' as NodeKind, code: '', name: '', countryCode: '',
    riskGrade: '' as '' | Grade, perils: '', parentId: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const parents = flattenParents(tree);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string }>('/api/territory-management', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['territory-management'] });
      toast.success('Territory created');
      onClose();
      setF({ kind: 'COUNTRY', code: '', name: '', countryCode: '', riskGrade: '', perils: '', parentId: '' });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the territory.'),
  });

  const submit = () => {
    setError(null);
    const perils = f.perils.split(',').map((p) => p.trim()).filter(Boolean);
    create.mutate({
      kind: f.kind,
      code: f.code.trim(),
      name: f.name.trim(),
      countryCode: f.countryCode.trim() || undefined,
      parentId: f.parentId || undefined,
      riskGrade: f.riskGrade || undefined,
      perils: perils.length ? perils : undefined,
    });
  };

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="New territory"
      description="Add a geographic node or accumulation zone to the master."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!f.code.trim() || !f.name.trim()}>Create territory</Button>
      </>}
    >
      <div className={styles.form}>
        <FormSection title="Definition">
          <FormField label="Kind">
            <Select value={f.kind} onChange={(e) => set('kind')(e.target.value as NodeKind)}>
              {NEW_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
            </Select>
          </FormField>
          <TextField label="Code" value={f.code} onChange={set('code')} required placeholder="e.g. US / US-CA / CRESTA-01" />
          <TextField label="Name" value={f.name} onChange={set('name')} required placeholder="e.g. United States" />
          <TextField label="Country code" value={f.countryCode} onChange={set('countryCode')} placeholder="ISO country (optional)" />
        </FormSection>

        <FormSection title="Risk & hierarchy">
          <FormField label="Risk grade">
            <Select value={f.riskGrade} onChange={(e) => set('riskGrade')(e.target.value as '' | Grade)}>
              <option value="">— Unset —</option>
              {GRADES.map((g) => <option key={g} value={g}>{titleCase(g)}</option>)}
            </Select>
          </FormField>
          <FormField label="Parent">
            <Select value={f.parentId} onChange={(e) => set('parentId')(e.target.value)}>
              <option value="">— None (top level) —</option>
              {parents.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </FormField>
          <TextField label="Perils" value={f.perils} onChange={set('perils')} placeholder="Comma-separated, e.g. EQ, WIND, FLOOD" hint="Applies to zone kinds." />
        </FormSection>

        {error && <p className={styles.formError} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
