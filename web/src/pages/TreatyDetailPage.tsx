import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import type { LayerDTO, ParticipationDTO } from '@rios/shared';
import {
  useTreaty, useFinancialEvents, useStatement, useTransitionTreaty,
  usePostToGl, useStatusColors, useClaims,
} from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/Modal';
import { DefinitionList, ErrorState, PageLoader } from '../components/Feedback';
import { legalTransitions } from '../lib/status';
import { formatMoney, formatDate, formatPercent, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { FinancialEventDTO } from '@rios/shared';
import { ClipboardList, DollarSign, Coins, Layers, Users, CalendarDays } from 'lucide-react';
import shared from './shared.module.css';
import styles from './TreatyDetailPage.module.css';

const TABS = [
  { id: 'structure', label: 'Structure' },
  { id: 'terms', label: 'Terms' },
  { id: 'financials', label: 'Financial events' },
  { id: 'statement', label: 'Statement' },
  { id: 'claims', label: 'Claims' },
];

export function TreatyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const toast = useToast();

  const { data: treaty, isLoading, isError } = useTreaty(id);
  const statusColors = useStatusColors('contract_status');
  const transition = useTransitionTreaty(id!);

  const [tab, setTab] = useState('structure');
  const [confirmTo, setConfirmTo] = useState<string | null>(null);

  if (isLoading) return <PageLoader label="Loading treaty…" />;
  if (isError || !treaty) {
    return <Card><ErrorState title="Treaty not found" message="It may have been removed or you lack access." action={<Button onClick={() => navigate('/treaties')}>Back to treaties</Button>} /></Card>;
  }

  const nextStates = legalTransitions(treaty.status);
  const currency = treaty.currency;

  const runTransition = async (to: string) => {
    try {
      const res = await transition.mutateAsync(to);
      toast.success(`Treaty moved to ${titleCase(res.status)}`);
      if (res.financialEvents?.length) {
        toast.success(`${res.financialEvents.length} financial event(s) booked`);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Transition failed');
    } finally {
      setConfirmTo(null);
    }
  };

  const onTransitionClick = (to: string) => {
    // Binding books the deposit premium - always confirm.
    if (to === 'BOUND' || to === 'CANCELLED' || to === 'COMMUTED') setConfirmTo(to);
    else runTransition(to);
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Treaties', to: '/treaties' }, { label: treaty.reference ?? treaty.name }]}
        title={treaty.name}
        description={
          <span className={styles.subline}>
            <span className={shared.cellRef}>{treaty.reference}</span>
            <span className={styles.dot}>·</span>
            {titleCase(treaty.basis)}
            {treaty.proportionalType ? ` ${titleCase(treaty.proportionalType)}` : ''}
            {treaty.npType ? ` ${treaty.npType}` : ''}
            <span className={styles.dot}>·</span>
            {treaty.currency}
            {treaty.cedentName ? (
              <>
                <span className={styles.dot}>·</span>
                {treaty.cedentPartyId
                  ? <Link className={styles.cedentLink} to={`/parties/${treaty.cedentPartyId}`}>{treaty.cedentName}</Link>
                  : treaty.cedentName}
              </>
            ) : null}
          </span>
        }
        actions={
          <div className={styles.headerActions}>
            <StatusPill status={treaty.status} metaColors={statusColors} />
            {hasPermission('treaty:write') && nextStates.map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === 'CANCELLED' ? 'danger' : 'secondary'}
                onClick={() => onTransitionClick(to)}
                loading={transition.isPending && confirmTo === to}
              >
                {titleCase(to)}
              </Button>
            ))}
          </div>
        }
      />

      <div className={styles.kpiRow}>
        <KpiCard label="Currency" value={treaty.currency} icon={<Coins size={18} />} accent="var(--primary)" hint={titleCase(treaty.basis)} />
        <KpiCard label="Layers" value={treaty.layers?.length ?? 0} icon={<Layers size={18} />} accent="var(--accent-violet)" hint="Structured layers" />
        <KpiCard label="Participations" value={treaty.participations?.length ?? 0} icon={<Users size={18} />} accent="var(--accent-cyan)" hint="Placed reinsurers" />
        <KpiCard label="Inception" value={formatDate(treaty.periodStart)} icon={<CalendarDays size={18} />} accent="var(--accent-emerald)" hint={treaty.periodEnd ? `to ${formatDate(treaty.periodEnd)}` : 'Period start'} />
      </div>

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        <div className={styles.tabBody}>
          {tab === 'structure' && <StructureTab treaty={treaty} currency={currency} />}
          {tab === 'terms' && <TermsTab terms={treaty.terms} />}
          {tab === 'financials' && <FinancialsTab id={id!} currency={currency} />}
          {tab === 'statement' && <StatementTab id={id!} canPost={hasPermission('accounting:post')} />}
          {tab === 'claims' && <ClaimsTab id={id!} />}
        </div>
      </Card>

      <ConfirmDialog
        open={!!confirmTo}
        onClose={() => setConfirmTo(null)}
        onConfirm={() => confirmTo && runTransition(confirmTo)}
        loading={transition.isPending}
        destructive={confirmTo === 'CANCELLED'}
        title={`Move to ${titleCase(confirmTo ?? '')}?`}
        confirmLabel={`Yes, ${titleCase(confirmTo ?? '')}`}
        message={
          confirmTo === 'BOUND'
            ? 'Binding this treaty will book the deposit premium as a financial event. This is a material accounting action.'
            : confirmTo === 'CANCELLED'
              ? 'Cancelling the treaty stops its lifecycle. This cannot be undone.'
              : `This will transition the treaty to ${titleCase(confirmTo ?? '')}.`
        }
      />
    </>
  );
}

