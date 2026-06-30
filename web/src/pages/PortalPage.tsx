/**
 * External counterparty portal (brief §9.15).
 *
 * A single screen that renders the permission-scoped projection the signed-in
 * user is entitled to: their broker / cedent / retrocessionaire view of the
 * core data. Admins (admin:manage) can impersonate any party + portal type via
 * the selector to support and verify a counterparty's view.
 */

import { useMemo, useState } from 'react';
import { Layers, CheckCircle2, AlertTriangle, Wallet, Receipt, Clock } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useStatusColors } from '../lib/queries';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Tabs } from '../components/Tabs';
import { FormField, Select } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatNumber, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './PortalPage.module.css';

interface Grant { id: string; portalType: string; partyId: string; partyName: string; scopes: string[] }
interface PortalMeta { partyId: string; partyName: string; portalType: string }
interface Overview {
  portal: PortalMeta;
  summary: {
    contracts: number; activeContracts: number; claims: number;
    outstandingMinor: number; statementBalanceMinor: number; openStatements: number;
  };
}
interface Contract {
  id: string; reference: string; name: string; contractKind: string; basis: string;
  lineOfBusiness?: string | null; currency: string; status: string;
  periodStart?: string | null; periodEnd?: string | null;
  cedentName?: string | null; brokerName?: string | null;
}
interface Statement {
  id: string; reference?: string | null; currency: string; balanceMinor: number;
  status: string; periodStart?: string | null; periodEnd?: string | null;
  issuedAt?: string | null; settledAt?: string | null;
  contractReference?: string | null; contractName?: string | null;
}
interface Claim {
  id: string; reference?: string | null; description?: string | null; currency: string;
  status: string; lossDate?: string | null; notifiedDate?: string | null;
  grossLossMinor: number; outstandingMinor: number; paidMinor: number; recoveredMinor: number;
  contractReference?: string | null; contractName?: string | null;
}

const PORTAL_TYPES = ['broker', 'cedent', 'retrocessionaire', 'coverholder', 'client'];

