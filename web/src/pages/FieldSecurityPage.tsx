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
import { KpiCard } from '../components/KpiCard';
import { PageLoader, Spinner } from '../components/Feedback';
import { formatNumber, titleCase } from '../lib/format';
import { ShieldCheck, EyeOff, KeyRound, ScanEye, Lock } from 'lucide-react';
import shared from './shared.module.css';
import styles from './FieldSecurityPage.module.css';

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

  const policyList = policies.data?.policies ?? [];
  const activeCount = policyList.filter((p) => p.active).length;
  const maskedNow = masked.data?.maskedFields.length ?? 0;
  const holdsPii = hasPermission('pii:view') || hasPermission('admin:manage');

  const cols: Column<Policy>[] = [
    { key: 'entity', header: 'Entity', render: (p) => <span className={shared.cellMain}>{titleCase(p.entityType)}</span> },
    { key: 'field', header: 'Field', render: (p) => <span className={shared.cellRef}>{p.field}</span> },
    { key: 'class', header: 'Classification', render: (p) => <Badge color="amber">{p.classification}</Badge> },
    { key: 'perm', header: 'Requires', render: (p) => <span className={shared.cellSub}>{p.requiredPermission}</span> },
    { key: 'strategy', header: 'Strategy', render: (p) => titleCase(p.strategy) },
    { key: 'active', header: 'Active', render: (p) => <Badge color={p.active ? 'green' : 'gray'}>{p.active ? 'Active' : 'Off'}</Badge> },
  ];

  return (
    <div className={styles.page}>
      <PageHeader
        title="Field-level security"
        description="Column masking - sensitive fields are hidden within a visible row unless you hold the required permission."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Field-level security' }]}
        actions={
          <Badge color={holdsPii ? 'green' : 'red'}>{holdsPii ? 'You hold pii:view' : 'No pii:view'}</Badge>
        }
      />

      <div className={shared.kpiGrid}>
        <KpiCard
          label="Policies"
          value={formatNumber(policyList.length)}
          hint="Column-masking rules defined"
          icon={<ShieldCheck size={20} />}
          accent="var(--primary)"
          loading={policies.isLoading}
        />
        <KpiCard
          label="Active policies"
          value={formatNumber(activeCount)}
          hint="Currently enforced"
          icon={<EyeOff size={20} />}
          accent="var(--accent-violet)"
          loading={policies.isLoading}
        />
        <KpiCard
          label="Fields masked for you"
          value={formatNumber(maskedNow)}
          hint="In the live demonstration"
          icon={<ScanEye size={20} />}
          accent="var(--accent-cyan)"
        />
        <KpiCard
          label="Your PII access"
          value={holdsPii ? 'Granted' : 'Restricted'}
          hint="Drives what you can unmask"
          icon={<KeyRound size={20} />}
          accent={holdsPii ? 'var(--accent-emerald)' : 'var(--accent-orange)'}
        />
      </div>

      <Card padded={false}>
        <div className={styles.cardBodyPad}>
          <CardHeader title="Masking policies" subtitle="Complements row-level security (which hides whole rows)." />
        </div>
        {policies.isLoading ? (
          <div className={styles.cardBodyPad}><PageLoader label="Loading policies…" /></div>
        ) : (
          <Table columns={cols} rows={policies.data?.policies} rowKey={(p) => p.id}
            empty={<EmptyState title="No policies" message="No field-level security policies defined." icon={<Lock size={16} />} />} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Live demonstration"
          subtitle="A party fetched through the FLS-enforced read, masked for your permissions."
          actions={<Badge color={holdsPii ? 'green' : 'red'}>{holdsPii ? 'You hold pii:view' : 'No pii:view'}</Badge>}
        />
        <div className={styles.demo}>
          <TextField label="Find a party" value={term} onChange={setTerm} />
          {(search.isFetching || masked.isFetching) && <Spinner />}
          {masked.data && (
            <div className={styles.fields}>
              {Object.entries(masked.data.party).filter(([k]) => k !== 'id').map(([k, v]) => {
                const isMasked = masked.data!.maskedFields.includes(k);
                return (
                  <div key={k} className={styles.fieldRow}>
                    <span className={styles.fieldKey}>
                      {titleCase(k)}
                      {isMasked && <Badge color="red">masked</Badge>}
                    </span>
                    <span className={`${styles.fieldVal} ${typeof v === 'object' ? styles.mono : ''}`}>
                      {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '-')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
