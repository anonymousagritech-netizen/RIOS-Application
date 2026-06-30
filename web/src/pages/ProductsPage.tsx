/**
 * Product lifecycle management (brief §14 - insurance-product factory). Lists
 * versioned insurance products with their lifecycle state and the actions
 * available from that state (computed from the same workflow definition the
 * server enforces), and drives transitions. Authoring/transitions need
 * product:write.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageLoader } from '../components/Feedback';
import { formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';

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
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          {p.actions.map((a) => (
            <Button key={a.event} variant={a.event === 'retire' || a.event === 'discard' ? 'ghost' : 'primary'}
              onClick={() => transition.mutate({ id: p.id, event: a.event })} loading={transition.isPending}>
              {a.label ?? titleCase(a.event)}
            </Button>
          ))}
        </div>
      ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Products" description="The insurance-product factory - versioned definitions driven through a lifecycle the server enforces." />
      <Card>
        <CardHeader title="Insurance products" subtitle="DRAFT → ACTIVE → (SUSPENDED ↔ ACTIVE) → RETIRED" />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table columns={cols} rows={q.data?.products} rowKey={(p) => p.id}
            empty={<EmptyState title="No products" message="No insurance products defined." />} />
        </div>
      </Card>
    </>
  );
}