export function PortalPage() {
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('admin:manage');
  const [tab, setTab] = useState('contracts');

  // Admin impersonation selector (partyId + portalType), empty for portal users.
  const [adminPartyId, setAdminPartyId] = useState('');
  const [adminType, setAdminType] = useState('broker');

  const grants = useQuery({
    queryKey: ['portal-grants'],
    queryFn: () => api<{ grants: Grant[] }>('/api/portal/grants'),
  });

  const adminParties = useQuery({
    queryKey: ['portal-admin-parties'],
    queryFn: () => api<{ parties: { id: string; legalName: string; shortName?: string | null }[] }>('/api/parties'),
    enabled: isAdmin,
  });

  // The query string that scopes every read: admins pass party+type explicitly.
  const scope = useMemo(
    () => (isAdmin && adminPartyId ? qs({ partyId: adminPartyId, portalType: adminType }) : ''),
    [isAdmin, adminPartyId, adminType],
  );
  // A portal user with a single grant needs no params; we just rely on the grant.
  const ready = !isAdmin || !!adminPartyId;

  const overview = useQuery({
    queryKey: ['portal-overview', scope],
    queryFn: () => api<Overview>(`/api/portal/overview${scope}`),
    enabled: ready,
  });
  const contracts = useQuery({
    queryKey: ['portal-contracts', scope],
    queryFn: () => api<{ contracts: Contract[] }>(`/api/portal/contracts${scope}`),
    enabled: ready,
  });
  const statements = useQuery({
    queryKey: ['portal-statements', scope],
    queryFn: () => api<{ statements: Statement[] }>(`/api/portal/statements${scope}`),
    enabled: ready,
  });
  const claims = useQuery({
    queryKey: ['portal-claims', scope],
    queryFn: () => api<{ claims: Claim[] }>(`/api/portal/claims${scope}`),
    enabled: ready,
  });

  const contractColors = useStatusColors('contract_status');
  const statementColors = useStatusColors('statement_status');
  const claimColors = useStatusColors('claim_status');

  const meta = overview.data?.portal;
  const s = overview.data?.summary;

  const contractCols: Column<Contract>[] = [
    { key: 'reference', header: 'Reference', render: (r) => <span className={shared.cellRef}>{r.reference}</span> },
    { key: 'name', header: 'Contract', render: (r) => <span className={shared.cellMain}>{r.name}</span> },
    { key: 'kind', header: 'Kind', render: (r) => titleCase(r.contractKind) },
    { key: 'lob', header: 'Line of business', render: (r) => titleCase(r.lineOfBusiness) || '-' },
    { key: 'period', header: 'Period', render: (r) => r.periodStart ? `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}` : '-' },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} metaColors={contractColors} /> },
  ];
  const statementCols: Column<Statement>[] = [
    { key: 'reference', header: 'Reference', render: (r) => <span className={shared.cellRef}>{r.reference ?? '-'}</span> },
    { key: 'contract', header: 'Contract', render: (r) => <span className={shared.cellSub}>{r.contractName ?? r.contractReference ?? '-'}</span> },
    { key: 'period', header: 'Period', render: (r) => r.periodEnd ? formatDate(r.periodEnd) : '-' },
    { key: 'balance', header: 'Balance', align: 'right', sortValue: (r) => r.balanceMinor, render: (r) => formatMoney(r.balanceMinor, r.currency) },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} metaColors={statementColors} /> },
  ];
  const claimCols: Column<Claim>[] = [
    { key: 'reference', header: 'Reference', render: (r) => <span className={shared.cellRef}>{r.reference ?? '-'}</span> },
    { key: 'contract', header: 'Contract', render: (r) => <span className={shared.cellSub}>{r.contractName ?? r.contractReference ?? '-'}</span> },
    { key: 'notified', header: 'Notified', render: (r) => formatDate(r.notifiedDate) },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (r) => r.grossLossMinor, render: (r) => formatMoney(r.grossLossMinor, r.currency) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', sortValue: (r) => r.outstandingMinor, render: (r) => formatMoney(r.outstandingMinor, r.currency) },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} metaColors={claimColors} /> },
  ];

  // A non-admin with no grant at all: the API returns 403 - explain it.
  const noAccess = !isAdmin && grants.isSuccess && grants.data.grants.length === 0;

  return (
    <>
      <PageHeader
        title="Counterparty portal"
        description={meta ? `${meta.partyName} · ${titleCase(meta.portalType)} view` : 'Your scoped view of contracts, statements and claims.'}
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Counterparty portal' }]}
      />

      <div className={styles.page}>
      {isAdmin && (
        <Card padded={false}>
          <div className={styles.cardHead}>
            <CardHeader title="Impersonate a counterparty" subtitle="Administrators can preview any party's portal view." />
          </div>
          <div className={styles.impersonate}>
            <div className={styles.field}>
              <FormField label="Party">
                <Select value={adminPartyId} onChange={(e) => setAdminPartyId(e.target.value)}>
                  <option value="">Select a party…</option>
                  {adminParties.data?.parties.map((p) => (
                    <option key={p.id} value={p.id}>{p.shortName ?? p.legalName}</option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div className={styles.fieldNarrow}>
              <FormField label="Portal type">
                <Select value={adminType} onChange={(e) => setAdminType(e.target.value)}>
                  {PORTAL_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
                </Select>
              </FormField>
            </div>
          </div>
        </Card>
      )}

      {noAccess && (
        <Card>
          <EmptyState title="No portal access" message="Your account has not been granted access to a counterparty portal. Contact your RIOS administrator." />
        </Card>
      )}

      {ready && !noAccess && (
        <>
          <div className={styles.kpis}>
            <KpiCard label="Contracts" value={formatNumber(s?.contracts)} hint="In your portfolio" loading={overview.isLoading} icon={<Layers size={20} />} accent="var(--primary)" />
            <KpiCard label="Active" value={formatNumber(s?.activeContracts)} hint="Currently in force" loading={overview.isLoading} icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" />
            <KpiCard label="Open claims" value={formatNumber(s?.claims)} hint="Notified to you" loading={overview.isLoading} icon={<AlertTriangle size={20} />} accent="var(--accent-orange)" />
            <KpiCard label="Outstanding" value={formatMoney(s?.outstandingMinor)} hint="Claims reserves" loading={overview.isLoading} icon={<Wallet size={20} />} accent="var(--accent-violet)" />
            <KpiCard label="Statement balance" value={formatMoney(s?.statementBalanceMinor)} hint="Net due / owed" loading={overview.isLoading} icon={<Receipt size={20} />} accent="var(--accent-cyan)" />
            <KpiCard label="Open statements" value={formatNumber(s?.openStatements)} hint="Awaiting settlement" loading={overview.isLoading} icon={<Clock size={20} />} accent="var(--accent-orange)" />
          </div>

          <Card padded={false}>
            <div className={styles.tabBar}>
              <Tabs
                tabs={[
                  { id: 'contracts', label: 'Contracts' },
                  { id: 'statements', label: 'Statements' },
                  { id: 'claims', label: 'Claims' },
                ]}
                active={tab}
                onChange={setTab}
              />
            </div>
            <div className={styles.tabBody}>
              {tab === 'contracts' && (
                contracts.isLoading ? <PageLoader label="Loading contracts…" /> :
                <Table columns={contractCols} rows={contracts.data?.contracts} rowKey={(r) => r.id}
                  empty={<EmptyState title="No contracts" message="No contracts are visible for this portal." />} />
              )}
              {tab === 'statements' && (
                statements.isLoading ? <PageLoader label="Loading statements…" /> :
                <Table columns={statementCols} rows={statements.data?.statements} rowKey={(r) => r.id}
                  empty={<EmptyState title="No statements" message="No statements of account are available yet." />} />
              )}
              {tab === 'claims' && (
                claims.isLoading ? <PageLoader label="Loading claims…" /> :
                <Table columns={claimCols} rows={claims.data?.claims} rowKey={(r) => r.id}
                  empty={<EmptyState title="No claims" message="No claims have been notified on these contracts." />} />
              )}
            </div>
          </Card>
        </>
      )}

      {isAdmin && !adminPartyId && (
        <Card>
          <EmptyState title="Select a counterparty" message="Choose a party and portal type above to preview their portal." />
        </Card>
      )}
      </div>
    </>
  );
}
