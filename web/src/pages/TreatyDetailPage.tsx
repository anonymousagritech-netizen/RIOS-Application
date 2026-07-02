import { useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
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
import { DocumentsPanel } from '../components/DocumentsPanel';
import { ApprovalPanel } from '../components/ApprovalPanel';
import { DefinitionList, SectionLabel, ErrorState, PageLoader } from '../components/Feedback';
import { legalTransitions } from '../lib/status';
import { formatMoney, formatDate, formatPercent, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { FinancialEventDTO } from '@rios/shared';
import type { TreatyDetail, CapacityBreachZone } from '../lib/types';
import { ClipboardList, DollarSign, Coins, Layers, Users, CalendarDays } from 'lucide-react';
import shared from './shared.module.css';
import styles from './TreatyDetailPage.module.css';

const TABS = [
  { id: 'structure', label: 'Structure' },
  { id: 'key-terms', label: 'Key terms' },
  { id: 'approval', label: 'Approval' },
  { id: 'financials', label: 'Financial events' },
  { id: 'statement', label: 'Statement' },
  { id: 'claims', label: 'Claims' },
  { id: 'documents', label: 'Documents' },
];

export function TreatyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { hasPermission } = useAuth();
  const toast = useToast();

  const { data: treaty, isLoading, isError } = useTreaty(id);
  const statusColors = useStatusColors('contract_status');
  const transition = useTransitionTreaty(id!);

  // Arriving from another surface (e.g. the Statements list) may request an
  // initial tab via ?tab=; fall back to Key terms for unknown/missing values.
  const requestedTab = searchParams.get('tab');
  const [tab, setTab] = useState(TABS.some((t) => t.id === requestedTab) ? requestedTab! : 'key-terms');
  const [confirmTo, setConfirmTo] = useState<string | null>(null);


  // Capacity alert state (P3-D). capacityError is set when binding returns
  // 409 CAPACITY_BREACH (hard limit exceeded - bind was NOT committed).
  // softLimitWarning is set when binding succeeds but the server reports that
  // one or more zones are above 80 % utilisation (SOFT threshold).
  const [capacityError, setCapacityError] = useState<CapacityBreachZone[] | null>(null);
  const [softLimitWarning, setSoftLimitWarning] = useState<{ zoneCode: string; usedPercent: number } | null>(null);

  if (isLoading) return <PageLoader label="Loading treaty…" />;
  if (isError || !treaty) {
    return <Card><ErrorState title="Treaty not found" message="It may have been removed or you lack access." action={<Button onClick={() => navigate('/treaties')}>Back to treaties</Button>} /></Card>;
  }

  const nextStates = legalTransitions(treaty.status);
  const currency = treaty.currency;

  const runTransition = async (to: string) => {

    // Clear stale capacity alerts each time a transition is attempted.
    if (to === 'BOUND') {
      setCapacityError(null);
      setSoftLimitWarning(null);
    }
    try {
      const res = await transition.mutateAsync(to);
      toast.success(`Treaty moved to ${titleCase(res.status)}`);
      if (res.financialEvents?.length) {
        toast.success(`${res.financialEvents.length} financial event(s) booked`);
      }
      if (to === 'BOUND' && res.warnings?.length) {
        const mostLoaded = res.warnings.reduce((worst, z) =>
          z.limitMinor > 0 && (z.currentMinor + z.addedMinor) / z.limitMinor >
          (worst.limitMinor > 0 ? (worst.currentMinor + worst.addedMinor) / worst.limitMinor : 0)
            ? z : worst,
          res.warnings[0]!,
        );
        const usedPercent = mostLoaded.limitMinor > 0
          ? Math.round(((mostLoaded.currentMinor + mostLoaded.addedMinor) / mostLoaded.limitMinor) * 100)
          : 0;
        if (usedPercent > 80) {
          setSoftLimitWarning({ zoneCode: mostLoaded.zoneCode, usedPercent });
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as { code?: string; zones?: CapacityBreachZone[] } | null | undefined;
        if (body?.code === 'CAPACITY_BREACH' && Array.isArray(body.zones) && body.zones.length > 0) {
          setCapacityError(body.zones);
          setConfirmTo(null);
          return;
        }
      }
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
            {treaty.brokerName ? (
              <>
                <span className={styles.dot}>via</span>
                {treaty.brokerPartyId
                  ? <Link className={styles.cedentLink} to={`/parties/${treaty.brokerPartyId}`}>{treaty.brokerName}</Link>
                  : treaty.brokerName}
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


      {/* Hard-limit capacity breach (P3-D): binding was blocked, show why. */}
      {capacityError && (
        <div className={styles.capacityBreachAlert}>
          <strong>Capacity Limit Breached</strong>
          <p>This treaty cannot be bound — it would exceed the following accumulation limits:</p>
          <ul>
            {capacityError.map((z) => (
              <li key={z.zoneCode}>
                <strong>{z.zoneCode}</strong>: Limit {formatMoney(z.limitMinor, currency)} |
                Current {formatMoney(z.currentMinor, currency)} |
                Adding {formatMoney(z.addedMinor, currency)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Soft-limit capacity warning (P3-D): bind succeeded but zone is >80 % used. */}
      {softLimitWarning && (
        <div className={styles.capacitySoftWarning}>
          <strong>Capacity Warning</strong>
          <p>
            Binding this treaty uses {softLimitWarning.usedPercent}% of available capacity
            for zone {softLimitWarning.zoneCode}.
          </p>
        </div>
      )}

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
          {tab === 'key-terms' && <KeyTermsTab treaty={treaty} />}
          {tab === 'approval' && <ApprovalPanel entityType="treaty" entityId={id!} status={treaty.status} statusColors={statusColors} />}
          {tab === 'financials' && <FinancialsTab id={id!} currency={currency} />}
          {tab === 'statement' && <StatementTab id={id!} canPost={hasPermission('accounting:post')} />}
          {tab === 'claims' && <ClaimsTab id={id!} />}
          {tab === 'documents' && <DocumentsPanel entityType="contract" entityId={id!} />}
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

function StructureTab({ treaty, currency }: { treaty: TreatyDetail; currency: string }) {
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
        <CardHeader
          title="Layers"
          subtitle={`${layers.length} layer(s) · ${currency}`}
          actions={<Link className={styles.cedentLink} to="/pricing">Price this treaty →</Link>}
        />
        <Table columns={layerCols} rows={layers} rowKey={(l) => l.id} empty={<EmptyState title="No layers" message="This treaty has no structured layers." />} skeletonRows={3} />
      </section>
      <section>
        <CardHeader title="Participations" subtitle={`${participations.length} reinsurer(s) - written vs signed lines`} />
        <Table columns={partCols} rows={participations} rowKey={(p) => p.id} empty={<EmptyState title="No participations" message="No reinsurers placed on this treaty yet." />} skeletonRows={3} />
      </section>
    </div>
  );
}

/** Format a major-unit number with currency label for display. Terms store money in major units. */
function fmtMajor(v: unknown, currency: string): string {
  if (v == null || typeof v !== 'number') return '-';
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v) + ' ' + currency;
}

function fmtPct(v: unknown): string {
  if (v == null || typeof v !== 'number') return '-';
  return `${v}%`;
}

/**
 * Key terms tab: structured view of the treaty's commercial and structural terms.
 * Shows contract-level fields (basis, direction, period, LOB) combined with the
 * commercial terms from the term_set JSON. Money figures are in major units.
 */
function KeyTermsTab({ treaty }: { treaty: TreatyDetail }) {
  const terms = treaty.terms ?? {};
  const isProportional = treaty.basis === 'PROPORTIONAL';
  const currency = treaty.currency;

  const contractItems = [
    { term: 'Basis', value: titleCase(treaty.basis) || '-' },
    (treaty.proportionalType || treaty.npType)
      ? { term: 'Structure type', value: titleCase(treaty.proportionalType ?? treaty.npType ?? '') }
      : null,
    { term: 'Direction', value: titleCase(treaty.direction) || '-' },
    { term: 'Line of business', value: titleCase(treaty.lineOfBusiness) || '-' },
    { term: 'Currency', value: currency },
    { term: 'Inception', value: formatDate(treaty.periodStart) },
    { term: 'Expiry', value: formatDate(treaty.periodEnd) },
    terms.periodBasis != null
      ? { term: 'Period basis', value: titleCase(String(terms.periodBasis)) }
      : null,
    terms.territory != null
      ? { term: 'Territory', value: String(terms.territory) }
      : null,
    terms.underwritingYear != null
      ? { term: 'Underwriting year', value: String(terms.underwritingYear) }
      : null,
  ].filter((x): x is { term: string; value: string } => x != null);

  const structuralItems: { term: string; value: string }[] = [
    // Proportional terms
    ...(isProportional ? [
      terms.cessionPct != null ? { term: 'Cession %', value: fmtPct(terms.cessionPct) } : null,
      terms.retentionLines != null ? { term: 'Retention (lines)', value: String(terms.retentionLines) } : null,
      terms.maxCession != null ? { term: 'Max cession (lines)', value: String(terms.maxCession) } : null,
    ] : [
      // Non-proportional terms
      terms.attachment != null ? { term: 'Attachment', value: fmtMajor(terms.attachment, currency) } : null,
      terms.limit != null ? { term: 'Limit', value: fmtMajor(terms.limit, currency) } : null,
      terms.aggregateDeductible != null ? { term: 'Aggregate deductible', value: fmtMajor(terms.aggregateDeductible, currency) } : null,
      terms.reinstatements != null ? { term: 'Reinstatements', value: String(terms.reinstatements) } : null,
      terms.rateOnLine != null ? { term: 'Rate on line %', value: fmtPct(terms.rateOnLine) } : null,
      terms.hoursClause != null ? { term: 'Hours clause', value: `${terms.hoursClause} hrs` } : null,
      terms.eventLimit != null ? { term: 'Event limit', value: fmtMajor(terms.eventLimit, currency) } : null,
    ]),
  ].filter((x): x is { term: string; value: string } => x != null);

  const commissionItems = [
    ...(isProportional ? [
      terms.cedingCommissionPct != null ? { term: 'Ceding commission %', value: fmtPct(terms.cedingCommissionPct) } : null,
      terms.profitCommissionPct != null ? { term: 'Profit commission %', value: fmtPct(terms.profitCommissionPct) } : null,
      terms.overridePct != null ? { term: 'Overrider %', value: fmtPct(terms.overridePct) } : null,
      terms.commissionMinPct != null ? { term: 'Commission min %', value: fmtPct(terms.commissionMinPct) } : null,
      terms.commissionMaxPct != null ? { term: 'Commission max %', value: fmtPct(terms.commissionMaxPct) } : null,
    ] : []),
    terms.brokeragePct != null ? { term: 'Brokerage %', value: fmtPct(terms.brokeragePct) } : null,
    terms.writtenSharePct != null ? { term: 'Our written share %', value: fmtPct(terms.writtenSharePct) } : null,
    terms.orderPct != null ? { term: 'Order %', value: fmtPct(terms.orderPct) } : null,
  ].filter((x): x is { term: string; value: string } => x != null);

  const premiumItems = [
    terms.estimatedPremiumIncome != null ? { term: 'Est. premium income (EPI)', value: fmtMajor(terms.estimatedPremiumIncome, currency) } : null,
    terms.minimumAndDepositPremium != null ? { term: 'Min. & deposit premium (MDP)', value: fmtMajor(terms.minimumAndDepositPremium, currency) } : null,
    terms.depositPremium != null ? { term: 'Deposit premium', value: fmtMajor(terms.depositPremium, currency) } : null,
  ].filter((x): x is { term: string; value: string } => x != null);

  const accountingItems = [
    terms.statementFrequency != null ? { term: 'Statement frequency', value: titleCase(String(terms.statementFrequency)) } : null,
    terms.accountingBasis != null ? { term: 'Accounting basis', value: titleCase(String(terms.accountingBasis)) } : null,
    terms.settlementCurrency != null ? { term: 'Settlement currency', value: String(terms.settlementCurrency) } : null,
    terms.cashCallThreshold != null ? { term: 'Cash call threshold', value: fmtMajor(terms.cashCallThreshold, currency) } : null,
  ].filter((x): x is { term: string; value: string } => x != null);

  const hasAny = contractItems.length > 0 || structuralItems.length > 0 || commissionItems.length > 0 || premiumItems.length > 0 || accountingItems.length > 0;

  if (!hasAny) {
    return <EmptyState title="No terms recorded" message="Commercial terms for this treaty have not been captured." icon={<ClipboardList size={16} />} />;
  }

  return (
    <div className={styles.stack}>
      {contractItems.length > 0 && (
        <section>
          <SectionLabel>Contract</SectionLabel>
          <DefinitionList items={contractItems} />
        </section>
      )}
      {structuralItems.length > 0 && (
        <section>
          <SectionLabel>{isProportional ? 'Proportional structure' : 'Excess-of-loss structure'}</SectionLabel>
          <DefinitionList items={structuralItems} />
        </section>
      )}
      {commissionItems.length > 0 && (
        <section>
          <SectionLabel>Commission &amp; brokerage</SectionLabel>
          <DefinitionList items={commissionItems} />
        </section>
      )}
      {premiumItems.length > 0 && (
        <section>
          <SectionLabel>Premium</SectionLabel>
          <DefinitionList items={premiumItems} />
        </section>
      )}
      {accountingItems.length > 0 && (
        <section>
          <SectionLabel>Accounting</SectionLabel>
          <DefinitionList items={accountingItems} />
        </section>
      )}
    </div>
  );
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
