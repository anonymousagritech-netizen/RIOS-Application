import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users, Landmark, Award, TrendingUp, Building2, Network,
  MessageSquare, Plus, Pencil, Star, Download,
} from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { DonutChart } from '../components/DonutChart';
import { BarChart } from '../components/BarChart';
import { FormField, FormSection, Input, Select, TextField, Textarea } from '../components/Form';
import { titleCase } from '../lib/format';
import styles from './BrokerPage.module.css';

/* ---------------- Money helpers (integer minor units) ---------------- */
const money = (m?: number | null, ccy = 'USD') =>
  m == null
    ? '—'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(m / 100);
const moneyCompact = (m?: number | null, ccy = 'USD') =>
  m == null
    ? '—'
    : new Intl.NumberFormat(undefined, {
        style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1,
      }).format(m / 100);

const pct = (v?: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);

type TokenColor =
  | 'green' | 'blue' | 'amber' | 'violet' | 'slate' | 'red'
  | 'teal' | 'indigo' | 'orange' | 'rose' | 'gray';

/* Relationship score band → colour token. */
function scoreBand(score?: number | null): TokenColor {
  const s = score ?? 0;
  if (s >= 80) return 'green';
  if (s >= 60) return 'teal';
  if (s >= 40) return 'amber';
  return 'slate';
}

/* Combined-ratio band → chip colour. */
function crBand(cr?: number | null): 'green' | 'amber' | 'red' | undefined {
  if (cr == null) return undefined;
  if (cr < 100) return 'green';
  if (cr <= 110) return 'amber';
  return 'red';
}

const CONTRACT_KINDS = ['TOBA', 'BINDER', 'LINESLIP', 'FACILITY', 'OTHER'] as const;
const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const;
const COMM_KINDS = ['NOTE', 'EMAIL', 'CALL', 'MEETING', 'SUBMISSION', 'RENEWAL'] as const;
const COMM_DIRECTIONS = ['INBOUND', 'OUTBOUND', 'INTERNAL'] as const;

const CONTRACT_STATUS_COLOR: Record<string, TokenColor> = {
  DRAFT: 'slate', ACTIVE: 'green', EXPIRED: 'amber', TERMINATED: 'red',
};

/* ---------------- API shapes ---------------- */
interface BrokerRow {
  id: string;
  legalName: string;
  shortName: string | null;
  country: string | null;
  tier: string | null;
  region: string | null;
  relationshipScore: number | null;
  gwpMinor: number | null;
  boundCount: number;
  contractCount: number;
}
interface BrokersResponse { brokers: BrokerRow[]; }

interface BrokerAnalytics {
  brokerCount: number;
  totalGwpMinor: number;
  topBrokers: { id: string; legalName: string; gwpMinor: number }[];
  byTier: { key: string; n: number }[];
}

interface BrokerContract {
  id: string;
  reference: string | null;
  kind: string;
  commissionPct: number | null;
  brokeragePct: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  status: string;
}
interface BrokerPortfolioItem {
  id: string;
  reference: string;
  title: string;
  stage: string;
  currency: string;
  estPremiumMinor: number | null;
  cedentName: string | null;
  lineOfBusiness: string | null;
}
interface BrokerCommunication {
  id: string;
  kind: string;
  direction: string;
  subject: string | null;
  body: string | null;
  createdAt: string;
}
interface BrokerBook {
  gwpMinor: number;
  incurredMinor: number;
  commissionMinor: number;
  contractsBound: number;
  contractsQuoted: number;
  renewedCount: number;
  upForRenewalCount: number;
  yearsActive: number;
}
interface ScoreContribution { factor: string; points: number; detail: string; }
interface BrokerScore {
  score: number;
  band: string;
  hitRatioPct: number | null;
  retentionPct: number | null;
  contributions: ScoreContribution[];
}
interface BrokerProfitability {
  gwpMinor: number;
  incurredMinor: number;
  commissionMinor: number;
  lossRatioPct: number | null;
  commissionRatioPct: number | null;
  combinedRatioPct: number | null;
  underwritingResultMinor: number;
  marginPct: number | null;
}
interface BrokerDetail {
  id: string;
  legalName: string;
  shortName: string | null;
  country: string | null;
  reference: string | null;
  tier: string | null;
  region: string | null;
  parentBrokerId: string | null;
  parentName: string | null;
  defaultCommissionPct: number | null;
  relationshipScore: number | null;
  notes: string | null;
  children: { id: string; legalName: string }[];
  contracts: BrokerContract[];
  portfolio: BrokerPortfolioItem[];
  communications: BrokerCommunication[];
  book: BrokerBook;
  score: BrokerScore;
  profitability: BrokerProfitability;
}

