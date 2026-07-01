import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Users, TrendingUp, Percent, Star, MapPin, ShieldCheck,
  Layers, FileText, AlertTriangle, MessageSquare, PlusCircle, Pencil, Network, Download,
} from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { BarChart } from '../components/BarChart';
import { FormField, FormSection, Input, Select, TextField, Textarea } from '../components/Form';
import { titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';
import type { TokenColor } from '../lib/status';
import styles from './CedentPage.module.css';

/* ---------------- Money helpers (minor units) ---------------- */
const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
const compact = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);

/* ---------------- Score / ratio banding ---------------- */
type ScoreBand = 'green' | 'teal' | 'amber' | 'slate';
const scoreBand = (score: number | null | undefined): ScoreBand =>
  score == null ? 'slate' : score >= 80 ? 'green' : score >= 60 ? 'teal' : score >= 40 ? 'amber' : 'slate';
// combined ratio: <100 green, 100–110 amber, >110 red
const crBand = (cr: number | null | undefined): 'green' | 'amber' | 'red' | undefined =>
  cr == null ? undefined : cr < 100 ? 'green' : cr <= 110 ? 'amber' : 'red';

const STAGE_COLOR: Record<string, TokenColor> = {
  SUBMISSION: 'slate', TRIAGE: 'blue', ANALYSIS: 'indigo', PRICING: 'violet',
  REFERRAL: 'amber', QUOTED: 'teal', BOUND: 'green', DECLINED: 'red', LAPSED: 'gray',
};
const RISK_BAND_COLOR: Record<string, TokenColor> = {
  LOW: 'green', MODERATE: 'amber', ELEVATED: 'orange', HIGH: 'red',
};
const TREATY_STATUS_COLOR: Record<string, TokenColor> = {
  DRAFT: 'slate', QUOTED: 'teal', BOUND: 'green', ACTIVE: 'green', EXPIRED: 'gray', CANCELLED: 'red',
};
const CLAIM_STATUS_COLOR: Record<string, TokenColor> = {
  OPEN: 'amber', ADVISED: 'blue', RESERVED: 'violet', PAID: 'green', SETTLED: 'green', CLOSED: 'gray', DENIED: 'red',
};
const stageColor = (s: string): TokenColor => STAGE_COLOR[s] ?? 'slate';
const riskColor = (b: string | null | undefined): TokenColor => (b ? RISK_BAND_COLOR[b] ?? 'gray' : 'gray');

/* ---------------- Types ---------------- */
interface CedentRow {
  id: string;
  legalName: string;
  shortName: string | null;
  country: string | null;
  rating: string | null;
  ratingAgency: string | null;
  relationshipScore: number | null;
  capacityAllocatedMinor: number | null;
  gwpMinor: number | null;
  boundCount: number;
}
interface CedentAnalytics {
  cedentCount: number;
  totalGwpMinor: number;
  bookLossRatioPct: number;
  topCedents: { id: string; legalName: string; gwpMinor: number; lossRatioPct: number }[];
}
interface GroupMember { id: string; legalName: string; }
interface PortfolioItem {
  id: string; reference: string; title: string; stage: string; currency: string;
  structure: string | null; lineOfBusiness: string | null; estPremiumMinor: number | null; riskBand: string | null;
}
interface TreatyItem {
  id: string; reference: string; name: string; contractKind: string | null; basis: string | null;
  status: string; periodStart: string | null; periodEnd: string | null;
}
interface ClaimItem {
  id: string; reference: string; description: string | null; lossDate: string | null; status: string;
  currency: string; grossLossMinor: number | null; outstandingMinor: number | null; paidMinor: number | null;
}
interface Communication {
  id: string; kind: string; direction: string; subject: string | null; body: string | null; createdAt: string;
}
interface CedentBook {
  gwpMinor: number; incurredMinor: number; commissionMinor: number;
  contractsBound: number; contractsQuoted: number; renewedCount: number; upForRenewalCount: number;
  yearsActive: number; paidMinor: number; outstandingMinor: number;
}
interface ScoreContribution { factor: string; points: number; detail: string; }
interface CedentScore {
  score: number; band: string; hitRatioPct: number; retentionPct: number; contributions: ScoreContribution[];
}
interface CedentProfitability {
  gwpMinor: number; incurredMinor: number; commissionMinor: number;
  lossRatioPct: number; commissionRatioPct: number; combinedRatioPct: number;
  underwritingResultMinor: number; marginPct: number;
}
interface LossHistory { incurredMinor: number; paidMinor: number; outstandingMinor: number; }
interface CedentDetail {
  id: string;
  legalName: string;
  shortName: string | null;
  country: string | null;
  reference: string | null;
  groupParentId: string | null;
  groupParentName: string | null;
  domicile: string | null;
  ratingAgency: string | null;
  rating: string | null;
  financialStrengthMinor: number | null;
  relationshipScore: number | null;
  capacityAllocatedMinor: number | null;
  notes: string | null;
  groupMembers: GroupMember[];
  portfolio: PortfolioItem[];
  treaties: TreatyItem[];
  claims: ClaimItem[];
  communications: Communication[];
  book: CedentBook;
  score: CedentScore;
  profitability: CedentProfitability;
  lossHistory: LossHistory;
}