function StructureTab({ treaty, currency }: { treaty: ReturnType<typeof useTreaty>['data'] & {}; currency: string }) {
  const layers = treaty?.layers ?? [];
  const participations = treaty?.participations ?? [];

  const layerCols: Column<LayerDTO>[] = [
    { key: 'layerNo', header: '#', sortValue: (l) => l.layerNo, render: (l) => l.layerNo },
    { key: 'name', header: 'Layer', render: (l) => l.name ?? `Layer ${l.layerNo}` },
    { key: 'attachment', header: 'Attachment', align: 'right', render: (l) => <span className={shared.money}>{formatMoney(l.attachmentMinor, l.currency)}</span> },
    { key: 'limit', header: 'Limit', align: 'right', render: (l) => <span className={shared.money}>{formatMoney(l.limitMinor, l.currency)}</span> },
    { key: 'aad', header: 'AAD', align: 'right', render: (l) => <span className={shared.money}>{formatMoney(l.aadMinor, l.currency)}</span> },
    { key: 'rol', header: 'ROL', align: 'right', render: (l) => l.rateOnLine != null ? formatPercent(l.rateOnLine) : '-' },
    {
      key: 'reinst',
      header: 'Reinstatements',
      align: 'right',
      render: (l) => l.reinstatements == null ? '-' : (
        <span>
          {l.reinstatements}
          {l.reinstatementRates?.length ? ` @ ${l.reinstatementRates.map((r) => formatPercent(r)).join(', ')}` : ''}
        </span>
      ),
    },
  ];

  const partCols: Column<ParticipationDTO>[] = [
    { key: 'party', header: 'Reinsurer', render: (p) => <span className={shared.cellMain}>{p.partyName ?? p.partyId}</span> },
    { key: 'written', header: 'Written line', align: 'right', render: (p) => formatPercent(p.writtenLine) },
    { key: 'signed', header: 'Signed line', align: 'right', render: (p) => p.signedLine != null ? formatPercent(p.signedLine) : '-' },
    { key: 'order', header: 'Order', align: 'right', render: (p) => p.orderPct != null ? formatPercent(p.orderPct) : '-' },
    { key: 'status', header: 'Status', align: 'right', render: (p) => <Badge color="slate">{titleCase(p.status)}</Badge> },
  ];

  return (
    <div className={styles.stack}>
      <section>
        <CardHeader title="Layers" subtitle={`${layers.length} layer(s) · ${currency}`} />
        <Table columns={layerCols} rows={layers} rowKey={(l) => l.id} empty={<EmptyState title="No layers" message="This treaty has no structured layers." />} skeletonRows={3} />
      </section>
      <section>
        <CardHeader title="Participations" subtitle={`${participations.length} reinsurer(s) - written vs signed lines`} />
        <Table columns={partCols} rows={participations} rowKey={(p) => p.id} empty={<EmptyState title="No participations" message="No reinsurers placed on this treaty yet." />} skeletonRows={3} />
      </section>
    </div>
  );
}

function TermsTab({ terms }: { terms?: Record<string, unknown> }) {
  const entries = Object.entries(terms ?? {});
  if (!entries.length) {
    return <EmptyState title="No terms recorded" message="Commercial terms for this treaty have not been captured." icon={<ClipboardList size={16} />} />;
  }
  return (
    <DefinitionList
      items={entries.map(([k, v]) => ({
        term: titleCase(k),
        value: renderTermValue(k, v),
      }))}
    />
  );
}

function renderTermValue(key: string, value: unknown): string {
  if (value == null) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' && /premium|amount|deposit|limit/i.test(key)) {
    return value.toLocaleString();
  }
  return String(value);
}

function FinancialsTab({ id, currency }: { id: string; currency: string }) {
  const { data, isLoading } = useFinancialEvents(id);
  const cols: Column<FinancialEventDTO>[] = [
    { key: 'bookedAt', header: 'Booked', sortValue: (e) => e.bookedAt, render: (e) => formatDate(e.bookedAt) },
    { key: 'eventType', header: 'Type', render: (e) => <Badge color="indigo">{titleCase(e.eventType)}</Badge> },
    { key: 'narrative', header: 'Narrative', render: (e) => e.narrative ?? '-' },
    { key: 'direction', header: 'Dr/Cr', align: 'center', render: (e) => <Badge color={e.direction === 'DR' ? 'blue' : 'teal'}>{e.direction}</Badge> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (e) => e.amountMinor, render: (e) => <span className={shared.money}>{formatMoney(e.amountMinor, e.currency || currency)}</span> },
  ];
  return (
    <Table
      columns={cols}
      rows={data?.events}
      loading={isLoading}
      rowKey={(e) => e.id}
      empty={<EmptyState title="No financial events" message="Events are booked as the treaty progresses through its lifecycle (e.g. on binding)." icon={<DollarSign size={16} />} />}
    />
  );
}