/* ================================================================= */
export function BrokerPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('party:write');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const brokersQ = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<BrokersResponse>('/api/brokers'),
  });
  const analyticsQ = useQuery({
    queryKey: ['brokers', 'analytics'],
    queryFn: () => api<BrokerAnalytics>('/api/brokers/analytics'),
  });

  const brokers = brokersQ.data?.brokers ?? [];
  const analytics = analyticsQ.data;
  const topTier = analytics?.byTier.find((t) => /^(tier[\s_-]?1|1|platinum|a)$/i.test(t.key));

  const tierData = (analytics?.byTier ?? []).map((t) => ({ label: titleCase(t.key), value: t.n }));
  const topBrokerData = (analytics?.topBrokers ?? []).map((b) => ({
    label: b.legalName, value: Math.round(b.gwpMinor / 100),
  }));

  const columns: Column<BrokerRow>[] = [
    {
      key: 'broker',
      header: 'Broker',
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.legalName}</div>
          <div className={styles.cellRef}>
            {[r.shortName, r.country].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      ),
      sortValue: (r) => r.legalName.toLowerCase(),
    },
    {
      key: 'tier',
      header: 'Tier',
      render: (r) => (r.tier ? <Badge color="indigo">{titleCase(r.tier)}</Badge> : <span className={styles.cellSub}>—</span>),
      sortValue: (r) => r.tier ?? '',
    },
    {
      key: 'score',
      header: 'Relationship',
      render: (r) =>
        r.relationshipScore == null ? (
          <span className={styles.cellSub}>—</span>
        ) : (
          <Badge color={scoreBand(r.relationshipScore)}>{r.relationshipScore}/100</Badge>
        ),
      sortValue: (r) => r.relationshipScore ?? -1,
    },
    {
      key: 'gwp',
      header: 'GWP',
      align: 'right',
      render: (r) => <span className={styles.num}>{moneyCompact(r.gwpMinor)}</span>,
      sortValue: (r) => r.gwpMinor ?? 0,
    },
    {
      key: 'contracts',
      header: 'Contracts',
      align: 'right',
      render: (r) => <span className={styles.num}>{r.contractCount}</span>,
      sortValue: (r) => r.contractCount,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Broker Management"
        description="Relationships, production and profitability across your broking panel."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Broker' }]}
        actions={<Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadFile('/api/brokers/export.csv', 'brokers.csv')}>Export CSV</Button>}
      />

      <div className={styles.kpis}>
        <KpiCard
          label="Brokers"
          value={String(analytics?.brokerCount ?? 0)}
          hint="Active panel"
          icon={<Users size={18} />}
          accent="var(--primary)"
          loading={analyticsQ.isLoading}
        />
        <KpiCard
          label="Total GWP"
          value={moneyCompact(analytics?.totalGwpMinor)}
          hint="Gross written premium"
          icon={<Landmark size={18} />}
          accent="var(--accent-emerald)"
          loading={analyticsQ.isLoading}
        />
        <KpiCard
          label="Top-tier brokers"
          value={String(topTier?.n ?? 0)}
          hint="Tier 1 relationships"
          icon={<Award size={18} />}
          accent="var(--accent-violet)"
          loading={analyticsQ.isLoading}
        />
        <KpiCard
          label="Top broker GWP"
          value={moneyCompact(analytics?.topBrokers?.[0]?.gwpMinor)}
          hint={analytics?.topBrokers?.[0]?.legalName ?? '—'}
          icon={<TrendingUp size={18} />}
          accent="var(--accent-orange)"
          loading={analyticsQ.isLoading}
        />
      </div>

      <div className={styles.chartsRow}>
        <Card padded>
          <CardHeader title="Tier distribution" subtitle="Brokers by relationship tier" />
          <div className={styles.chartBlock}>
            <DonutChart data={tierData} centerLabel="brokers" emptyLabel="No tiers yet" />
          </div>
        </Card>
        <Card padded>
          <CardHeader title="Top brokers by GWP" subtitle="Gross written premium" />
          <div className={styles.chartBlock}>
            <BarChart data={topBrokerData} emptyLabel="No production yet" />
          </div>
        </Card>
      </div>

      <Card padded={false}>
        <CardHeader title="Brokers" subtitle={`${brokers.length} on panel`} />
        <Table
          columns={columns}
          rows={brokersQ.data ? brokers : undefined}
          loading={brokersQ.isLoading}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelectedId(r.id)}
          skeletonRows={6}
          empty={
            <EmptyState
              icon={<Users size={24} />}
              title="No brokers"
              message="No brokers are registered on the panel yet."
            />
          }
        />
      </Card>

      <BrokerDrawer
        brokerId={selectedId}
        canWrite={canWrite}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}

