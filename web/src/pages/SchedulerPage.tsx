/**
 * Scheduler / job orchestration (brief §3). Lists interval-scheduled jobs with
 * their next-run and a live "due" flag (computed by the pure @rios/domain
 * scheduler), lets an operator enable/disable or run a job now, and shows the
 * run history. Mutations need ops:write.
 */

import { useState } from 'react';
import { CalendarClock, AlarmClock, ListChecks, Power } from 'lucide-react';
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
import { PageLoader } from '../components/Feedback';
import { formatNumber, formatDateTime } from '../lib/format';
import shared from './shared.module.css';
import styles from './SchedulerPage.module.css';

interface Job {
  id: string; key: string; name: string; jobType: string; intervalMinutes: number;
  enabled: boolean; lastRunAt: string | null; nextRunAt: string | null; due: boolean;
}
interface Run { id: string; status: string; startedAt: string; finishedAt?: string | null; detail?: string | null }

function interval(min: number): string {
  if (min % 1440 === 0) return `every ${min / 1440}d`;
  if (min % 60 === 0) return `every ${min / 60}h`;
  return `every ${min}m`;
}

export function SchedulerPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = hasPermission('ops:write');
  const jobs = useQuery({ queryKey: ['scheduler-jobs'], queryFn: () => api<{ jobs: Job[]; dueCount: number }>('/api/scheduler/jobs') });
  const [openJob, setOpenJob] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ['scheduler-runs', openJob],
    queryFn: () => api<{ runs: Run[] }>(`/api/scheduler/jobs/${openJob}/runs`),
    enabled: !!openJob,
  });

  const run = useMutation({
    mutationFn: (id: string) => api(`/api/scheduler/jobs/${id}/run`, { body: {} }),
    onSuccess: () => { toast.success('Job run recorded'); qc.invalidateQueries({ queryKey: ['scheduler-jobs'] }); qc.invalidateQueries({ queryKey: ['scheduler-runs'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not run job'),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api(`/api/scheduler/jobs/${id}/toggle`, { body: { enabled } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduler-jobs'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update job'),
  });

  const jobList = jobs.data?.jobs ?? [];
  const dueCount = jobs.data?.dueCount ?? 0;
  const enabledCount = jobList.filter((j) => j.enabled).length;

  const cols: Column<Job>[] = [
    { key: 'name', header: 'Job', render: (j) => <span className={shared.cellMain}>{j.name}</span> },
    { key: 'type', header: 'Type', render: (j) => <span className={shared.cellRef}>{j.jobType}</span> },
    { key: 'interval', header: 'Interval', render: (j) => interval(j.intervalMinutes) },
    { key: 'last', header: 'Last run', render: (j) => j.lastRunAt ? formatDateTime(j.lastRunAt) : '-' },
    { key: 'next', header: 'Next run', render: (j) => j.enabled ? (j.nextRunAt ? formatDateTime(j.nextRunAt) : '-') : '-' },
    { key: 'state', header: 'State', render: (j) => j.enabled ? <Badge color={j.due ? 'amber' : 'green'}>{j.due ? 'Due' : 'Scheduled'}</Badge> : <Badge color="gray">Disabled</Badge> },
    {
      key: 'act', header: '', align: 'right',
      render: (j) => canWrite ? (
        <div className={styles.actions}>
          <Button variant="ghost" onClick={() => setOpenJob(openJob === j.id ? null : j.id)}>History</Button>
          <Button variant="ghost" onClick={() => toggle.mutate({ id: j.id, enabled: !j.enabled })}>{j.enabled ? 'Disable' : 'Enable'}</Button>
          <Button variant="primary" onClick={() => run.mutate(j.id)} loading={run.isPending} disabled={!j.enabled}>Run now</Button>
        </div>
      ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Scheduler"
        description="Interval-scheduled jobs with run history. Due-state is computed by the pure scheduler engine."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Scheduler' }]}
      />

      <div className={styles.kpiRow}>
        <KpiCard label="Total jobs" value={formatNumber(jobList.length)} hint="Registered" icon={<CalendarClock size={20} />} accent="var(--primary)" loading={jobs.isLoading} />
        <KpiCard label="Enabled" value={formatNumber(enabledCount)} hint="Actively scheduled" icon={<Power size={20} />} accent="var(--accent-violet)" loading={jobs.isLoading} />
        <KpiCard label="Due now" value={formatNumber(dueCount)} hint="Awaiting run" icon={<AlarmClock size={20} />} accent={dueCount > 0 ? 'var(--accent-orange)' : 'var(--accent-emerald)'} loading={jobs.isLoading} />
        <KpiCard label="Disabled" value={formatNumber(jobList.length - enabledCount)} hint="Paused" icon={<ListChecks size={20} />} accent="var(--accent-cyan)" loading={jobs.isLoading} />
      </div>

      <Card padded={false}>
        <CardHeader title="Jobs" subtitle={`${formatNumber(dueCount)} due now`} />
        <div className={styles.tableWrap}>
          {jobs.isLoading ? <PageLoader label="Loading jobs…" /> : (
            <Table columns={cols} rows={jobList} rowKey={(j) => j.id}
              empty={<EmptyState title="No jobs" message="No scheduled jobs defined." icon={<CalendarClock size={16} />} />} />
          )}
        </div>
      </Card>

      {openJob && (
        <Card padded={false}>
          <CardHeader title="Run history" actions={<Button variant="ghost" onClick={() => setOpenJob(null)}>Close</Button>} />
          <div className={styles.tableWrap}>
            {runs.isLoading ? <PageLoader label="Loading history…" /> : (
              <Table
                columns={[
                  { key: 'started', header: 'Started', render: (r: Run) => formatDateTime(r.startedAt) },
                  { key: 'finished', header: 'Finished', render: (r: Run) => r.finishedAt ? formatDateTime(r.finishedAt) : '-' },
                  { key: 'status', header: 'Status', render: (r: Run) => <Badge color={r.status === 'success' ? 'green' : r.status === 'failed' ? 'red' : 'amber'}>{r.status}</Badge> },
                  { key: 'detail', header: 'Detail', render: (r: Run) => <span className={shared.cellSub}>{r.detail ?? '-'}</span> },
                ]}
                rows={runs.data?.runs}
                rowKey={(r) => r.id}
                empty={<EmptyState title="No runs" message="This job has not run yet." />}
              />
            )}
          </div>
        </Card>
      )}
    </>
  );
}
