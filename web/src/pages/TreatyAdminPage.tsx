import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileStack, Layers, Wallet, Coins, PlusCircle, ScrollText,
  GitBranch, Stamp, History, CircleDot,
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
import { DonutChart } from '../components/DonutChart';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { Tabs } from '../components/Tabs';
import { FormField, FormSection, Select, TextField, Textarea } from '../components/Form';
import type { TokenColor } from '../lib/status';
import {
  formatMoney, formatMoneyCompact, formatPercent, formatDate, formatDateTime, titleCase,
} from '../lib/format';
import { useAuth } from '../lib/auth';
import styles from './TreatyAdminPage.module.css';

/* ---------------- Types (mirror the /api/treaty-admin contract) ---------------- */
interface RegisterTreaty {
  id: string;
  reference: string;
  name: string;
  basis: string;
  proportionalType: string | null;
  npType: string | null;
  lineOfBusiness: string;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  cedentName: string | null;
  brokerName: string | null;
  layerCount: number;
  totalLimitMinor: number;
  premiumMinor: number;
}
interface RegisterResponse { treaties: RegisterTreaty[]; }

interface CountBucket { key: string; n: number; }
interface AnalyticsResponse {
  treatyCount: number;
  totalLimitMinor: number;
  premiumMinor: number;
  layerCount: number;
  byStructure: CountBucket[];
  byStatus: CountBucket[];
}

interface DetailLayer {
  id: string;
  layerNo: number;
  name: string | null;
  currency: string;
  attachmentMinor: number;
  limitMinor: number;
  aadMinor: number;
  reinstatements: number;
  rateOnLine: number;
}
interface LayerBookRow {
  attachmentMinor: number;
  limitMinor: number;
  topMinor: number;
  rolPct: number;
  premiumMinor: number;
  expectedLossMinor: number;
  reinstatedLimitMinor: number;
}
interface LayerBook {
  layerCount: number;
  totalLimitMinor: number;
  totalPremiumMinor: number;
  weightedRolPct: number;
  programmeTopMinor: number;
  reinstatedCapacityMinor: number;
  layers: LayerBookRow[];
}
interface Endorsement {
  id: string;
  endorsementNo: number;
  effectiveDate: string | null;
  description: string;
  changes: string | null;
  createdAt: string;
}
interface Version { id: string; versionNo: number; note: string | null; createdAt: string; }
interface Clause { id: string; code: string | null; title: string; category: string; body: string | null; }
interface TaxLine { id: string; kind: string; ratePct: number; note: string | null; }
interface TechnicalAccount {
  lossRatioPct: number;
  commissionRatioPct: number;
  expenseRatioPct: number;
  combinedRatioPct: number;
  technicalResultMinor: number;
}
interface TimelineEntry { at: string; action: string; actor: string | null; entityType: string; }

interface TreatyDetail {
  id: string;
  reference: string;
  name: string;
  contractKind: string;
  basis: string;
  direction: string;
  proportionalType: string | null;
  npType: string | null;
  lineOfBusiness: string;
  currency: string;
  status: string;
  wordingRef: string | null;
  marketRefs: string | null;
  periodStart: string;
  periodEnd: string;
  cedentName: string | null;
  brokerName: string | null;
  layers: DetailLayer[];
  layerBook: LayerBook;
  endorsements: Endorsement[];
  versions: Version[];
  clauses: Clause[];
  taxes: TaxLine[];
  technicalAccount: TechnicalAccount;
  timeline: TimelineEntry[];
}

/* ---------------- Constants ---------------- */
const STATUS_COLOR: Record<string, TokenColor> = {
  DRAFT: 'slate', QUOTED: 'blue', PLACING: 'amber', BOUND: 'indigo',
  ACTIVE: 'green', EXPIRING: 'orange', RUNOFF: 'violet', COMMUTED: 'teal',
  CANCELLED: 'red',
};
const CLAUSE_CATEGORIES = [
  'GENERAL', 'EXCLUSION', 'CONDITION', 'WARRANTY',
  'COMMISSION', 'REINSTATEMENT', 'SANCTIONS', 'WORDING',
] as const;
type ClauseCategory = typeof CLAUSE_CATEGORIES[number];
const CLAUSE_COLOR: Record<string, TokenColor> = {
  GENERAL: 'slate', EXCLUSION: 'red', CONDITION: 'blue', WARRANTY: 'amber',
  COMMISSION: 'teal', REINSTATEMENT: 'violet', SANCTIONS: 'orange', WORDING: 'indigo',
};
const CATEGORY_COLOR: Record<string, TokenColor> = {
  proportional: 'teal', 'non-proportional': 'violet',
};

