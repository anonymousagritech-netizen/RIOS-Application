import { useParams, useNavigate } from 'react-router-dom';
import { useParty } from '../lib/queries';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { DefinitionList, ErrorState, PageLoader, SectionLabel } from '../components/Feedback';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './PartyDetailPage.module.css';

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
    </>
  );
}
