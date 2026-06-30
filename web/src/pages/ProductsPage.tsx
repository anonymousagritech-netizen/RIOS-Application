/**
 * Product lifecycle management (brief §14 - insurance-product factory). Lists
 * versioned insurance products with their lifecycle state and the actions
 * available from that state (computed from the same workflow definition the
 * server enforces), and drives transitions. Authoring/transitions need
 * product:write.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, CheckCircle2, PauseCircle, Archive } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageLoader } from '../components/Feedback';
import { formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './ProductsPage.module.css';

interface Action { event: string; to: string; label?: string }
interface Product {
  id: string; code: string; name: string; lineOfBusiness?: string | null; version: number;
  status: string; definition: Record<string, unknown>; updatedAt?: string | null; actions: Action[];
}

const STATUS_COLOR: Record<string, 'slate' | 'green' | 'amber' | 'gray'> = {
  DRAFT: 'slate', ACTIVE: 'green', SUSPENDED: 'amber', RETIRED: 'gray',
};

export function ProductsPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = hasPermission('product:write');
  const q = useQuery({ queryKey: ['products'], queryFn: () => api<{ products: Product[] }>('/api/products') });

  const transition = useMutation({
    mutationFn: ({ id, event }: { id: string; event: string }) => api(`/api/products/${id}/transition`, { body: { event } }),
    onSuccess: () => { toast.success('Lifecycle updated'); qc.invalidateQueries({ queryKey: ['products'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Transition refused'),
  });

  if (q.isLoading) return <PageLoader label="Loading products…" />;

  const products = q.data?.products ?? [];
  const active = products.filter((p) => p.status === 'ACTIVE').length;
  const suspended = products.filter((p) => p.status === 'SUSPENDED').length;
  const retired = products.filter((p) => p.status === 'RETIRED').length;

  const cols: Column<Product>[] = [
    { key: 'code', header: 'Code', render: (p) => <span className={shared.cellRef}>{p.code}</span> },
    { key: 'name', header: 'Product', render: (p) => <span className={shared.cellMain}>{p.name}</span> },
    { key: 'lob', header: 'Line', render: (p) => p.lineOfBusiness ? titleCase(p.lineOfBusiness) : '-' },
    { key: 'version', header: 'Ver', align: 'right', render: (p) => `v${p.version}` },
    { key: 'status', header: 'Lifecycle', render: (p) => <Badge color={STATUS_COLOR[p.status] ?? 'slate'}>{titleCase(p.status)}</Badge> },
    { key: 'updated', header: 'Updated', render: (p) => p.updatedAt ? formatDateTime(p.updatedAt) : '-' },
    {
      key: 'act', header: '', align: 'right',
      render: (p) => canWrite && p.actions.length ? (
        <div className={styles.rowActions}>
          {p.actions.map((a) => (
            <Button key={a.event} size="sm" variant={a.event === 'retire' || a.event === 'discard' ? 'ghost' : 'primary'}
              onClick={() => transition.mutate({ id: p.id, event: a.event })} loading={transition.isPending}>
              {a.label ?? titleCase(a.event)}
            </Button>
          ))}
        </div>
      ) : null,
    },
  ];

  return (
    <div className={shared.stack}>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Products' }]}
        title="Products"
        description="The insurance-product factory - versioned definitions driven through a lifecycle the server enforces."
      />

      <div className={shared.kpiRow}>
        <KpiCard label="Products" value={products.length} loading={q.isLoading} icon={<Boxes size={20} />} accent="var(--primary)" />
        <KpiCard label="Active" value={active} loading={q.isLoading} icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" />
        <KpiCard label="Suspended" value={suspended} loading={q.isLoading} icon={<PauseCircle size={20} />} accent="var(--accent-orange)" />
        <KpiCard label="Retired" value={retired} loading={q.isLoading} icon={<Archive size={20} />} accent="var(--accent-violet)" />
      </div>

      <Card padded={false}>
        <div className={styles.cardPad}>
          <CardHeader title="Insurance products" subtitle="DRAFT → ACTIVE → (SUSPENDED ↔ ACTIVE) → RETIRED" />
        </div>
        <Table columns={cols} rows={products} rowKey={(p) => p.id}
          empty={<EmptyState title="No products" message="No insurance products defined." icon={<Boxes size={16} />} />} />
      </Card>
    </div>
  );
}
