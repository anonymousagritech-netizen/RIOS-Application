import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useStatusColors } from '../lib/queries';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { DefinitionList, ErrorState, PageLoader } from '../components/Feedback';
import { formatMoney, formatDate, formatPercent, titleCase } from '../lib/format';
import { ClipboardList, DollarSign, Coins, ShieldCheck, Building2, CalendarDays } from 'lucide-react';
import shared from './shared.module.css';

interface RiskRow {
  id: string;
  reference: string | null;
  description: string | null;
  insuredName: string | null;
  lineOfBusiness: string | null;
  sumInsuredMinor: number | null;
  currency: string | null;
  inception: string | null;
  expiry: string | null;
  reinsurerPartyId: string | null;
  reinsurerName: string | null;
  validUntil: string | null;
  inspectedOn: string | null;
  details: Record<string, unknown> | null;
}
interface FinancialEventRow {
  id: string;
  eventType: string;
  direction: string;
  amountMinor: number;
  currency: string;
  bookedAt: string;
  narrative: string | null;
}
interface FacultativeDetail {
  id: string;
  reference: string;
  name: string;
  contractKind: string;
  basis: string;
  facType: string;
  lineOfBusiness: string | null;
  currency: string;
  status: string;
  cedentPartyId: string | null;
  cedentName: string | null;
  brokerPartyId: string | null;
  brokerName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  terms: Record<string, unknown>;
  risks: RiskRow[];
  financialEvents: FinancialEventRow[];
}

const FAC_TYPE_LABEL: Record<string, string> = {
  FAC_OBLIG: 'Fac-obligatory',
  FAC_FACULTATIVE: 'Fac-facultative',
};

function useFacultativeDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['facultative', 'detail', id],
    queryFn: () => api<FacultativeDetail>(`/api/facultative/${id}`),
    enabled: !!id,
  });
}

const TABS = [
  { id: 'details', label: 'Details' },
  { id: 'terms', label: 'Terms' },
  { id: 'documents', label: 'Documents' },
];

export function FacultativeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useFacultativeDetail(id);
  const statusColors = useStatusColors('contract_status');
  const [tab, setTab] = useState('details');

  if (isLoading) return <PageLoader label="Loading cession…" />;
  if (isError || !data) {
    return (
      <Card>
        <ErrorState
          title="Cession not found"
          message="It may have been removed or you lack access."
          action={<Button onClick={() => navigate('/facultative')}>Back to facultative</Button>}
        />
      </Card>
    );
  }

  const risk = data.risks[0];
  const facTypeLabel = FAC_TYPE_LABEL[data.facType] ?? titleCase(data.facType);
  const cededShare = typeof data.terms?.cededShare === 'number' ? (data.terms.cededShare as number) : null;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Facultative', to: '/facultative' }, { label: data.reference ?? data.name }]}
        title={data.name}
        description={
          <span>
            <span className={shared.cellRef}>{data.reference}</span>
            {' · '}
            {titleCase(data.basis)}
            {' · '}
            {facTypeLabel}
            {' · '}
            {data.currency}
            {data.cedentName ? ` · ${data.cedentName}` : ''}
          </span>
        }
        actions={<StatusPill status={data.status} metaColors={statusColors} />}
      />

      <div className={shared.kpiGrid}>
        <KpiCard label="Arrangement" value={facTypeLabel} icon={<ShieldCheck size={18} />} accent="var(--primary)" hint={titleCase(data.basis)} />
        <KpiCard
          label="Sum insured"
          value={risk?.sumInsuredMinor != null ? formatMoney(risk.sumInsuredMinor, data.currency) : '-'}
          icon={<Coins size={18} />}
          accent="var(--accent-violet)"
          hint={risk?.insuredName ?? 'Insured t.b.c.'}
        />
        <KpiCard
          label="Ceded share"
          value={cededShare != null ? formatPercent(cededShare) : '-'}
          icon={<DollarSign size={18} />}
          accent="var(--accent-emerald)"
          hint={data.basis === 'PROPORTIONAL' ? 'Proportional cession' : 'Non-proportional'}
        />
        <KpiCard
          label="Reinsurer"
          value={risk?.reinsurerName ?? '-'}
          icon={<Building2 size={18} />}
          accent="var(--accent-cyan)"
          hint={data.brokerName ? `Broker: ${data.brokerName}` : 'Line taken'}
        />
      </div>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
        </div>
        <div style={{ padding: 'var(--space-4)' }}>
          {tab === 'details' && <DetailsTab data={data} risk={risk} />}
          {tab === 'terms' && <TermsTab terms={data.terms} />}
          {tab === 'documents' &&
            (risk ? (
              <DocumentsPanel entityType="risk" entityId={risk.id} />
            ) : (
              <EmptyState title="No risk to attach to" message="This cession has no underlying risk record." />
            ))}
        </div>
      </Card>
    </>
  );
}

