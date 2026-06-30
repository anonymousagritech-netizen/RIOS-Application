import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { Select, TextField } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './workspace.module.css';

/* ---------------- Types ---------------- */
interface Approval {
  id: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  status: string;
  requested_by: string;
  created_at: string;
  payload: unknown;
}
interface ApprovalsResponse { approvals: Approval[]; }

interface Notification {
  id: string;
  subject: string;
  body: string;
  channel: string;
  is_read: boolean;
  created_at: string;
}
interface NotificationsResponse { notifications: Notification[]; }

/* ---------------- Data hooks ---------------- */
function useApprovals(status: string) {
  return useQuery({
    queryKey: ['approvals', status],
    queryFn: () => api<ApprovalsResponse>(`/api/approvals${qs({ status: status || undefined })}`),
  });
}
function useCreateApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { entityType: string; entityId?: string; action: string; payload?: unknown }) =>
      api<Approval>('/api/approvals', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  });
}
function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: 'approved' | 'rejected'; note?: string }) =>
      api(`/api/approvals/${id}/decide`, { body: { decision, note } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  });
}
function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationsResponse>('/api/notifications'),
  });
}
function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];

const TABS = [
  { id: 'approvals', label: 'Approvals' },
  { id: 'notifications', label: 'Notifications' },
];

export function WorkflowPage() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState('approvals');
  const canWrite = hasPermission('workflow:write');
  const canDecide = hasPermission('approval:decide');

  return (
    <>
      <PageHeader
        title="Workflow"
        description="Approval requests and notifications across the platform."
        actions={
          canDecide
            ? <Badge color="green">approval:decide granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'approvals' && <ApprovalsTab canWrite={canWrite} canDecide={canDecide} />}
        {tab === 'notifications' && <NotificationsTab />}
      </Card>
    </>
  );
}

/* ---------------- Approvals ---------------- */
function ApprovalsTab({ canWrite, canDecide }: { canWrite: boolean; canDecide: boolean }) {
  const [status, setStatus] = useState('pending');
  const { data, isLoading } = useApprovals(status);
  const decide = useDecideApproval();
  const toast = useToast();
  const [showNew, setShowNew] = useState(false);
  const [pending, setPending] = useState<{ approval: Approval; decision: 'approved' | 'rejected' } | null>(null);

  const runDecision = async () => {
    if (!pending) return;
    try {
      await decide.mutateAsync({ id: pending.approval.id, decision: pending.decision });
      toast.success(pending.decision === 'approved' ? 'Request approved' : 'Request rejected');
      setPending(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the decision.');
    }
  };

  const columns: Column<Approval>[] = [
    { key: 'entity', header: 'Entity', sortValue: (a) => a.entity_type, render: (a) => (
      <div>
        <div className={shared.cellMain}>{titleCase(a.entity_type)}</div>
        {a.entity_id && <div className={shared.cellRef}>{a.entity_id}</div>}
      </div>
    ) },
    { key: 'action', header: 'Action', sortValue: (a) => a.action, render: (a) => titleCase(a.action) },
    { key: 'requested_by', header: 'Requested by', sortValue: (a) => a.requested_by, render: (a) => a.requested_by },
    { key: 'created_at', header: 'Requested', sortValue: (a) => a.created_at ?? '', render: (a) => formatDateTime(a.created_at) },
    { key: 'status', header: 'Status', render: (a) => <StatusPill status={a.status} /> },
    ...(canDecide ? [{
      key: 'decide', header: '', align: 'right' as const,
      render: (a: Approval) => a.status === 'pending' ? (
        <div className={shared.rowGap} style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" variant="primary" onClick={() => setPending({ approval: a, decision: 'approved' })}>Approve</Button>
          <Button size="sm" variant="danger" onClick={() => setPending({ approval: a, decision: 'rejected' })}>Reject</Button>
        </div>
      ) : null,
    }] : []),
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        {canWrite && (
          <Button size="sm" variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New approval</Button>
        )}
      </div>
      <Table
        columns={columns}
        rows={data?.approvals}
        loading={isLoading}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No approval requests" message="There are no requests matching this status." icon="✓" />}
      />

      <NewApprovalModal open={showNew} onClose={() => setShowNew(false)} />

      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={runDecision}
        loading={decide.isPending}
        destructive={pending?.decision === 'rejected'}
        title={pending?.decision === 'approved' ? 'Approve request?' : 'Reject request?'}
        message={pending
          ? `${pending.decision === 'approved' ? 'Approve' : 'Reject'} ${titleCase(pending.approval.action)} on ${titleCase(pending.approval.entity_type)}?`
          : ''}
        confirmLabel={pending?.decision === 'approved' ? 'Approve' : 'Reject'}
      />
    </>
  );
}

function NewApprovalModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateApproval();
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setEntityType(''); setEntityId(''); setAction(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!entityType.trim() || !action.trim()) { setError('Entity type and action are required.'); return; }
    try {
      await create.mutateAsync({
        entityType: entityType.trim(),
        entityId: entityId.trim() || undefined,
        action: action.trim(),
      });
      toast.success('Approval request created');
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the request.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New approval request"
      description="Raise an approval request for another user to decide."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!entityType.trim() || !action.trim()}>Create request</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <TextField label="Entity type" value={entityType} onChange={setEntityType} required placeholder="e.g. treaty" />
        <TextField label="Entity ID" value={entityId} onChange={setEntityId} placeholder="Optional" />
        <TextField label="Action" value={action} onChange={setAction} required placeholder="e.g. bind" />
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Notifications ---------------- */
function NotificationsTab() {
  const { data, isLoading } = useNotifications();
  const markRead = useMarkRead();
  const toast = useToast();

  const onMarkRead = async (id: string) => {
    try {
      await markRead.mutateAsync(id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not mark as read.');
    }
  };

  const notifications = data?.notifications ?? [];

  return (
    <div className={styles.tabBody}>
      <CardHeader title="Notifications" subtitle="Recent platform notifications across channels." />
      {isLoading ? (
        <PageLoader label="Loading notifications…" />
      ) : notifications.length === 0 ? (
        <EmptyState title="No notifications" message="You're all caught up." icon="🔔" />
      ) : (
        <div className={styles.notifList}>
          {notifications.map((n) => (
            <div key={n.id} className={`${styles.notif} ${n.is_read ? '' : styles.notifUnread}`}>
              {!n.is_read && <span className={styles.unreadDot} aria-hidden />}
              <div className={styles.notifMain}>
                <span className={styles.notifSubject}>{n.subject}</span>
                <span className={styles.notifBody}>{n.body}</span>
                <span className={styles.notifMeta}>
                  {titleCase(n.channel)} · {formatDateTime(n.created_at)}
                </span>
              </div>
              <div className={shared.rowGap}>
                <Badge color={n.is_read ? 'slate' : 'blue'}>{n.is_read ? 'Read' : 'Unread'}</Badge>
                {!n.is_read && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onMarkRead(n.id)}
                    loading={markRead.isPending && markRead.variables === n.id}
                  >
                    Mark read
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