const statusColor = (s: string): TokenColor => STATUS_COLOR[s?.toUpperCase()] ?? 'gray';
const structureLabel = (t: { basis: string; npType: string | null; proportionalType: string | null }) =>
  t.npType ?? t.proportionalType ?? t.basis;
const structureColor = (t: { basis: string; npType: string | null; proportionalType: string | null }): TokenColor =>
  t.npType ? 'violet' : t.proportionalType ? 'teal' : 'slate';

/* ---------------- Page ---------------- */
export function TreatyAdminPage() {
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const register = useQuery({
    queryKey: ['treaty-admin', 'register', status],
    queryFn: () => api<RegisterResponse>(`/api/treaty-admin/register${status ? `?status=${status}` : ''}`),
  });
  const analytics = useQuery({
    queryKey: ['treaty-admin', 'analytics'],
    queryFn: () => api<AnalyticsResponse>('/api/treaty-admin/analytics'),
  });

  const a = analytics.data;
  const treaties = register.data?.treaties;

  // Distinct statuses for the filter (from analytics, else register).
  const statusOptions = (a?.byStatus.map((b) => b.key)
    ?? Array.from(new Set(treaties?.map((t) => t.status) ?? [])));

  const structureData = (a?.byStructure ?? []).map((b) => ({ label: b.key, value: b.n }));
  const statusData = (a?.byStatus ?? []).map((b) => ({ label: b.key, value: b.n }));

  const columns: Column<RegisterTreaty>[] = [
    {
      key: 'reference', header: 'Reference', sortValue: (r) => r.reference,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.reference}</div>
          <div className={styles.cellSub}>{r.name}</div>
        </div>
      ),
    },
    { key: 'cedent', header: 'Cedent', sortValue: (r) => r.cedentName ?? '', render: (r) => r.cedentName ?? <span className={styles.cellSub}>—</span> },
    { key: 'broker', header: 'Broker', sortValue: (r) => r.brokerName ?? '', render: (r) => r.brokerName ?? <span className={styles.cellSub}>—</span> },
    {
      key: 'structure', header: 'Structure', sortValue: (r) => structureLabel(r),
      render: (r) => <Badge color={structureColor(r)}>{titleCase(structureLabel(r))}</Badge>,
    },
    { key: 'lob', header: 'LOB', sortValue: (r) => r.lineOfBusiness, render: (r) => <span className={styles.cellSub}>{titleCase(r.lineOfBusiness)}</span> },
    {
      key: 'period', header: 'Period', sortValue: (r) => r.periodStart,
      render: (r) => <span className={styles.cellSub}>{formatDate(r.periodStart)} – {formatDate(r.periodEnd)}</span>,
    },
    { key: 'layers', header: 'Layers', align: 'right', sortValue: (r) => r.layerCount, render: (r) => <span className={styles.num}>{r.layerCount}</span> },
    { key: 'limit', header: 'Limit', align: 'right', sortValue: (r) => r.totalLimitMinor, render: (r) => <span className={styles.num}>{formatMoney(r.totalLimitMinor, r.currency)}</span> },
    { key: 'premium', header: 'Premium', align: 'right', sortValue: (r) => r.premiumMinor, render: (r) => <span className={styles.num}>{formatMoney(r.premiumMinor, r.currency)}</span> },
    {
      key: 'status', header: 'Status', sortValue: (r) => r.status,
      render: (r) => <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Treaty Administration"
        description="The enterprise treaty register with priced layer towers, versioning, special clauses, tax schedules, endorsements and a full lifecycle timeline across the placement-to-runoff journey."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Treaties', to: '/treaties' }, { label: 'Administration' }]}
      />

      <div className={styles.kpis}>
        <KpiCard label="Treaties" value={a ? a.treatyCount.toLocaleString() : '—'} hint="In the register" icon={<FileStack size={20} />} accent="var(--primary)" loading={analytics.isLoading} />
        <KpiCard label="Total limit" value={a ? formatMoneyCompact(a.totalLimitMinor, 'USD') : '—'} hint="Aggregate programme limit" icon={<Wallet size={20} />} accent="var(--accent-violet)" loading={analytics.isLoading} />
        <KpiCard label="Premium" value={a ? formatMoneyCompact(a.premiumMinor, 'USD') : '—'} hint="Booked treaty premium" icon={<Coins size={20} />} accent="var(--accent-emerald)" loading={analytics.isLoading} />
        <KpiCard label="Layers" value={a ? a.layerCount.toLocaleString() : '—'} hint="Priced layers under management" icon={<Layers size={20} />} accent="var(--accent-indigo)" loading={analytics.isLoading} />
      </div>

      <div className={styles.chartRow}>
        <Card padded>
          <CardHeader title="By structure" subtitle="Treaty count by reinsurance structure" />
          {analytics.isLoading ? <p className={styles.cellSub}>Loading…</p>
            : <BarChart data={structureData} metaColors={CATEGORY_COLOR} emptyLabel="No treaties yet" />}
        </Card>
        <Card padded>
          <CardHeader title="By status" subtitle="Distribution across the lifecycle" />
          {analytics.isLoading ? <p className={styles.cellSub}>Loading…</p>
            : <DonutChart data={statusData} centerLabel="treaties" centerValue={a ? String(a.treatyCount) : '0'} emptyLabel="No treaties yet" />}
        </Card>
      </div>

      <Card padded={false}>
        <CardHeader title="Treaty register" subtitle="Every treaty on the book — select a row for the full administration record" />
        <div className={styles.filterBar}>
          <label className={styles.filterLabel}>Status</label>
          <div className={styles.filterSelect}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {statusOptions.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={treaties}
            loading={register.isLoading}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenId(r.id)}
            empty={<EmptyState icon={<FileStack size={18} />} title="No treaties" message="No treaties match the current filter." />}
            skeletonRows={6}
          />
        </div>
      </Card>

      <TreatyDrawer id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

/* ---------------- Detail drawer ---------------- */
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tower', label: 'Layer tower' },
  { id: 'clauses', label: 'Clauses & wording' },
  { id: 'endorsements', label: 'Endorsements' },
  { id: 'versions', label: 'Versions' },
  { id: 'timeline', label: 'Timeline' },
];

function TreatyDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState<null | 'layer' | 'clause' | 'endorsement' | 'version'>(null);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('treaty:write');

  const { data, isLoading } = useQuery({
    queryKey: ['treaty-admin', id],
    queryFn: () => api<TreatyDetail>(`/api/treaty-admin/${id}`),
    enabled: !!id,
  });

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      title={data ? data.reference : 'Treaty'}
      subtitle={data ? data.name : undefined}
      width={720}
    >
      {isLoading && <p className={styles.cellSub}>Loading treaty…</p>}
      {data && (
        <div className={styles.drawerBody}>
          <div className={styles.tabBar}>
            <Tabs tabs={TABS} active={tab} onChange={setTab} />
          </div>

          {tab === 'overview' && <OverviewTab t={data} />}
          {tab === 'tower' && <TowerTab t={data} canWrite={canWrite} onAdd={() => setModal('layer')} />}
          {tab === 'clauses' && <ClausesTab t={data} canWrite={canWrite} onAdd={() => setModal('clause')} />}
          {tab === 'endorsements' && <EndorsementsTab t={data} canWrite={canWrite} onAdd={() => setModal('endorsement')} />}
          {tab === 'versions' && <VersionsTab t={data} canWrite={canWrite} onAdd={() => setModal('version')} />}
          {tab === 'timeline' && <TimelineTab t={data} />}
        </div>
      )}

      {data && (
        <>
          <LayerModal open={modal === 'layer'} onClose={() => setModal(null)} treatyId={data.id} />
          <ClauseModal open={modal === 'clause'} onClose={() => setModal(null)} treatyId={data.id} />
          <EndorsementModal open={modal === 'endorsement'} onClose={() => setModal(null)} treatyId={data.id} />
          <VersionModal open={modal === 'version'} onClose={() => setModal(null)} treatyId={data.id} />
        </>
      )}
    </Drawer>
  );
}

