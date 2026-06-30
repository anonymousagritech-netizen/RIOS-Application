/**
 * Field-level security (brief §14). Lists the column-masking policies and shows
 * a live demonstration: the same party fetched through the FLS-enforced read,
 * with sensitive fields masked according to the signed-in user's permissions.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { TextField } from '../components/Form';
import { PageLoader, Spinner } from '../components/Feedback';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Policy { id: string; entityType: string; field: string; classification: string; requiredPermission: string; strategy: string; active: boolean }
interface PartyLite { id: string; legalName: string; shortName?: string | null }

export function FieldSecurityPage() {
  const { hasPermission } = useAuth();
  const policies = useQuery({ queryKey: ['fls-policies'], queryFn: () => api<{ policies: Policy[] }>('/api/fls/policies') });
  const [term, setTerm] = useState('Atlantic');
  const search = useQuery({
    queryKey: ['fls-party-search', term],
    queryFn: () => api<{ parties: PartyLite[] }>(`/api/parties${qs({ q: term })}`),
    enabled: term.trim().length >= 2,
  });
  const partyId = search.data?.parties[0]?.id;
  const masked = useQuery({
    queryKey: ['fls-party', partyId],
    queryFn: () => api<{ party: Record<string, unknown>; maskedFields: string[] }>(`/api/fls/parties/${partyId}`),
    enabled: !!partyId,
  });

  const cols: Column<Policy>[] = [
    { key: 'entity', header: 'Entity', render: (p) => <span className={shared.cellMain}>{titleCase(p.entityType)}</span> },
    { key: 'field', header: 'Field', render: (p) => <span className={shared.cellRef}>{p.field}</span> },
    { key: 'class', header: 'Classification', render: (p) => <Badge color="amber">{p.classification}</Badge> },
    { key: 'perm', header: 'Requires', render: (p) => <span className={shared.cellSub}>{p.requiredPermission}</span> },
    { key: 'strategy', header: 'Strategy', render: (p) => titleCase(p.strategy) },
    { key: 'active', header: 'Active', render: (p) => <Badge color={p.active ? 'green' : 'gray'}>{p.active ? 'Active' : 'Off'}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Field-level security" description="Column masking - sensitive fields are hidden within a visible row unless you hold the required permission." />

      <Card>
        <CardHeader title="Masking policies" subtitle="Complements row-level security (which hides whole rows)." />
        <div style={{ padding: 'var(--space-4)' }}>
          {policies.isLoading ? <PageLoader label="Loading policies…" /> : (
            <Table columns={cols} rows={policies.data?.policies} rowKey={(p) => p.id}
              empty={<EmptyState title="No policies" message="No field-level security policies defined." />} />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Live demonstration"
          subtitle="A party fetched through the FLS-enforced read, masked for your permissions."
          actions={<Badge color={hasPermission('pii:view') || hasPermission('admin:manage') ? 'green' : 'red'}>{hasPermission('pii:view') || hasPermission('admin:manage') ? 'You hold pii:view' : 'No pii:view'}</Badge>}
        />
        <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-4)', maxWidth: 640 }}>
          <TextField label="Find a party" value={term} onChange={setTerm} />
          {(search.isFetching || masked.isFetching) && <Spinner />}
          {masked.data && (
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              {Object.entries(masked.data.party).filter(([k]) => k !== 'id').map(([k, v]) => {
                const isMasked = masked.data!.maskedFields.includes(k);
                return (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', padding: 'var(--space-2) 0' }}>
                    <span className={shared.cellSub}>{titleCase(k)}{isMasked && <Badge color="red">masked</Badge>}</span>
                    <span className={shared.cellMain} style={{ fontFamily: typeof v === 'object' ? 'var(--font-mono)' : undefined }}>
                      {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '-')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
