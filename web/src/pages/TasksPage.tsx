/**
 * Task Management & SLA — the operations console for assignable work items.
 * Referrals, renewals and reviews across RIOS raise tasks here so nothing is
 * dropped; each carries a priority and due-date SLA. Reads gate on ops:read,
 * writes on ops:write.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ListChecks, AlertTriangle, Clock, CheckCircle2, Gauge, Plus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Select, TextField, Textarea } from '../components/Form';
import { titleCase } from '../lib/format';
import type { TokenColor } from '../lib/status';
import styles from './TasksPage.module.css';

interface Task {
  id: string; title: string; description: string | null; kind: string; priority: string; status: string;
  assigneeName: string | null; dueAt: string | null; entityType: string | null; entityId: string | null;
  entityLabel: string | null; sla: string;
}
interface Summary { total: number; open: number; overdue: number; dueSoon: number; done: number; slaCompliancePct: number; byPriority: Record<string, number>; }

const SLA_COLOR: Record<string, TokenColor> = { OVERDUE: 'red', DUE_SOON: 'amber', ON_TRACK: 'green', NO_DUE: 'slate', DONE: 'gray' };
const PRIORITY_COLOR: Record<string, TokenColor> = { URGENT: 'red', HIGH: 'orange', MEDIUM: 'blue', LOW: 'slate' };
const STATUS_COLOR: Record<string, TokenColor> = { OPEN: 'blue', IN_PROGRESS: 'violet', BLOCKED: 'red', DONE: 'green', CANCELLED: 'gray' };
const STATUSES = ['', 'OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;

export function TasksPage() {
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('ops:write');

  const summary = useQuery({ queryKey: ['tasks', 'summary'], queryFn: () => api<Summary>('/api/tasks/summary') });
  const list = useQuery({ queryKey: ['tasks', status, mine], queryFn: () => api<{ tasks: Task[] }>(`/api/tasks?${status ? `status=${status}&` : ''}${mine ? 'assignee=me' : ''}`) });
  const s = summary.data;

  const setStatusMut = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) => api(`/api/tasks/${id}/status`, { body: { status: next } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks'] }); toast.success('Task updated'); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Update failed'),
  });

  const columns: Column<Task>[] = [
    {
      key: 'title', header: 'Task', sortValue: (r) => r.title,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.title}</div>
          <div className={styles.cellSub}>{titleCase(r.kind)}{r.entityLabel ? ` · ${r.entityLabel}` : ''}{r.assigneeName ? ` · ${r.assigneeName}` : ''}</div>
        </div>
      ),
    },
    { key: 'priority', header: 'Priority', render: (r) => <Badge color={PRIORITY_COLOR[r.priority] ?? 'slate'}>{titleCase(r.priority)}</Badge> },
    { key: 'sla', header: 'SLA', render: (r) => <Badge color={SLA_COLOR[r.sla] ?? 'gray'}>{r.sla === 'NO_DUE' ? 'No due' : titleCase(r.sla)}</Badge> },
    { key: 'due', header: 'Due', render: (r) => <span className={styles.cellSub}>{r.dueAt ? new Date(r.dueAt).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'gray'}>{titleCase(r.status)}</Badge> },
    {
      key: 'act', header: '', align: 'right', render: (r) => (canWrite && r.status !== 'DONE' && r.status !== 'CANCELLED') ? (
        <div className={styles.rowActions}>
          {r.status !== 'IN_PROGRESS' && <Button size="sm" variant="ghost" loading={setStatusMut.isPending} onClick={(e) => { e.stopPropagation(); setStatusMut.mutate({ id: r.id, next: 'IN_PROGRESS' }); }}>Start</Button>}
          <Button size="sm" variant="secondary" loading={setStatusMut.isPending} onClick={(e) => { e.stopPropagation(); setStatusMut.mutate({ id: r.id, next: 'DONE' }); }}>Done</Button>
        </div>
      ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Tasks & SLA"
        description="Assignable work across RIOS — referrals, renewals and reviews — tracked to done with due-date SLAs."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Operations' }, { label: 'Tasks' }]}
        actions={canWrite ? <Button variant="primary" icon={<Plus size={16} />} onClick={() => setShowNew(true)}>New task</Button> : undefined}
      />

      <div className={styles.kpis}>
        <KpiCard label="Open tasks" value={String(s?.open ?? 0)} hint="Not yet done" icon={<ListChecks size={20} />} accent="var(--primary)" loading={summary.isLoading} />
        <KpiCard label="Overdue" value={String(s?.overdue ?? 0)} hint="Past SLA" icon={<AlertTriangle size={20} />} accent="var(--accent-rose)" loading={summary.isLoading} />
        <KpiCard label="Due soon" value={String(s?.dueSoon ?? 0)} hint="Within 48h" icon={<Clock size={20} />} accent="var(--accent-orange)" loading={summary.isLoading} />
        <KpiCard label="SLA compliance" value={`${s?.slaCompliancePct ?? 100}%`} hint="On-track of due" icon={<Gauge size={20} />} accent="var(--accent-emerald)" loading={summary.isLoading} />
        <KpiCard label="Completed" value={String(s?.done ?? 0)} hint="Closed out" icon={<CheckCircle2 size={20} />} accent="var(--accent-cyan)" loading={summary.isLoading} />
      </div>

      <Card padded={false}>
        <CardHeader title="Task board" subtitle="Urgent + soonest-due first" actions={<label className={styles.mineToggle}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> My tasks</label>} />
        <div className={styles.filterBar}>
          {STATUSES.map((st) => (
            <button key={st || 'all'} className={`${styles.filterChip} ${status === st ? styles.filterActive : ''}`} onClick={() => setStatus(st)}>{st ? titleCase(st) : 'All'}</button>
          ))}
        </div>
        <div className={styles.tableWrap}>
          <Table
            columns={columns} rows={list.data?.tasks} loading={list.isLoading} rowKey={(r) => r.id}
            onRowClick={(r) => { if (r.entityType === 'submission' && r.entityId) navigate(`/underwriting?submission=${r.entityId}`); }}
            empty={<EmptyState icon={<ListChecks size={18} />} title="No tasks" message="Nothing on the board in this view." />}
            skeletonRows={6}
          />
        </div>
      </Card>

      <NewTaskModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ title: '', description: '', kind: 'GENERAL', priority: 'MEDIUM', dueAt: '' });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const create = useMutation({
    mutationFn: () => api('/api/tasks', { body: { title: f.title, description: f.description || undefined, kind: f.kind, priority: f.priority, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks'] }); toast.success('Task created'); onClose(); setF({ title: '', description: '', kind: 'GENERAL', priority: 'MEDIUM', dueAt: '' }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create task'),
  });
  return (
    <Modal open={open} onClose={onClose} size="md" title="New task"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!f.title.trim()} onClick={() => create.mutate()}>Create task</Button></>}>
      <FormSection title="Details">
        <div style={{ gridColumn: '1 / -1' }}><TextField label="Title" value={f.title} onChange={set('title')} required placeholder="e.g. Review North Atlantic Cat XL slip" /></div>
        <FormField label="Kind"><Select value={f.kind} onChange={(e) => set('kind')(e.target.value)}>{['GENERAL', 'REFERRAL', 'REVIEW', 'RENEWAL', 'CLAIM', 'PLACEMENT', 'COMPLIANCE'].map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}</Select></FormField>
        <FormField label="Priority"><Select value={f.priority} onChange={(e) => set('priority')(e.target.value)}>{['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}</Select></FormField>
        <TextField label="Due date" type="date" value={f.dueAt} onChange={set('dueAt')} />
        <div style={{ gridColumn: '1 / -1' }}><FormField label="Description"><Textarea value={f.description} onChange={(e) => set('description')(e.target.value)} rows={3} /></FormField></div>
      </FormSection>
    </Modal>
  );
}
