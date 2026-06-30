/**
 * Multi-company & branch/office management (brief §9.1). Lists the legal entities
 * in the tenant group and their offices. Read-focused.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { PageLoader } from '../components/Feedback';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Company { id: string; code: string; name: string; country?: string | null; baseCurrency?: string | null; parentName?: string | null; status: string }
interface Office { id: string; code: string; name: string; city?: string | null; country?: string | null; isHeadOffice: boolean; status: string; companyName?: string | null }

const STATUS: Record<string, 'green' | 'amber' | 'gray'> = { active: 'green', open: 'green', dormant: 'amber', closed: 'gray' };

export function CompaniesPage() {
  const companies = useQuery({ queryKey: ['companies'], queryFn: () => api<{ companies: Company[] }>('/api/platform/companies') });
  const offices = useQuery({ queryKey: ['offices'], queryFn: () => api<{ offices: Office[] }>('/api/platform/offices') });

  if (companies.isLoading || offices.isLoading) return <PageLoader label="Loading organisation…" />;

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
    { key: 'name', header: 'Office', render: (o) => <span className={shared.cellMain}>{o.name}{o.isHeadOffice && <Badge color="blue">HQ</Badge>}</span> },
    { key: 'company', header: 'Company', render: (o) => o.companyName ?? '-' },
    { key: 'city', header: 'City', render: (o) => o.city ?? '-' },
    { key: 'status', header: 'Status', render: (o) => <Badge color={STATUS[o.status] ?? 'slate'}>{titleCase(o.status)}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Organisation" description="Group companies and their offices." />
      <Card>
        <CardHeader title="Companies" />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table columns={cCols} rows={companies.data?.companies} rowKey={(c) => c.id}
            empty={<EmptyState title="No companies" message="No companies defined." />} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Offices" />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table columns={oCols} rows={offices.data?.offices} rowKey={(o) => o.id}
            empty={<EmptyState title="No offices" message="No offices defined." />} />
        </div>
      </Card>
    </>
  );
}