function DetailsTab({ data, risk }: { data: FacultativeDetail; risk: RiskRow | undefined }) {
  const items: { term: string; value: React.ReactNode }[] = [
    { term: 'Insured name', value: risk?.insuredName ?? '-' },
    { term: 'Line of business', value: titleCase(risk?.lineOfBusiness ?? data.lineOfBusiness) || '-' },
    { term: 'Sum insured', value: risk?.sumInsuredMinor != null ? formatMoney(risk.sumInsuredMinor, data.currency) : '-' },
    { term: 'Reinsurer', value: risk?.reinsurerName ?? '-' },
    { term: 'Cedent / reinsured', value: data.cedentName ?? '-' },
    { term: 'Broker', value: data.brokerName ?? '-' },
    { term: 'Inception', value: formatDate(risk?.inception) },
    { term: 'Expiry', value: formatDate(risk?.expiry) },
    { term: 'Quote valid until', value: formatDate(risk?.validUntil) },
    { term: 'Last inspected', value: formatDate(risk?.inspectedOn) },
  ];

  // Surface the metadata-driven adaptive-form (LOB) detail bag as its own rows.
  const detailEntries = Object.entries(risk?.details ?? {}).filter(([k]) => k !== 'classOfBusiness');
  const classOfBusiness = (risk?.details?.classOfBusiness as string | undefined) ?? null;
  if (classOfBusiness) items.push({ term: 'Class of business', value: titleCase(classOfBusiness) });
  for (const [k, v] of detailEntries) {
    items.push({ term: titleCase(k), value: v == null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v) });
  }

  const eventCols: Column<FinancialEventRow>[] = [
    { key: 'bookedAt', header: 'Booked', sortValue: (e) => e.bookedAt, render: (e) => formatDate(e.bookedAt) },
    { key: 'eventType', header: 'Type', render: (e) => <Badge color="indigo">{titleCase(e.eventType)}</Badge> },
    { key: 'narrative', header: 'Narrative', render: (e) => e.narrative ?? '-' },
    { key: 'direction', header: 'Dr/Cr', align: 'center', render: (e) => <Badge color={e.direction === 'DR' ? 'blue' : 'teal'}>{e.direction}</Badge> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (e) => e.amountMinor, render: (e) => <span className={shared.money}>{formatMoney(e.amountMinor, e.currency || data.currency)}</span> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <section>
        <CardHeader title="Risk & slip" subtitle="The single ceded risk and its facultative slip attributes." />
        <DefinitionList items={items} />
      </section>
      <section>
        <CardHeader title="Financial events" subtitle="Ceded premium and other booked events for this cession." />
        <Table
          columns={eventCols}
          rows={data.financialEvents}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No financial events" message="No premium was booked on this cession." icon={<DollarSign size={16} />} />}
        />
      </section>
    </div>
  );
}

function TermsTab({ terms }: { terms: Record<string, unknown> }) {
  const entries = Object.entries(terms ?? {});
  if (!entries.length) {
    return <EmptyState title="No terms recorded" message="Commercial terms for this cession have not been captured." icon={<ClipboardList size={16} />} />;
  }
  return (
    <DefinitionList
      items={entries.map(([k, v]) => ({
        term: k === 'facType' ? 'Fac type' : titleCase(k),
        value:
          k === 'facType'
            ? FAC_TYPE_LABEL[String(v)] ?? titleCase(String(v))
            : v == null
              ? '-'
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v),
      }))}
    />
  );
}