function ClaimsTab({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useClaims({ contractId: id });
  const statusColors = useStatusColors('claim_status');
  const claims = data?.claims ?? [];
  const cols: Column<(typeof claims)[number]>[] = [
    { key: 'reference', header: 'Reference', sortValue: (c) => c.reference ?? '', render: (c) => <span className={shared.cellRef}>{c.reference ?? '-'}</span> },
    { key: 'description', header: 'Claim', sortValue: (c) => c.description ?? '', render: (c) => <span className={shared.cellMain}>{c.description ?? 'Untitled claim'}</span> },
    { key: 'lossDate', header: 'Loss date', sortValue: (c) => c.lossDate ?? '', render: (c) => formatDate(c.lossDate) },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (c) => c.grossLossMinor, render: (c) => <span className={shared.money}>{formatMoney(c.grossLossMinor, c.currency)}</span> },
    { key: 'outstanding', header: 'Outstanding', align: 'right', sortValue: (c) => c.outstandingMinor, render: (c) => <span className={shared.money}>{formatMoney(c.outstandingMinor, c.currency)}</span> },
    { key: 'status', header: 'Status', align: 'right', sortValue: (c) => c.status, render: (c) => <StatusPill status={c.status} metaColors={statusColors} /> },
  ];
  return (
    <Table
      columns={cols}
      rows={claims}
      loading={isLoading}
      rowKey={(c) => c.id}
      onRowClick={(c) => navigate(`/claims/${c.id}`)}
      empty={<EmptyState title="No claims" message="No losses have been notified against this treaty." icon={<ClipboardList size={16} />} />}
    />
  );
}

function StatementTab({ id, canPost }: { id: string; canPost: boolean }) {
  const { data, isLoading } = useStatement(id);
  const post = usePostToGl(id);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);

  const doPost = async () => {
    try {
      const res = await post.mutateAsync();
      toast.success(res.reconciled ? 'Posted to GL - reconciled ✓' : 'Posted to GL');
      setConfirm(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Posting failed');
      setConfirm(false);
    }
  };

  if (isLoading) return <PageLoader label="Loading statement…" />;
  if (!data) return <EmptyState title="No statement" message="No statement of account is available." />;

  const lineCols: Column<{ type: string; count: number; totalMinor: number }>[] = [
    { key: 'type', header: 'Line', render: (l) => titleCase(l.type) },
    { key: 'count', header: 'Count', align: 'right', render: (l) => l.count },
    { key: 'total', header: 'Total', align: 'right', render: (l) => <span className={shared.money}>{formatMoney(l.totalMinor, data.currency)}</span> },
  ];

  return (
    <div className={styles.stack}>
      <div className={styles.statementGrid}>
        <div className={styles.statementMetric}>
          <span className={styles.metricLabel}>Balance</span>
          <span className={styles.metricValue}>{formatMoney(data.balanceMinor, data.currency)}</span>
        </div>
        <div className={styles.statementMetric}>
          <span className={styles.metricLabel}>Events</span>
          <span className={styles.metricValue}>{data.eventCount}</span>
        </div>
        <div className={styles.statementMetric}>
          <span className={styles.metricLabel}>Posted</span>
          <span className={styles.metricValue}>{data.posted ? <Badge color="green">Posted</Badge> : <Badge color="slate">Unposted</Badge>}</span>
        </div>
        <div className={styles.statementMetric}>
          <span className={styles.metricLabel}>Reconciled</span>
          <span className={styles.metricValue}>
            {data.reconciled ? <span className={styles.recOk}>✓ Reconciled</span> : <span className={styles.recBad}>✗ Not reconciled</span>}
          </span>
        </div>
      </div>

      <Table columns={lineCols} rows={data.lines} rowKey={(l) => l.type} empty={<EmptyState title="No statement lines" />} skeletonRows={3} />

      <div className={styles.statementFooter}>
        <div className={shared.cellSub}>
          Control movement: <span className={shared.money}>{formatMoney(data.controlMovementMinor, data.currency)}</span>
        </div>
        {canPost ? (
          <Button variant="primary" onClick={() => setConfirm(true)} disabled={data.posted}>
            {data.posted ? 'Already posted' : 'Post to GL'}
          </Button>
        ) : (
          <span className={shared.cellSub} title="Requires accounting:post">Posting requires the accounting:post permission</span>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={doPost}
        loading={post.isPending}
        title="Post statement to the general ledger?"
        confirmLabel="Post to GL"
        message="This creates a GL journal from the current statement and attempts reconciliation. Material accounting action."
      />
    </div>
  );
}
