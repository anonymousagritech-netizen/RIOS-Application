import { useNavigate } from 'react-router-dom';
import { useTreaties, useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { formatDate, titleCase } from '../lib/format';
import type { TreatyListItem } from '../lib/types';
import shared from './shared.module.css';

/**
 * Accounting workspace: surfaces bound/active treaties whose statements can be
 * reconciled and posted to the GL. Drilling in opens the treaty's Statement tab.
 */
export function AccountingPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, isLoading } = useTreaties({});
  const statusColors = useStatusColors('contract_status');

  const postable = (data?.treaties ?? []).filter((t) =>
    ['BOUND', 'ACTIVE', 'EXPIRING', 'RUNOFF', 'COMMUTED'].includes(t.status),
  );

  const columns: Column<TreatyListItem>[] = [
    { key: 'reference', header: 'Reference', sortValue: (t) => t.reference ?? '', render: (t) => <span className={shared.cellRef}>{t.reference}</span> },
    { key: 'name', header: 'Treaty', sortValue: (t) => t.name, render: (t) => <span className={shared.cellMain}>{t.name}</span> },
    { key: 'cedent', header: 'Cedent', render: (t) => t.cedentName ?? '—' },
    { key: 'currency', header: 'CCY', render: (t) => t.currency },
    { key: 'period', header: 'Inception', sortValue: (t) => t.periodStart ?? '', render: (t) => formatDate(t.periodStart) },
    { key: 'status', header: 'Status', align: 'right', sortValue: (t) => t.status, render: (t) => <StatusPill status={t.status} metaColors={statusColors} /> },
  ];

  return (
    <>
      <PageHeader
        title="Accounting"
        description="Statements of account and general-ledger posting for bound and active treaties."
        actions={
          hasPermission('accounting:post')
            ? <Badge color="green">accounting:post granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader
            title="Treaties with statements"
            subtitle="Open a treaty to view its statement of account and post to the GL."
          />
        </div>
        <Table
          columns={columns}
          rows={postable}
          loading={isLoading}
          rowKey={(t) => t.id}
          onRowClick={(t) => navigate(`/treaties/${t.id}`)}
          empty={<EmptyState title="Nothing to post" message="Bind a treaty to generate a statement of account." icon="$" />}
        />
      </Card>
    </>
  );
}
