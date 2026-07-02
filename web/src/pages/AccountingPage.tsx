import { Banknote, BookOpen, Building2, Coins, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTreaties, useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { AiActionPanel } from '../components/AiActionPanel';
import { formatDate, formatNumber } from '../lib/format';
import type { TreatyListItem } from '../lib/types';
import shared from './shared.module.css';
import styles from './AccountingPage.module.css';

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
  const activeCount = postable.filter((t) => ['BOUND', 'ACTIVE'].includes(t.status)).length;
  const cedentCount = new Set(postable.map((t) => t.cedentName).filter(Boolean)).size;
  const currencyCount = new Set(postable.map((t) => t.currency)).size;

  const columns: Column<TreatyListItem>[] = [
    { key: 'reference', header: 'Reference', sortValue: (t) => t.reference ?? '', render: (t) => <span className={shared.cellRef}>{t.reference}</span> },
    { key: 'name', header: 'Treaty', sortValue: (t) => t.name, render: (t) => <span className={shared.cellMain}>{t.name}</span> },
    { key: 'cedent', header: 'Cedent', sortValue: (t) => t.cedentName ?? '', render: (t) => t.cedentName ?? <span className={shared.cellSub}>-</span> },
    { key: 'currency', header: 'CCY', align: 'right', render: (t) => <span className={shared.money}>{t.currency}</span> },
    { key: 'period', header: 'Inception', sortValue: (t) => t.periodStart ?? '', render: (t) => formatDate(t.periodStart) },
    { key: 'status', header: 'Status', align: 'right', sortValue: (t) => t.status, render: (t) => <StatusPill status={t.status} metaColors={statusColors} /> },
  ];

  return (
    <>
      <PageHeader
        title="Accounting"
        description="Statements of account and general-ledger posting for bound and active treaties."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Accounting' }]}
        actions={
          hasPermission('accounting:post')
            ? <Badge color="green">accounting:post granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <div className={styles.page}>
        <div className={styles.kpis}>
          <KpiCard label="Postable treaties" value={formatNumber(postable.length)} hint="With a statement to reconcile" icon={<BookOpen size={20} />} accent="var(--primary)" loading={isLoading} />
          <KpiCard label="Bound & active" value={formatNumber(activeCount)} hint="Currently in force" icon={<Banknote size={20} />} accent="var(--accent-emerald)" loading={isLoading} />
          <KpiCard label="Cedents" value={formatNumber(cedentCount)} hint="Distinct counterparties" icon={<Building2 size={20} />} accent="var(--accent-violet)" loading={isLoading} />
          <KpiCard label="Currencies" value={formatNumber(currencyCount)} hint="Settlement currencies in play" icon={<Coins size={20} />} accent="var(--accent-cyan)" loading={isLoading} />
        </div>

        <AiActionPanel
          title="AI journal & balance validation"
          buttonLabel="AI insight"
          note="Uses the finance insight domain (technical result & combined ratio) as a book-level balance sanity check."
          insightDomain="finance"
          context={{
            postableTreaties: postable.length,
            boundAndActive: activeCount,
            cedents: cedentCount,
            currencies: currencyCount,
          }}
        />

        <Card padded={false}>
          <div className={styles.cardHead}>
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
            empty={<EmptyState title="Nothing to post" message="Bind a treaty to generate a statement of account." icon={<FileText size={28} />} />}
          />
        </Card>
      </div>
    </>
  );
}