/* ================================================================= */
function BrokerDrawer({
  brokerId, canWrite, onClose,
}: { brokerId: string | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const detailQ = useQuery({
    queryKey: ['broker', brokerId],
    queryFn: () => api<BrokerDetail>(`/api/brokers/${brokerId}`),
    enabled: !!brokerId,
  });
  const b = detailQ.data;

  const invalidate = () => {
    if (brokerId) qc.invalidateQueries({ queryKey: ['broker', brokerId] });
    qc.invalidateQueries({ queryKey: ['brokers'] });
  };

  return (
    <>
      <Drawer
        open={!!brokerId}
        onClose={onClose}
        width={560}
        title={
          <span className={styles.drawerTitle}>
            <Building2 size={18} />
            {b?.legalName ?? 'Broker'}
          </span>
        }
        subtitle={b ? [b.reference, b.country].filter(Boolean).join(' · ') || undefined : undefined}
      >
        {!brokerId ? null : detailQ.isLoading || !b ? (
          <div className={styles.loading}>Loading…</div>
        ) : (
          <div className={styles.drawer}>
            <div className={styles.drawerHeadMeta}>
              {b.tier && <Badge color="indigo">{titleCase(b.tier)}</Badge>}
              {b.region && <Badge color="slate">{titleCase(b.region)}</Badge>}
              <Badge color={scoreBand(b.relationshipScore)}>
                <Star size={12} /> {b.relationshipScore ?? '—'}/100
              </Badge>
              {canWrite && (
                <div style={{ marginLeft: 'auto' }}>
                  <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditOpen(true)}>
                    Edit profile
                  </Button>
                </div>
              )}
            </div>

            <RelationshipScoreCard score={b.score} book={b.book} />
            <ProfitabilityCard p={b.profitability} />
            <HierarchyCard parentName={b.parentName} children={b.children} />
            <ContractsCard brokerId={b.id} contracts={b.contracts} canWrite={canWrite} onDone={invalidate} />
            <PortfolioCard items={b.portfolio} />
            <CommunicationsCard brokerId={b.id} comms={b.communications} canWrite={canWrite} onDone={invalidate} />
          </div>
        )}
      </Drawer>

      {b && (
        <EditProfileModal
          broker={b}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onDone={invalidate}
        />
      )}
    </>
  );
}

