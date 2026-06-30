/**
 * Multi-company & branch/office management (brief §9.1). Lists the legal entities
 * in the tenant group and their offices. Read-focused.
 */

import { Building2, Network, MapPin, Globe2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './CompaniesPage.module.css';

interface Company { id: string; code: string; name: string; country?: string | null; baseCurrency?: string | null; parentName?: string | null; status: string }
interface Office { id: string; code: string; name: string; city?: string | null; country?: string | null; isHeadOffice: boolean; status: string; companyName?: string | null }

const STATUS: Record<string, 'green' | 'amber' | 'gray'> = { active: 'green', open: 'green', dormant: 'amber', closed: 'gray' };

export function CompaniesPage() {
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api<{ companies: Company[] }>('/api/platform/companies') });
  const offices = useQuery({ queryKey: ['offices'], queryFn: () => api<{ offices: Office[] }>('/api/platform/offices') });

  const companyRows = companies.data?.companies ?? [];
  const officeRows = offices.data?.offices ?? [];
  const headOffices = officeRows.filter((o) => o.isHeadOffice).length;
  const countries = new Set(
    companyRows.map((c) => c.country).filter((c): c is string => !!c),
  ).size;

  const cCols: Column<Company>[] = [
    { key: 'code', header: 'Code', render: (c) => <span className={shared.cellRef}>{c.code}</span> },
    { key: 'name', header: 'Company', render: (c) => <span className={shared.cellMain}>{c.name}</span> },
    { key: 'parent', header: 'Parent', render: (c) => c.parentName ?? '- (top)' },
    { key: 'country', header: 'Country', render: (c) => c.country ?? '-' },
    { key: 'ccy', header: 'Currency', render: (c) => c.baseCurrency ?? '-' },
    { key: 'status', header: 'Status', render: (c) => <Badge color={STATUS[c.status] ?? 'slate'}>{titleCase(c.status)}</Badge> },
  ];
  const oCols: Column<Office>[] = [
    { key: 'code', header: 'Code', render: (o) => <span className={shared.cellRef}>{o.code}</span> },
    { key: 'name', header: 'Office', render: (o) => <span className={styles.nameCell}><span className={shared.cellMain}>{o.name}</span>{o.isHeadOffice && <Badge color="blue">HQ</Badge>}</span> },
    { key: 'company', header: 'Company', render: (o) => o.companyName ?? '-' },
    { key: 'city', header: 'City', render: (o) => o.city ?? '-' },
    { key: 'status', header: 'Status', render: (o) => <Badge color={STATUS[o.status] ?? 'slate'}>{titleCase(o.status)}</Badge> },
  ];

  return (
    <div className={shared.stack}>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Organisation' }]}
        title="Organisation"
        description="Group companies and their branch offices across the tenant."
      />

      <div className={shared.kpiRow}>
        <KpiCard label="Companies" value={companyRows.length} loading={companies.isLoading} icon={<Building2 size={20} />} accent="var(--primary)" />
        <KpiCard label="Offices" value={officeRows.length} loading={offices.isLoading} icon={<MapPin size={20} />} accent="var(--accent-violet)" />
        <KpiCard label="Head offices" value={headOffices} loading={offices.isLoading} icon={<Network size={20} />} accent="var(--accent-cyan)" />
        <KpiCard label="Countries" value={countries} loading={companies.isLoading} icon={<Globe2 size={20} />} accent="var(--accent-emerald)" />
      </div>

      <Card padded={false}>
        <CardHeader title="Companies" subtitle="Legal entities in the tenant group." />
        <div className={shared.tableWrap}>
          <Table columns={cCols} rows={companyRows} loading={companies.isLoading} rowKey={(c) => c.id}
            empty={<EmptyState title="No companies" message="No companies have been defined for this tenant." icon={<Building2 size={16} />} />} />
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader title="Offices" subtitle="Branch and head offices by company." />
        <div className={shared.tableWrap}>
          <Table columns={oCols} rows={officeRows} loading={offices.isLoading} rowKey={(o) => o.id}
            empty={<EmptyState title="No offices" message="No offices have been defined for this tenant." icon={<MapPin size={16} />} />} />
        </div>
      </Card>
    </div>
  );
}
