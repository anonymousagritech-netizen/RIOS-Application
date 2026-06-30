/**
 * Approval delegation (brief §3). Shows who you may currently act for, your
 * active and past delegations, and a form to delegate your approval authority to
 * a colleague (optionally scoped to one permission). The "may act" decision is
 * computed server-side by the pure @rios/domain resolver.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { FormField, Select, Input } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatDate } from '../lib/format';
import { UserCheck, ShieldCheck, History, UserPlus } from 'lucide-react';
import shared from './shared.module.css';
import styles from './DelegationPage.module.css';

interface User { id: string; displayName: string; email: string }
interface Delegation {
  id: string; delegatorUserId: string; delegateUserId: string; delegatorName: string; delegateName: string;
  scopePermission?: string | null; reason?: string | null; startsAt?: string | null; endsAt?: string | null; active: boolean;
}

export function DelegationPage() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const acting = useQuery({ queryKey: ['acting-for'], queryFn: () => api<{ actingFor: { id: string; displayName: string }[] }>('/api/delegations/acting-for') });
  const list = useQuery({ queryKey: ['delegations'], queryFn: () => api<{ delegations: Delegation[] }>('/api/delegations') });
  const users = useQuery({ queryKey: ['delegation-users'], queryFn: () => api<{ users: User[] }>('/api/delegations/users') });

  const [delegateUserId, setDelegateUserId] = useState('');
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');

  const create = useMutation({
    mutationFn: () => api('/api/delegations', { body: { delegateUserId, scopePermission: scope || null, reason: reason || null } }),
    onSuccess: () => { toast.success('Delegation created'); setDelegateUserId(''); setScope(''); setReason(''); qc.invalidateQueries({ queryKey: ['delegations'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create delegation'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/delegations/${id}/revoke`, { body: {} }),
    onSuccess: () => { toast.success('Delegation revoked'); qc.invalidateQueries({ queryKey: ['delegations'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not revoke'),
  });

  if (list.isLoading) return <PageLoader label="Loading delegations…" />;

  const cols: Column<Delegation>[] = [
    { key: 'from', header: 'From', render: (d) => <span className={shared.cellMain}>{d.delegatorName}</span> },
    { key: 'to', header: 'To', render: (d) => d.delegateName },
    { key: 'scope', header: 'Scope', render: (d) => d.scopePermission ? <Badge color="violet">{d.scopePermission}</Badge> : <Badge color="slate">All approvals</Badge> },
    { key: 'window', header: 'Window', render: (d) => d.startsAt || d.endsAt ? `${d.startsAt ? formatDate(d.startsAt) : '-'} → ${d.endsAt ? formatDate(d.endsAt) : '-'}` : 'Open-ended' },
    { key: 'status', header: 'Status', render: (d) => <Badge color={d.active ? 'green' : 'gray'}>{d.active ? 'Active' : 'Revoked'}</Badge> },
    {
      key: 'act', header: '', align: 'right',
      render: (d) => d.active && d.delegatorUserId === user?.id ? <Button variant="ghost" onClick={() => revoke.mutate(d.id)} loading={revoke.isPending}>Revoke</Button> : null,
    },
  ];

  const actingFor = acting.data?.actingFor ?? [];
  const delegations = list.data?.delegations ?? [];
  const activeCount = delegations.filter((d) => d.active).length;
  const revokedCount = delegations.filter((d) => !d.active).length;

  return (
    <>
      <PageHeader
        title="Approval delegation"
        description="Delegate your approval authority while away - scoped and time-bound, decided by a pure resolver."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Approval delegation' }]}
      />

      <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
        <KpiCard label="Acting for" value={actingFor.length} loading={acting.isLoading} icon={<UserCheck size={20} />} accent="var(--primary)" />
        <KpiCard label="Active delegations" value={activeCount} loading={list.isLoading} icon={<ShieldCheck size={20} />} accent="var(--accent-emerald)" />
        <KpiCard label="Revoked / past" value={revokedCount} loading={list.isLoading} icon={<History size={20} />} accent="var(--accent-orange)" />
      </div>

      <div className={shared.stack}>
        {actingFor.length > 0 && (
          <Card padded={false}>
            <CardHeader title="You may currently act for" subtitle="Colleagues whose approval authority is delegated to you." />
            <div className={styles.badgeRow}>
              {actingFor.map((a) => <Badge key={a.id} color="teal">{a.displayName}</Badge>)}
            </div>
          </Card>
        )}

        <Card padded={false}>
          <CardHeader title="Delegations" subtitle="Authority you have granted and received." />
          <div className={shared.tableWrap}>
            <Table columns={cols} rows={list.data?.delegations} rowKey={(d) => d.id}
              empty={<EmptyState title="No delegations" message="You have no delegations." />} />
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title="Delegate your authority" subtitle="Grant a colleague the right to approve on your behalf." />
          <div className={styles.form}>
            <div className={styles.formField}>
              <FormField label="Delegate">
                <Select value={delegateUserId} onChange={(e) => setDelegateUserId(e.target.value)}>
                  <option value="">Select a colleague…</option>
                  {users.data?.users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                </Select>
              </FormField>
            </div>
            <div className={styles.formField}>
              <FormField label="Scope (permission, optional)">
                <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. accounting:post" />
              </FormField>
            </div>
            <div className={styles.formField}>
              <FormField label="Reason (optional)">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Cover during leave" />
              </FormField>
            </div>
            <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => create.mutate()} loading={create.isPending} disabled={!delegateUserId}>Delegate</Button>
          </div>
          <p className={`${shared.cellSub} ${styles.hint}`}>Leave the scope blank to delegate all approval authority.</p>
        </Card>
      </div>
    </>
  );
}