/* ---------------- Overview tab ---------------- */
function OverviewTab({ t }: { t: TreatyDetail }) {
  const ta = t.technicalAccount;
  const resultColor = ta.technicalResultMinor >= 0 ? 'var(--c-green)' : 'var(--c-red)';
  const facts: { label: string; value: ReactNode }[] = [
    { label: 'Reference', value: t.reference },
    { label: 'Status', value: <Badge color={statusColor(t.status)}>{titleCase(t.status)}</Badge> },
    { label: 'Cedent', value: t.cedentName ?? '—' },
    { label: 'Broker', value: t.brokerName ?? '—' },
    { label: 'Line of business', value: titleCase(t.lineOfBusiness) },
    { label: 'Structure', value: <Badge color={structureColor(t)}>{titleCase(structureLabel(t))}</Badge> },
    { label: 'Period', value: `${formatDate(t.periodStart)} – ${formatDate(t.periodEnd)}` },
    { label: 'Currency', value: t.currency },
    { label: 'Wording ref', value: t.wordingRef ?? '—' },
    { label: 'Market refs', value: t.marketRefs ?? '—' },
  ];
  return (
    <div className={styles.tabPanel}>
      <Card padded>
        <CardHeader title="Treaty facts" />
        <dl className={styles.factGrid}>
          {facts.map((f) => (
            <div key={f.label} className={styles.fact}>
              <dt className={styles.factLabel}>{f.label}</dt>
              <dd className={styles.factValue}>{f.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card padded>
        <CardHeader title="Technical account" subtitle="Underwriting result and ratios" />
        <div className={styles.statGrid}>
          <Stat label="Loss ratio" value={formatPercent(ta.lossRatioPct)} />
          <Stat label="Commission ratio" value={formatPercent(ta.commissionRatioPct)} />
          <Stat label="Expense ratio" value={formatPercent(ta.expenseRatioPct)} />
          <Stat label="Combined ratio" value={formatPercent(ta.combinedRatioPct)} accent={ta.combinedRatioPct > 100 ? 'var(--c-red)' : 'var(--c-green)'} />
          <Stat label="Technical result" value={formatMoney(ta.technicalResultMinor, t.currency)} accent={resultColor} span />
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, accent, span }: { label: string; value: ReactNode; accent?: string; span?: boolean }) {
  return (
    <div className={`${styles.stat} ${span ? styles.statSpan : ''}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} style={accent ? { color: accent } : undefined}>{value}</span>
    </div>
  );
}

/* ---------------- Layer tower tab ---------------- */
function TowerTab({ t, canWrite, onAdd }: { t: TreatyDetail; canWrite: boolean; onAdd: () => void }) {
  const lb = t.layerBook;
  const ccy = t.currency;
  const bandLabel = (r: LayerBookRow) => `${formatMoneyCompact(r.limitMinor, ccy)} xs ${formatMoneyCompact(r.attachmentMinor, ccy)}`;

  const columns: Column<LayerBookRow>[] = [
    { key: 'band', header: 'Layer', render: (r) => <span className={styles.cellMain}>{bandLabel(r)}</span> },
    { key: 'top', header: 'Top', align: 'right', render: (r) => <span className={styles.num}>{formatMoney(r.topMinor, ccy)}</span> },
    { key: 'rol', header: 'RoL %', align: 'right', render: (r) => <span className={styles.num}>{formatPercent(r.rolPct)}</span> },
    { key: 'premium', header: 'Premium', align: 'right', render: (r) => <span className={styles.num}>{formatMoney(r.premiumMinor, ccy)}</span> },
    { key: 'el', header: 'Expected loss', align: 'right', render: (r) => <span className={styles.num}>{formatMoney(r.expectedLossMinor, ccy)}</span> },
    { key: 'reinst', header: 'Reinstated limit', align: 'right', render: (r) => <span className={styles.num}>{formatMoney(r.reinstatedLimitMinor, ccy)}</span> },
  ];

  return (
    <div className={styles.tabPanel}>
      <Card padded={false}>
        <CardHeader
          title="Priced layer tower"
          subtitle={`${lb.layerCount} layers · programme top ${formatMoneyCompact(lb.programmeTopMinor, ccy)}`}
          actions={canWrite ? <Button size="sm" variant="primary" icon={<PlusCircle size={14} />} onClick={onAdd}>Add layer</Button> : undefined}
        />
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={lb.layers}
            rowKey={(_r) => `${_r.attachmentMinor}:${_r.limitMinor}`}
            empty={<EmptyState icon={<Layers size={18} />} title="No layers" message="This treaty has no priced layers yet." />}
          />
        </div>
        <div className={styles.summaryBar}>
          <Summary label="Total limit" value={formatMoney(lb.totalLimitMinor, ccy)} />
          <Summary label="Total premium" value={formatMoney(lb.totalPremiumMinor, ccy)} />
          <Summary label="Weighted RoL" value={formatPercent(lb.weightedRolPct)} />
          <Summary label="Programme top" value={formatMoney(lb.programmeTopMinor, ccy)} />
          <Summary label="Reinstated capacity" value={formatMoney(lb.reinstatedCapacityMinor, ccy)} />
        </div>
      </Card>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.summaryItem}>
      <span className={styles.summaryLabel}>{label}</span>
      <span className={styles.summaryValue}>{value}</span>
    </div>
  );
}

/* ---------------- Clauses tab ---------------- */
function ClausesTab({ t, canWrite, onAdd }: { t: TreatyDetail; canWrite: boolean; onAdd: () => void }) {
  return (
    <div className={styles.tabPanel}>
      <Card padded>
        <CardHeader
          title="Special clauses & wording"
          subtitle={`${t.clauses.length} clauses on this treaty`}
          actions={canWrite ? <Button size="sm" variant="primary" icon={<PlusCircle size={14} />} onClick={onAdd}>Add clause</Button> : undefined}
        />
        {t.clauses.length === 0 ? (
          <EmptyState icon={<ScrollText size={18} />} title="No clauses" message="No special clauses have been captured for this treaty." />
        ) : (
          <ul className={styles.clauseList}>
            {t.clauses.map((c) => (
              <li key={c.id} className={styles.clauseItem}>
                <div className={styles.clauseHead}>
                  <Badge color={CLAUSE_COLOR[c.category] ?? 'gray'}>{titleCase(c.category)}</Badge>
                  <span className={styles.clauseTitle}>{c.title}</span>
                  {c.code && <span className={styles.clauseCode}>{c.code}</span>}
                </div>
                {c.body && <p className={styles.clauseBody}>{c.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {t.taxes.length > 0 && (
        <Card padded>
          <CardHeader title="Tax schedule" subtitle="Levies applied to this treaty" />
          <ul className={styles.taxList}>
            {t.taxes.map((tx) => (
              <li key={tx.id} className={styles.taxItem}>
                <Badge color="amber">{titleCase(tx.kind)}</Badge>
                <span className={styles.taxRate}>{formatPercent(tx.ratePct)}</span>
                {tx.note && <span className={styles.cellSub}>{tx.note}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* ---------------- Endorsements tab ---------------- */
function EndorsementsTab({ t, canWrite, onAdd }: { t: TreatyDetail; canWrite: boolean; onAdd: () => void }) {
  const columns: Column<Endorsement>[] = [
    { key: 'no', header: 'No', align: 'right', render: (r) => <span className={styles.num}>#{r.endorsementNo}</span> },
    { key: 'eff', header: 'Effective', render: (r) => formatDate(r.effectiveDate) },
    {
      key: 'desc', header: 'Description',
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.description}</div>
          {r.changes && <div className={styles.cellSub}>{r.changes}</div>}
        </div>
      ),
    },
    { key: 'created', header: 'Created', render: (r) => <span className={styles.cellSub}>{formatDate(r.createdAt)}</span> },
  ];
  return (
    <div className={styles.tabPanel}>
      <Card padded={false}>
        <CardHeader
          title="Endorsements & amendments"
          subtitle={`${t.endorsements.length} endorsements`}
          actions={canWrite ? <Button size="sm" variant="primary" icon={<PlusCircle size={14} />} onClick={onAdd}>Add endorsement</Button> : undefined}
        />
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={t.endorsements}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<Stamp size={18} />} title="No endorsements" message="No endorsements have been raised against this treaty." />}
          />
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Versions tab ---------------- */
function VersionsTab({ t, canWrite, onAdd }: { t: TreatyDetail; canWrite: boolean; onAdd: () => void }) {
  const columns: Column<Version>[] = [
    { key: 'no', header: 'Version', align: 'right', render: (r) => <span className={styles.num}>v{r.versionNo}</span> },
    { key: 'note', header: 'Note', render: (r) => r.note ?? <span className={styles.cellSub}>—</span> },
    { key: 'created', header: 'Created', render: (r) => <span className={styles.cellSub}>{formatDateTime(r.createdAt)}</span> },
  ];
  return (
    <div className={styles.tabPanel}>
      <Card padded={false}>
        <CardHeader
          title="Version history"
          subtitle={`${t.versions.length} snapshots`}
          actions={canWrite ? <Button size="sm" variant="primary" icon={<GitBranch size={14} />} onClick={onAdd}>Snapshot version</Button> : undefined}
        />
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={t.versions}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<GitBranch size={18} />} title="No versions" message="No version snapshots have been taken yet." />}
          />
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Timeline tab ---------------- */
function TimelineTab({ t }: { t: TreatyDetail }) {
  return (
    <div className={styles.tabPanel}>
      <Card padded>
        <CardHeader title="Lifecycle timeline" subtitle="Everything that has happened to this treaty" />
        {t.timeline.length === 0 ? (
          <EmptyState icon={<History size={18} />} title="No activity" message="Nothing has been recorded against this treaty yet." />
        ) : (
          <ol className={styles.timeline}>
            {t.timeline.map((e, i) => (
              <li key={`${e.at}-${i}`} className={styles.timelineItem}>
                <span className={styles.timelineDot} aria-hidden><CircleDot size={12} /></span>
                <div className={styles.timelineMain}>
                  <div className={styles.timelineHead}>
                    <span className={styles.timelineAction}>{titleCase(e.action)}</span>
                    <Badge color="slate">{titleCase(e.entityType)}</Badge>
                  </div>
                  <div className={styles.cellSub}>
                    {formatDateTime(e.at)}{e.actor ? ` · ${e.actor}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Mutation helper ---------------- */
function useTreatyMutation<TBody>(treatyId: string, path: string, onDone: () => void) {
  const toast = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => api(`/api/treaty-admin/${treatyId}/${path}`, { body: body as Record<string, unknown> }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['treaty-admin', treatyId] });
      qc.invalidateQueries({ queryKey: ['treaty-admin', 'register'] });
      qc.invalidateQueries({ queryKey: ['treaty-admin', 'analytics'] });
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong.'),
  });
}

/* ---------------- Add layer modal ---------------- */
function LayerModal({ open, onClose, treatyId }: { open: boolean; onClose: () => void; treatyId: string }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', attachment: '', limit: '', aad: '', reinstatements: '', rateOnLine: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const numv = (v: string) => (v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

  const mut = useTreatyMutation<Record<string, unknown>>(treatyId, 'layers', () => {
    toast.success('Layer added');
    onClose();
    setF({ name: '', attachment: '', limit: '', aad: '', reinstatements: '', rateOnLine: '' });
  });

  const validAttach = numv(f.attachment) !== undefined;
  const validLimit = numv(f.limit) !== undefined && (numv(f.limit) as number) > 0;

  const submit = () => mut.mutate({
    name: f.name.trim() || undefined,
    attachment: numv(f.attachment),
    limit: numv(f.limit),
    aad: numv(f.aad),
    reinstatements: numv(f.reinstatements),
    rateOnLine: numv(f.rateOnLine),
  });

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="Add layer"
      description="Amounts are in major currency units. The server converts them to minor units."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={mut.isPending} disabled={!validAttach || !validLimit}>Add layer</Button>
      </>}
    >
      <FormSection title="Layer">
        <TextField label="Name" value={f.name} onChange={set('name')} placeholder="e.g. Layer 1" />
        <TextField label="Attachment (major)" type="number" value={f.attachment} onChange={set('attachment')} required placeholder="e.g. 5000000" />
        <TextField label="Limit (major)" type="number" value={f.limit} onChange={set('limit')} required placeholder="e.g. 10000000" />
        <TextField label="AAD (major)" type="number" value={f.aad} onChange={set('aad')} placeholder="Annual aggregate deductible" />
        <TextField label="Reinstatements" type="number" value={f.reinstatements} onChange={set('reinstatements')} placeholder="e.g. 1" />
        <TextField label="Rate on line %" type="number" value={f.rateOnLine} onChange={set('rateOnLine')} placeholder="e.g. 12.5" />
      </FormSection>
    </Modal>
  );
}

/* ---------------- Add clause modal ---------------- */
function ClauseModal({ open, onClose, treatyId }: { open: boolean; onClose: () => void; treatyId: string }) {
  const toast = useToast();
  const [f, setF] = useState({ title: '', category: 'GENERAL' as ClauseCategory, code: '', body: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const mut = useTreatyMutation<Record<string, unknown>>(treatyId, 'clauses', () => {
    toast.success('Clause added');
    onClose();
    setF({ title: '', category: 'GENERAL', code: '', body: '' });
  });

  const submit = () => mut.mutate({
    title: f.title.trim(),
    category: f.category,
    code: f.code.trim() || undefined,
    body: f.body.trim() || undefined,
  });

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="Add clause"
      description="Capture a special clause, exclusion or wording note."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={mut.isPending} disabled={!f.title.trim()}>Add clause</Button>
      </>}
    >
      <FormSection title="Clause">
        <TextField label="Title" value={f.title} onChange={set('title')} required placeholder="e.g. Sanctions limitation" />
        <FormField label="Category">
          <Select value={f.category} onChange={(e) => set('category')(e.target.value)}>
            {CLAUSE_CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </Select>
        </FormField>
        <TextField label="Code" value={f.code} onChange={set('code')} placeholder="Optional reference code" />
        <div style={{ gridColumn: '1 / -1' }}>
          <FormField label="Body">
            <Textarea rows={5} value={f.body} onChange={(e) => set('body')(e.target.value)} placeholder="Clause wording (optional)" />
          </FormField>
        </div>
      </FormSection>
    </Modal>
  );
}

/* ---------------- Add endorsement modal ---------------- */
function EndorsementModal({ open, onClose, treatyId }: { open: boolean; onClose: () => void; treatyId: string }) {
  const toast = useToast();
  const [f, setF] = useState({ description: '', effectiveDate: '', changes: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const mut = useTreatyMutation<Record<string, unknown>>(treatyId, 'endorsements', () => {
    toast.success('Endorsement raised');
    onClose();
    setF({ description: '', effectiveDate: '', changes: '' });
  });

  const submit = () => mut.mutate({
    description: f.description.trim(),
    effectiveDate: f.effectiveDate || undefined,
    changes: f.changes.trim() || undefined,
  });

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="Add endorsement"
      description="Record an amendment to the treaty terms."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={mut.isPending} disabled={!f.description.trim()}>Raise endorsement</Button>
      </>}
    >
      <FormSection title="Endorsement">
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Description" value={f.description} onChange={set('description')} required placeholder="e.g. Add cedent subsidiary" />
        </div>
        <TextField label="Effective date" type="date" value={f.effectiveDate} onChange={set('effectiveDate')} />
        <div style={{ gridColumn: '1 / -1' }}>
          <FormField label="Changes">
            <Textarea rows={4} value={f.changes} onChange={(e) => set('changes')(e.target.value)} placeholder="Detail of the changes (optional)" />
          </FormField>
        </div>
      </FormSection>
    </Modal>
  );
}

/* ---------------- Snapshot version modal ---------------- */
function VersionModal({ open, onClose, treatyId }: { open: boolean; onClose: () => void; treatyId: string }) {
  const toast = useToast();
  const [note, setNote] = useState('');

  const mut = useTreatyMutation<Record<string, unknown>>(treatyId, 'version', () => {
    toast.success('Version snapshot created');
    onClose();
    setNote('');
  });

  const submit = () => mut.mutate({ note: note.trim() || undefined });

  return (
    <Modal
      open={open} onClose={onClose} size="sm"
      title="Snapshot version"
      description="Freeze the current treaty state as an immutable version."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={mut.isPending}>Create snapshot</Button>
      </>}
    >
      <FormField label="Note">
        <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this version? (optional)" />
      </FormField>
    </Modal>
  );
}