/* ---------------- Relationship score ---------------- */
function RelationshipScoreCard({ score, book }: { score: BrokerScore; book: BrokerBook }) {
  const band = scoreBand(score.score);
  return (
    <Card padded>
      <CardHeader title="Relationship score" subtitle={`Band: ${titleCase(score.band)}`} />
      <div className={styles.gaugeRow}>
        <span className={styles.gaugeValue} data-band={band}>{score.score}</span>
        <div className={styles.gaugeBarWrap}>
          <div className={styles.gaugeBar}>
            <span
              className={styles.gaugeFill}
              data-band={band}
              style={{ width: `${Math.max(0, Math.min(100, score.score))}%` }}
            />
          </div>
          <div className={styles.gaugeMeta}>
            {score.hitRatioPct != null && <span>Hit ratio {pct(score.hitRatioPct)}</span>}
            {score.retentionPct != null && <span>Retention {pct(score.retentionPct)}</span>}
            <span>{book.yearsActive} yrs active</span>
          </div>
        </div>
      </div>
      {score.contributions.length > 0 && (
        <ul className={styles.breakdown}>
          {score.contributions.map((c) => (
            <li key={c.factor}>
              <div className={styles.bkMain}>
                <span className={styles.bkFactor}>{titleCase(c.factor)}</span>
                {c.detail && <span className={styles.bkDetail}>{c.detail}</span>}
              </div>
              <span className={`${styles.bkPoints} ${c.points > 0 ? styles.bkCredit : ''}`}>
                {c.points > 0 ? `+${c.points}` : c.points}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- Profitability ---------------- */
function ProfitabilityCard({ p }: { p: BrokerProfitability }) {
  const cr = crBand(p.combinedRatioPct);
  const stat = (label: string, value: ReactNode, band?: 'green' | 'amber' | 'red') => (
    <div className={styles.statChip} data-band={band}>
      <span className={styles.statChipLabel}>{label}</span>
      <span className={styles.statChipValue}>{value}</span>
    </div>
  );
  return (
    <Card padded>
      <CardHeader title="Profitability" subtitle="Underwriting economics on this broker's book" />
      <div className={styles.statChips}>
        {stat('GWP', moneyCompact(p.gwpMinor))}
        {stat('Loss ratio', pct(p.lossRatioPct))}
        {stat('Commission ratio', pct(p.commissionRatioPct))}
        {stat('Combined ratio', pct(p.combinedRatioPct), cr)}
        {stat('UW result', money(p.underwritingResultMinor))}
        {stat('Margin', pct(p.marginPct))}
      </div>
    </Card>
  );
}

/* ---------------- Hierarchy ---------------- */
function HierarchyCard({
  parentName, children,
}: { parentName: string | null; children: { id: string; legalName: string }[] }) {
  if (!parentName && children.length === 0) return null;
  return (
    <Card padded>
      <CardHeader title="Hierarchy" subtitle="Group structure" />
      <div className={styles.hierarchy}>
        {parentName && (
          <div className={styles.hierRow}>
            <span className={styles.hierLabel}>Parent</span>
            <Network size={14} />
            <span>{parentName}</span>
          </div>
        )}
        {children.length > 0 && (
          <div className={styles.hierRow}>
            <span className={styles.hierLabel}>Children</span>
            <div className={styles.chipRow}>
              {children.map((c) => (
                <span key={c.id} className={styles.chip}>{c.legalName}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ---------------- Contracts ---------------- */
function ContractsCard({
  brokerId, contracts, canWrite, onDone,
}: { brokerId: string; contracts: BrokerContract[]; canWrite: boolean; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>('TOBA');
  const [status, setStatus] = useState<string>('DRAFT');
  const [reference, setReference] = useState('');
  const [commissionPct, setCommissionPct] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api(`/api/brokers/${brokerId}/contracts`, {
        body: {
          kind,
          status,
          reference: reference || undefined,
          commissionPct: commissionPct ? Number(commissionPct) : undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Contract added');
      setOpen(false);
      setReference('');
      setCommissionPct('');
      setKind('TOBA');
      setStatus('DRAFT');
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add contract'),
  });

  return (
    <Card padded>
      <CardHeader
        title="Contracts"
        subtitle={`${contracts.length} agreement${contracts.length === 1 ? '' : 's'}`}
        actions={
          canWrite ? (
            <Button size="sm" variant="subtle" icon={<Plus size={14} />} onClick={() => setOpen((v) => !v)}>
              Add contract
            </Button>
          ) : undefined
        }
      />
      {contracts.length === 0 ? (
        <p className={styles.emptyNote}>No contracts on file.</p>
      ) : (
        <ul className={styles.list}>
          {contracts.map((c) => (
            <li key={c.id} className={styles.item}>
              <div className={styles.itemMain}>
                <div className={styles.itemTop}>
                  <span className={styles.itemName}>{c.reference ?? titleCase(c.kind)}</span>
                  <Badge color="blue">{titleCase(c.kind)}</Badge>
                  <Badge color={CONTRACT_STATUS_COLOR[c.status] ?? 'gray'}>{titleCase(c.status)}</Badge>
                </div>
                <div className={styles.itemMeta}>
                  {c.commissionPct != null && <span>Comm {pct(c.commissionPct)}</span>}
                  {c.brokeragePct != null && <span>Brokerage {pct(c.brokeragePct)}</span>}
                  {c.periodStart && <span>{c.periodStart}{c.periodEnd ? ` → ${c.periodEnd}` : ''}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canWrite && open && (
        <div className={styles.inlineForm}>
          <div className={styles.inlineRow}>
            <FormField label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {CONTRACT_KINDS.map((k) => (
                  <option key={k} value={k}>{titleCase(k)}</option>
                ))}
              </Select>
            </FormField>
            <FormField label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                {CONTRACT_STATUSES.map((s) => (
                  <option key={s} value={s}>{titleCase(s)}</option>
                ))}
              </Select>
            </FormField>
          </div>
          <div className={styles.inlineRow}>
            <TextField label="Reference" value={reference} onChange={setReference} placeholder="Optional" />
            <TextField label="Commission %" value={commissionPct} onChange={setCommissionPct} type="number" placeholder="e.g. 12.5" />
          </div>
          <div className={styles.inlineActions}>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Add</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- Portfolio ---------------- */
function PortfolioCard({ items }: { items: BrokerPortfolioItem[] }) {
  return (
    <Card padded>
      <CardHeader title="Portfolio" subtitle={`${items.length} submission${items.length === 1 ? '' : 's'}`} />
      {items.length === 0 ? (
        <p className={styles.emptyNote}>No submissions from this broker.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((p) => (
            <li key={p.id} className={styles.item}>
              <div className={styles.itemMain}>
                <div className={styles.itemTop}>
                  <span className={styles.itemName}>{p.title}</span>
                  <Badge color="violet">{titleCase(p.stage)}</Badge>
                </div>
                <div className={styles.itemMeta}>
                  <span>{p.reference}</span>
                  {p.cedentName && <span>{p.cedentName}</span>}
                  {p.lineOfBusiness && <span>{titleCase(p.lineOfBusiness)}</span>}
                </div>
              </div>
              <div className={styles.itemRight}>
                <span className={styles.itemAmount}>{moneyCompact(p.estPremiumMinor, p.currency)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------- Communications ---------------- */
function CommunicationsCard({
  brokerId, comms, canWrite, onDone,
}: { brokerId: string; comms: BrokerCommunication[]; canWrite: boolean; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>('NOTE');
  const [direction, setDirection] = useState<string>('INTERNAL');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api(`/api/brokers/${brokerId}/communications`, {
        body: { kind, direction, subject: subject || undefined, body: body || undefined },
      }),
    onSuccess: () => {
      toast.success('Logged');
      setOpen(false);
      setSubject('');
      setBody('');
      setKind('NOTE');
      setDirection('INTERNAL');
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not log communication'),
  });

  return (
    <Card padded>
      <CardHeader
        title="Communications"
        subtitle={`${comms.length} entr${comms.length === 1 ? 'y' : 'ies'}`}
        actions={
          canWrite ? (
            <Button size="sm" variant="subtle" icon={<Plus size={14} />} onClick={() => setOpen((v) => !v)}>
              Log
            </Button>
          ) : undefined
        }
      />
      {comms.length === 0 ? (
        <p className={styles.emptyNote}>No communications logged.</p>
      ) : (
        <ul className={styles.list}>
          {comms.map((c) => (
            <li key={c.id} className={styles.item}>
              <div className={styles.itemMain}>
                <div className={styles.itemTop}>
                  <MessageSquare size={13} />
                  <span className={styles.itemName}>{c.subject ?? titleCase(c.kind)}</span>
                  <Badge color="slate">{titleCase(c.kind)}</Badge>
                  <Badge color="gray">{titleCase(c.direction)}</Badge>
                </div>
                {c.body && <p className={styles.commBody}>{c.body}</p>}
              </div>
              <span className={styles.commTime}>{new Date(c.createdAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}

      {canWrite && open && (
        <div className={styles.inlineForm}>
          <div className={styles.inlineRow}>
            <FormField label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {COMM_KINDS.map((k) => (
                  <option key={k} value={k}>{titleCase(k)}</option>
                ))}
              </Select>
            </FormField>
            <FormField label="Direction">
              <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
                {COMM_DIRECTIONS.map((d) => (
                  <option key={d} value={d}>{titleCase(d)}</option>
                ))}
              </Select>
            </FormField>
          </div>
          <div className={styles.inlineRowFull}>
            <TextField label="Subject" value={subject} onChange={setSubject} placeholder="Short summary" />
          </div>
          <div className={styles.inlineActions}>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Add</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- Edit profile ---------------- */
function EditProfileModal({
  broker, open, onClose, onDone,
}: { broker: BrokerDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [tier, setTier] = useState(broker.tier ?? '');
  const [region, setRegion] = useState(broker.region ?? '');
  const [relationshipScore, setRelationshipScore] = useState(
    broker.relationshipScore != null ? String(broker.relationshipScore) : '',
  );
  const [defaultCommissionPct, setDefaultCommissionPct] = useState(
    broker.defaultCommissionPct != null ? String(broker.defaultCommissionPct) : '',
  );
  const [notes, setNotes] = useState(broker.notes ?? '');

  const mut = useMutation({
    mutationFn: () =>
      api(`/api/brokers/${broker.id}/profile`, {
        body: {
          tier: tier || undefined,
          region: region || undefined,
          relationshipScore: relationshipScore ? Number(relationshipScore) : undefined,
          defaultCommissionPct: defaultCommissionPct ? Number(defaultCommissionPct) : undefined,
          notes: notes || undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Profile updated');
      onClose();
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update profile'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Edit broker profile"
      description={broker.legalName}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Save</Button>
        </>
      }
    >
      <div className={styles.modalForm}>
        <FormSection>
          <TextField label="Tier" value={tier} onChange={setTier} placeholder="e.g. Tier 1" />
          <TextField label="Region" value={region} onChange={setRegion} placeholder="e.g. EMEA" />
          <TextField
            label="Relationship score"
            value={relationshipScore}
            onChange={setRelationshipScore}
            type="number"
            hint="0–100"
          />
          <TextField
            label="Default commission %"
            value={defaultCommissionPct}
            onChange={setDefaultCommissionPct}
            type="number"
            placeholder="e.g. 12.5"
          />
        </FormSection>
        <FormField label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Internal notes" />
        </FormField>
      </div>
    </Modal>
  );
}
