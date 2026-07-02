import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { useParty, useTreaties, useStatusColors } from '../lib/queries';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Badge, StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Table, type Column, EmptyState } from '../components/Table';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { DefinitionList, ErrorState, PageLoader, SectionLabel } from '../components/Feedback';
import { formatDate, titleCase } from '../lib/format';
import type { TreatyListItem } from '../lib/types';
import shared from './shared.module.css';
import styles from './PartyDetailPage.module.css';

// A treaty in this party's book, tagged with the party's role on it, so the
// hub can show cedent and broker participations in one list.
type BookRow = TreatyListItem & { partyRole: string };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export function PartyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: party, isLoading, isError } = useParty(id);
  const asCedent = useTreaties({ cedentId: id });
  const asBroker = useTreaties({ brokerId: id });
  const treatyColors = useStatusColors('contract_status');

  // Merge the party's cedent and broker participations into one book, tagging
  // each with its role; a treaty where the party is both is listed once.
  const book = useMemo<BookRow[]>(() => {
    const byId = new Map<string, BookRow>();
    for (const t of asCedent.data?.treaties ?? []) byId.set(t.id, { ...t, partyRole: 'Cedent' });
    for (const t of asBroker.data?.treaties ?? []) {
      const existing = byId.get(t.id);
      if (existing) existing.partyRole = 'Cedent · Broker';
      else byId.set(t.id, { ...t, partyRole: 'Broker' });
    }
    return [...byId.values()];
  }, [asCedent.data, asBroker.data]);
  const bookLoading = asCedent.isLoading || asBroker.isLoading;

  if (isLoading) return <PageLoader label="Loading party…" />;
  if (isError || !party) {
    return <Card><ErrorState title="Party not found" action={<Button onClick={() => navigate('/parties')}>Back to parties</Button>} /></Card>;
  }

  const identifiers = party.identifiers ?? [];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Parties', to: '/parties' }, { label: party.legalName }]}
        title={party.legalName}
        description="Counterparty profile, roles and external identifiers."
        actions={<Badge color={party.status === 'ACTIVE' ? 'green' : 'slate'}>{titleCase(party.status)}</Badge>}
      />

      <div className={styles.profile}>
        <span className={styles.avatar} aria-hidden>{initials(party.legalName)}</span>
        <div className={styles.identity}>
          <h2 className={styles.name}>{party.legalName}</h2>
          <div className={styles.meta}>
            <span className={shared.cellRef}>{party.reference ?? '-'}</span>
            <span className={styles.dot} aria-hidden />
            <span>{titleCase(party.kind)}</span>
            {party.country && (
              <>
                <span className={styles.dot} aria-hidden />
                <span>{party.country}</span>
              </>
            )}
          </div>
          {party.roles?.length ? (
            <div className={styles.chips}>
              {party.roles.map((r) => <Badge key={r} color="indigo">{titleCase(r)}</Badge>)}
            </div>
          ) : null}
        </div>
        <div className={styles.statusSlot}>
          <Badge color={party.status === 'ACTIVE' ? 'green' : 'slate'} variant="outline">{titleCase(party.status)}</Badge>
        </div>
      </div>

      <div className={styles.cols}>
        <Card>
          <CardHeader title="Overview" subtitle="Core registration details for this counterparty." />
          <DefinitionList
            items={[
              { term: 'Legal name', value: party.legalName },
              { term: 'Short name', value: party.shortName ?? '-' },
              { term: 'Kind', value: titleCase(party.kind) },
              { term: 'Country', value: party.country ?? '-' },
              { term: 'Status', value: <Badge color={party.status === 'ACTIVE' ? 'green' : 'slate'}>{titleCase(party.status)}</Badge> },
            ]}
          />
          <div style={{ marginTop: 'var(--space-5)' }}>
            <SectionLabel>Identifiers</SectionLabel>
            {identifiers.length === 0 ? (
              <p className={shared.cellSub}>No external identifiers recorded.</p>
            ) : (
              <DefinitionList
                items={identifiers.map((idn) => ({
                  term: titleCase(String(idn.scheme ?? 'Identifier')),
                  value: <span className={shared.cellRef}>{String(idn.value ?? '-')}</span>,
                }))}
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Roles" subtitle="How this party participates" />
          {party.roles?.length ? (
            <div className={shared.checkGroup}>
              {party.roles.map((r) => <Badge key={r} color="indigo">{titleCase(r)}</Badge>)}
            </div>
          ) : (
            <p className={shared.cellSub}>No roles assigned.</p>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <Card padded={false}>
          <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
            <div>
              <SectionLabel>Contracts</SectionLabel>
              <p className={shared.cellSub}>Treaties where this party is the cedent or placing broker.</p>
            </div>
            <div className={shared.spacer} />
            <span className={shared.cellSub}>{book.length} contract{book.length === 1 ? '' : 's'}</span>
          </div>
          <Table
            columns={bookColumns(treatyColors)}
            rows={book}
            loading={bookLoading}
            rowKey={(t) => t.id}
            onRowClick={(t) => navigate(`/treaties/${t.id}`)}
            empty={<EmptyState title="No contracts" message="This party is not a counterparty on any treaty yet." icon={<FileText size={16} />} />}
          />
        </Card>
      </div>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <DocumentsPanel entityType="party" entityId={id!} />
      </div>
    </>
  );
}

function bookColumns(statusColors: Record<string, string>): Column<BookRow>[] {
  return [
    { key: 'reference', header: 'Reference', sortValue: (t) => t.reference, render: (t) => <span className={shared.cellRef}>{t.reference}</span> },
    {
      key: 'name',
      header: 'Treaty',
      sortValue: (t) => t.name,
      render: (t) => (
        <div>
          <div className={shared.cellMain}>{t.name}</div>
          <div className={shared.cellSub}>{[t.contractKind, t.lineOfBusiness].filter(Boolean).map(titleCase).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'partyRole', header: 'Role', sortValue: (t) => t.partyRole, render: (t) => <Badge color="indigo" variant="outline">{t.partyRole}</Badge> },
    { key: 'period', header: 'Period', sortValue: (t) => t.periodStart ?? '', render: (t) => t.periodStart ? `${formatDate(t.periodStart)} – ${formatDate(t.periodEnd)}` : '—' },
    { key: 'status', header: 'Status', align: 'right', sortValue: (t) => t.status, render: (t) => <StatusPill status={t.status} metaColors={statusColors} /> },
  ];
}