/* ---------------- Data hooks ---------------- */
function useCedents() {
  return useQuery({ queryKey: ['cedents'], queryFn: () => api<{ cedents: CedentRow[] }>('/api/cedents') });
}
function useCedentAnalytics() {
  return useQuery({ queryKey: ['cedents', 'analytics'], queryFn: () => api<CedentAnalytics>('/api/cedents/analytics') });
}
function useCedent(id: string | null) {
  return useQuery({ queryKey: ['cedent', id], queryFn: () => api<CedentDetail>(`/api/cedents/${id}`), enabled: !!id });
}

/* ---------------- Page ---------------- */
export function CedentPage() {
  const [detailId, setDetailId] = useState<string | null>(null);
  const cedents = useCedents();
  const analytics = useCedentAnalytics();
  const a = analytics.data;

  const barData = (a?.topCedents ?? []).map((c) => ({
    label: c.legalName,
    value: Math.round(c.gwpMinor / 100),
    status: c.lossRatioPct > 100 ? 'red' : c.lossRatioPct > 70 ? 'amber' : 'green',
  }));

  const columns: Column<CedentRow>[] = [
    {
      key: 'name', header: 'Cedent', sortValue: (r) => r.legalName,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.shortName || r.legalName}</div>
          <div className={styles.cellRef}>{r.country ? r.country : 'Domicile TBC'}{r.boundCount ? ` · ${r.boundCount} bound` : ''}</div>
        </div>
      ),
    },
    {
      key: 'rating', header: 'Rating',
      render: (r) => r.rating
        ? <Badge color="indigo">{r.rating}{r.ratingAgency ? ` · ${r.ratingAgency}` : ''}</Badge>
        : <span className={styles.cellSub}>Unrated</span>,
    },
    {
      key: 'score', header: 'Relationship', sortValue: (r) => r.relationshipScore ?? -1,
      render: (r) => r.relationshipScore != null
        ? <Badge color={scoreBand(r.relationshipScore)}>{r.relationshipScore} / 100</Badge>
        : <span className={styles.cellSub}>—</span>,
    },
    {
      key: 'gwp', header: 'GWP', align: 'right', sortValue: (r) => r.gwpMinor ?? 0,
      render: (r) => <span className={styles.num}>{money(r.gwpMinor)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Cedent Management"
        description="The cedent relationship workspace: rating, capacity, profitability, portfolio, treaties, claims and correspondence in one place."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Cedent' }]}
        actions={<Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadFile('/api/cedents/export.csv', 'cedents.csv')}>Export CSV</Button>}
      />

      <div className={styles.kpis}>
        <KpiCard label="Cedents" value={String(a?.cedentCount ?? 0)} hint="Reinsured relationships" icon={<Building2 size={20} />} accent="var(--primary)" loading={analytics.isLoading} />
        <KpiCard label="Total GWP" value={a ? compact(a.totalGwpMinor) : '—'} hint="Gross written premium across the book" icon={<TrendingUp size={20} />} accent="var(--accent-cyan)" loading={analytics.isLoading} />
        <KpiCard label="Book loss ratio" value={a ? `${a.bookLossRatioPct}%` : '—'} hint="Incurred over premium" icon={<Percent size={20} />} accent="var(--accent-orange)" loading={analytics.isLoading} />
        <KpiCard label="Top cedents" value={String(a?.topCedents.length ?? 0)} hint="Ranked by premium" icon={<Users size={20} />} accent="var(--accent-violet)" loading={analytics.isLoading} />
      </div>

      <Card padded={false} style={{ marginBottom: 'var(--space-5)' }}>
        <CardHeader title="Premium by cedent" subtitle="Top cedents by GWP — bar colour reflects loss ratio" />
        <div className={styles.chartsGrid}>
          <div className={styles.chartBlock}>
            <span className={styles.chartLabel}>Gross written premium</span>
            <BarChart data={barData} emptyLabel="No cedent premium yet" />
          </div>
          <div className={styles.chartBlock}>
            <span className={styles.chartLabel}>Book snapshot</span>
            <div className={styles.statChips}>
              <StatChip label="Cedents" value={String(a?.cedentCount ?? 0)} />
              <StatChip label="Total GWP" value={a ? compact(a.totalGwpMinor) : '—'} />
              <StatChip label="Loss ratio" value={a ? `${a.bookLossRatioPct}%` : '—'} band={crBand(a?.bookLossRatioPct)} />
            </div>
          </div>
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader title="Cedents" subtitle="Every reinsured relationship" />
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={cedents.data?.cedents}
            loading={cedents.isLoading}
            rowKey={(r) => r.id}
            onRowClick={(r) => setDetailId(r.id)}
            empty={<EmptyState icon={<Building2 size={18} />} title="No cedents" message="Cedents appear here once parties are onboarded as reinsureds." />}
            skeletonRows={6}
          />
        </div>
      </Card>

      <CedentDrawer id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

/* ---------------- Cedent workspace drawer ---------------- */
function CedentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: c, isLoading } = useCedent(id);
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('party:write');
  const [showEdit, setShowEdit] = useState(false);

  return (
    <Drawer
      open={!!id} onClose={onClose} width={600}
      title={c ? <span className={styles.drawerTitle}><Building2 size={16} /> {c.shortName || c.legalName}</span> : 'Cedent'}
      subtitle={c ? `${c.reference ?? 'No reference'}${c.country ? ' · ' + c.country : ''}` : undefined}
    >
      {isLoading || !c ? (
        <p className={styles.emptyLine}>Loading…</p>
      ) : (
        <div className={styles.drawer}>
          {/* Profile header */}
          <Card padded>
            <CardHeader
              title="Profile"
              subtitle={c.legalName}
              actions={canWrite ? <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => setShowEdit(true)}>Edit profile</Button> : undefined}
            />
            <div className={styles.facts}>
              <Fact label="Rating" value={c.rating ? <Badge color="indigo">{c.rating}{c.ratingAgency ? ` · ${c.ratingAgency}` : ''}</Badge> : 'Unrated'} />
              <Fact label="Domicile" value={<span className={styles.drawerTitle}><MapPin size={13} /> {c.domicile || c.country || '—'}</span>} />
              <Fact label="Relationship score" value={c.relationshipScore != null ? <Badge color={scoreBand(c.relationshipScore)}>{c.relationshipScore} / 100</Badge> : '—'} />
              <Fact label="Capacity allocated" value={money(c.capacityAllocatedMinor)} />
              <Fact label="Financial strength" value={money(c.financialStrengthMinor)} />
              <Fact label="Years active" value={String(c.book.yearsActive)} />
            </div>
            {c.notes && <p className={styles.commBody} style={{ marginTop: 'var(--space-3)' }}>{c.notes}</p>}
          </Card>

          {/* Relationship score */}
          <Card padded>
            <CardHeader title={<span className={styles.drawerTitle}><Star size={15} /> Relationship score</span>} subtitle="How the relationship earns its score" />
            <div className={styles.scoreRow}>
              <div className={styles.scoreValue} data-band={scoreBand(c.score.score)}>
                {c.score.score}<span className={styles.scoreMax}> /100</span>
              </div>
              <div className={styles.scoreBarWrap}>
                <div className={styles.scoreBar}>
                  <span className={styles.scoreFill} data-band={scoreBand(c.score.score)} style={{ width: `${Math.max(0, Math.min(100, c.score.score))}%` }} />
                </div>
                <div className={styles.scoreMetaRow}>
                  <Badge color={scoreBand(c.score.score)}>{titleCase(c.score.band)}</Badge>
                  <span className={styles.cellSub}>Hit {c.score.hitRatioPct}% · Retention {c.score.retentionPct}%</span>
                </div>
              </div>
            </div>
            {c.score.contributions.length > 0 && (
              <ul className={styles.breakdown}>
                {c.score.contributions.map((ct) => (
                  <li key={ct.factor}>
                    <span className={styles.bkFactor}>{ct.factor}</span>
                    <span className={styles.bkDetail}>{ct.detail}</span>
                    <span className={`${styles.bkPoints} ${ct.points < 0 ? styles.bkCredit : ''}`}>{ct.points > 0 ? '+' : ''}{ct.points}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Profitability */}
          <Card padded>
            <CardHeader title="Profitability" subtitle="Underwriting result on this relationship" />
            <div className={styles.statChips}>
              <StatChip label="GWP" value={compact(c.profitability.gwpMinor)} />
              <StatChip label="Loss ratio" value={`${c.profitability.lossRatioPct}%`} band={crBand(c.profitability.lossRatioPct)} />
              <StatChip label="Commission" value={`${c.profitability.commissionRatioPct}%`} />
              <StatChip label="Combined ratio" value={`${c.profitability.combinedRatioPct}%`} band={crBand(c.profitability.combinedRatioPct)} />
              <StatChip label="UW result" value={money(c.profitability.underwritingResultMinor)} band={c.profitability.underwritingResultMinor >= 0 ? 'green' : 'red'} />
              <StatChip label="Margin" value={`${c.profitability.marginPct}%`} band={c.profitability.marginPct >= 0 ? 'green' : 'red'} />
            </div>
          </Card>

          {/* Group structure */}
          {(c.groupParentName || c.groupMembers.length > 0) && (
            <Card padded>
              <CardHeader title={<span className={styles.drawerTitle}><Network size={15} /> Group structure</span>} subtitle="Corporate hierarchy" />
              {c.groupParentName && (
                <div className={styles.groupParent}>
                  <Building2 size={14} /> Part of {c.groupParentName}
                </div>
              )}
              {c.groupMembers.length > 0 ? (
                <ul className={styles.memberList}>
                  {c.groupMembers.map((m) => <li key={m.id} className={styles.memberChip}>{m.legalName}</li>)}
                </ul>
              ) : <p className={styles.emptyLine}>No affiliated group members.</p>}
            </Card>
          )}

          {/* Portfolio submissions */}
          <Card padded={false}>
            <CardHeader title={<span className={styles.drawerTitle}><Layers size={15} /> Portfolio</span>} subtitle="Live underwriting submissions" />
            <div className={styles.tableWrap}>
              <Table
                columns={portfolioColumns}
                rows={c.portfolio}
                rowKey={(r) => r.id}
                empty={<EmptyState icon={<Layers size={18} />} title="No submissions" message="No live submissions from this cedent." />}
                skeletonRows={3}
              />
            </div>
          </Card>

          {/* Historical treaties */}
          <Card padded={false}>
            <CardHeader title={<span className={styles.drawerTitle}><FileText size={15} /> Treaties</span>} subtitle="Bound & historical contracts" />
            <div className={styles.tableWrap}>
              <Table
                columns={treatyColumns}
                rows={c.treaties}
                rowKey={(r) => r.id}
                empty={<EmptyState icon={<FileText size={18} />} title="No treaties" message="No treaties on record for this cedent." />}
                skeletonRows={3}
              />
            </div>
          </Card>

          {/* Loss / claims */}
          <Card padded>
            <CardHeader title={<span className={styles.drawerTitle}><AlertTriangle size={15} /> Loss & claims</span>} subtitle="Incurred, paid and outstanding" />
            <div className={styles.lossKpis}>
              <StatChip label="Incurred" value={money(c.lossHistory.incurredMinor)} />
              <StatChip label="Paid" value={money(c.lossHistory.paidMinor)} />
              <StatChip label="Outstanding" value={money(c.lossHistory.outstandingMinor)} />
            </div>
            <Table
              columns={claimColumns}
              rows={c.claims}
              rowKey={(r) => r.id}
              empty={<EmptyState icon={<ShieldCheck size={18} />} title="No claims" message="No claims recorded for this cedent." />}
              skeletonRows={3}
            />
          </Card>

          {/* Communications */}
          <CommunicationsCard cedentId={c.id} communications={c.communications} canWrite={canWrite} />
        </div>
      )}

      {c && <EditProfileModal open={showEdit} onClose={() => setShowEdit(false)} cedent={c} />}
    </Drawer>
  );
}

/* ---------------- Nested tables ---------------- */
const portfolioColumns: Column<PortfolioItem>[] = [
  {
    key: 'title', header: 'Submission', sortValue: (r) => r.title,
    render: (r) => (
      <div>
        <div className={styles.cellMain}>{r.title}</div>
        <div className={styles.cellRef}>{r.reference}{r.structure ? ` · ${titleCase(r.structure)}` : ''}</div>
      </div>
    ),
  },
  { key: 'stage', header: 'Stage', render: (r) => <Badge color={stageColor(r.stage)}>{titleCase(r.stage)}</Badge> },
  { key: 'risk', header: 'Risk', render: (r) => r.riskBand ? <Badge color={riskColor(r.riskBand)}>{titleCase(r.riskBand)}</Badge> : <span className={styles.cellSub}>—</span> },
  { key: 'prem', header: 'Est. premium', align: 'right', sortValue: (r) => r.estPremiumMinor ?? 0, render: (r) => <span className={styles.num}>{money(r.estPremiumMinor, r.currency)}</span> },
];

const treatyColumns: Column<TreatyItem>[] = [
  {
    key: 'name', header: 'Treaty', sortValue: (r) => r.name,
    render: (r) => (
      <div>
        <div className={styles.cellMain}>{r.name}</div>
        <div className={styles.cellRef}>{r.reference}{r.contractKind ? ` · ${titleCase(r.contractKind)}` : ''}{r.basis ? ` · ${titleCase(r.basis)}` : ''}</div>
      </div>
    ),
  },
  { key: 'status', header: 'Status', render: (r) => <Badge color={TREATY_STATUS_COLOR[r.status] ?? 'slate'}>{titleCase(r.status)}</Badge> },
  {
    key: 'period', header: 'Period', align: 'right',
    render: (r) => <span className={styles.cellSub}>{fmtDate(r.periodStart)} → {fmtDate(r.periodEnd)}</span>,
  },
];

const claimColumns: Column<ClaimItem>[] = [
  {
    key: 'desc', header: 'Claim', sortValue: (r) => r.description ?? r.reference,
    render: (r) => (
      <div>
        <div className={styles.cellMain}>{r.description || r.reference}</div>
        <div className={styles.cellRef}>{r.reference} · {fmtDate(r.lossDate)}</div>
      </div>
    ),
  },
  { key: 'status', header: 'Status', render: (r) => <Badge color={CLAIM_STATUS_COLOR[r.status] ?? 'slate'}>{titleCase(r.status)}</Badge> },
  { key: 'gross', header: 'Gross loss', align: 'right', sortValue: (r) => r.grossLossMinor ?? 0, render: (r) => <span className={styles.num}>{money(r.grossLossMinor, r.currency)}</span> },
];

/* ---------------- Communications card ---------------- */
const COMM_KINDS = ['CALL', 'EMAIL', 'MEETING', 'NOTE', 'LETTER'] as const;

function CommunicationsCard({ cedentId, communications, canWrite }: {
  cedentId: string; communications: Communication[]; canWrite: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [kind, setKind] = useState<string>('NOTE');
  const [subject, setSubject] = useState('');

  const add = useMutation({
    mutationFn: (body: { kind: string; direction: string; subject?: string }) =>
      api(`/api/cedents/${cedentId}/communications`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cedent', cedentId] });
      toast.success('Communication logged');
      setSubject('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not log the communication'),
  });

  return (
    <Card padded>
      <CardHeader title={<span className={styles.drawerTitle}><MessageSquare size={15} /> Communications</span>} subtitle="Correspondence log" />
      {canWrite && (
        <div className={styles.commAddRow}>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Communication kind">
            {COMM_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
          </Select>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject or short note…" />
          <Button size="sm" variant="secondary" icon={<PlusCircle size={14} />} disabled={!subject.trim()} loading={add.isPending}
            onClick={() => add.mutate({ kind, direction: 'OUTBOUND', subject: subject.trim() })}>
            Add
          </Button>
        </div>
      )}
      {communications.length === 0 ? (
        <p className={styles.emptyLine}>No communications logged yet.</p>
      ) : (
        <ul className={styles.commList}>
          {communications.map((m) => (
            <li key={m.id} className={styles.commItem}>
              <div className={styles.commTop}>
                <Badge color="blue">{titleCase(m.kind)}</Badge>
                <Badge color="slate">{titleCase(m.direction)}</Badge>
                <span className={styles.commSubject}>{m.subject || '—'}</span>
                <span className={styles.commTime} style={{ marginLeft: 'auto' }}>{fmtDateTime(m.createdAt)}</span>
              </div>
              {m.body && <p className={styles.commBody}>{m.body}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- Edit profile modal ---------------- */
function EditProfileModal({ open, onClose, cedent }: { open: boolean; onClose: () => void; cedent: CedentDetail }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({
    rating: cedent.rating ?? '',
    ratingAgency: cedent.ratingAgency ?? '',
    domicile: cedent.domicile ?? '',
    relationshipScore: cedent.relationshipScore != null ? String(cedent.relationshipScore) : '',
    capacityAllocated: cedent.capacityAllocatedMinor != null ? String(cedent.capacityAllocatedMinor / 100) : '',
    financialStrength: cedent.financialStrengthMinor != null ? String(cedent.financialStrengthMinor / 100) : '',
    notes: cedent.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const numv = (v: string) => (v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/api/cedents/${cedent.id}/profile`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cedent', cedent.id] });
      qc.invalidateQueries({ queryKey: ['cedents'] });
      toast.success('Cedent profile updated');
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save the profile.'),
  });

  const submit = () => {
    setError(null);
    save.mutate({
      groupParentId: cedent.groupParentId ?? undefined,
      rating: f.rating.trim() || undefined,
      ratingAgency: f.ratingAgency.trim() || undefined,
      domicile: f.domicile.trim() || undefined,
      relationshipScore: numv(f.relationshipScore),
      capacityAllocated: numv(f.capacityAllocated),
      financialStrength: numv(f.financialStrength),
      notes: f.notes.trim() || undefined,
    });
  };

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="Edit cedent profile"
      description="Rating, domicile, relationship score and capacity. Financial strength and capacity are entered in major units."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={save.isPending}>Save profile</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Rating & domicile">
          <TextField label="Rating" value={f.rating} onChange={set('rating')} placeholder="e.g. A+" />
          <TextField label="Rating agency" value={f.ratingAgency} onChange={set('ratingAgency')} placeholder="e.g. AM Best" />
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Domicile" value={f.domicile} onChange={set('domicile')} placeholder="e.g. Bermuda" />
          </div>
        </FormSection>

        <FormSection title="Relationship & capacity">
          <TextField label="Relationship score (0–100)" type="number" value={f.relationshipScore} onChange={set('relationshipScore')} placeholder="e.g. 82" />
          <TextField label="Capacity allocated (major)" type="number" value={f.capacityAllocated} onChange={set('capacityAllocated')} placeholder="e.g. 25000000" />
          <TextField label="Financial strength (major)" type="number" value={f.financialStrength} onChange={set('financialStrength')} placeholder="e.g. 500000000" />
        </FormSection>

        <FormSection title="Notes">
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField label="Notes">
              <Textarea value={f.notes} onChange={(e) => set('notes')(e.target.value)} rows={3} placeholder="Relationship context, appetite, key contacts…" />
            </FormField>
          </div>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/* ---------------- Small helpers ---------------- */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{value}</span>
    </div>
  );
}

function StatChip({ label, value, band }: { label: string; value: string; band?: 'green' | 'amber' | 'red' }) {
  return (
    <div className={styles.statChip} data-band={band}>
      <span className={styles.statChipLabel}>{label}</span>
      <span className={styles.statChipValue}>{value}</span>
    </div>
  );
}

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
