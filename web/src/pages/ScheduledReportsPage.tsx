import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock, FileText, Mail, Users, PlusCircle, Play, Power,
  FileSpreadsheet, Send, ListChecks,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { Tabs } from '../components/Tabs';
import { FormField, FormSection, Select, TextField, Textarea } from '../components/Form';
import { BarChart } from '../components/BarChart';
import type { TokenColor } from '../lib/status';
import { formatNumber, formatDate, formatDateTime, titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';
import styles from './ScheduledReportsPage.module.css';

/* ---------------- Types (mirror the /api/scheduled-reports contract) ---------------- */
type Cadence = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
type OutputFormat = 'PDF' | 'EXCEL' | 'CSV';
type RunStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED';

interface ScheduleRow {
  id: string;
  name: string;
  cadence: Cadence;
  format: OutputFormat;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  definitionName: string | null;
  listName: string | null;
  recipientCount: number;
  runCount: number;
}
interface DistributionList {
  id: string;
  name: string;
  description: string | null;
  recipientCount: number;
  recipients: string[];
}
interface CadenceBucket { key: Cadence; n: number; }
interface ScheduledReportsResponse {
  schedules: ScheduleRow[];
  lists: DistributionList[];
  byCadence: CadenceBucket[];
  totals: { schedules: number; enabled: number; lists: number; runs: number };
}
interface ScheduleRun {
  id: string;
  status: RunStatus;
  format: OutputFormat;
  rowCount: number;
  recipients: number;
  note: string | null;
  generatedAt: string;
}
interface ScheduleDetail {
  id: string;
  name: string;
  cadence: Cadence;
  format: OutputFormat;
  enabled: boolean;
  config: Record<string, unknown> | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  definitionId: string | null;
  definitionName: string | null;
  distributionListId: string | null;
  listName: string | null;
  recipients: string[];
  runs: ScheduleRun[];
}

/* ---------------- Constants ---------------- */
const CADENCES: Cadence[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'];
const FORMATS: OutputFormat[] = ['PDF', 'EXCEL', 'CSV'];
const CADENCE_ORDER: Record<Cadence, number> = {
  DAILY: 0, WEEKLY: 1, MONTHLY: 2, QUARTERLY: 3, ANNUAL: 4,
};

const CADENCE_COLOR: Record<Cadence, TokenColor> = {
  DAILY: 'teal', WEEKLY: 'blue', MONTHLY: 'violet', QUARTERLY: 'amber', ANNUAL: 'indigo',
};
const FORMAT_COLOR: Record<OutputFormat, TokenColor> = {
  PDF: 'red', EXCEL: 'green', CSV: 'slate',
};
const RUN_COLOR: Record<RunStatus, TokenColor> = {
  SUCCESS: 'green', FAILED: 'red', SKIPPED: 'slate',
};
// Let the BarChart pass our cadence-derived token colours straight through.
const CADENCE_BAR_META: Record<string, string> = {
  DAILY: 'teal', WEEKLY: 'blue', MONTHLY: 'violet', QUARTERLY: 'amber', ANNUAL: 'indigo',
};

/** Split a comma/newline separated blob into trimmed, de-duplicated emails. */
function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const email = part.trim();
    if (email && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      out.push(email);
    }
  }
  return out;
}

/* ---------------- Data hook ---------------- */
function useScheduledReports() {
  return useQuery({
    queryKey: ['scheduled-reports'],
    queryFn: () => api<ScheduledReportsResponse>('/api/scheduled-reports'),
  });
}

export function ScheduledReportsPage() {
  const [tab, setTab] = useState<'schedules' | 'lists'>('schedules');
  const [showNewSchedule, setShowNewSchedule] = useState(false);
  const [showNewList, setShowNewList] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('reporting:write');

  const { data, isLoading } = useScheduledReports();
  const schedules = data?.schedules ?? [];
  const lists = data?.lists ?? [];
  const totals = data?.totals;

  const barData = [...(data?.byCadence ?? [])]
    .sort((a, b) => (CADENCE_ORDER[a.key] ?? 99) - (CADENCE_ORDER[b.key] ?? 99))
    .map((c) => ({ label: c.key, value: c.n, status: c.key }));

  const runMutation = useMutation({
    mutationFn: (id: string) => api<{ runId: string }>(`/api/scheduled-reports/${id}/run`, { body: {} }),
    onSuccess: (_res, id) => {
      toast.success('Report generated');
      qc.invalidateQueries({ queryKey: ['scheduled-reports'] });
      qc.invalidateQueries({ queryKey: ['scheduled-report', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not generate the report.'),
  });

  const toggleMutation = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api<{ id: string; enabled: boolean }>(`/api/scheduled-reports/${v.id}/toggle`, { body: { enabled: v.enabled } }),
    onSuccess: (_res, v) => {
      toast.success(v.enabled ? 'Schedule resumed' : 'Schedule paused');
      qc.invalidateQueries({ queryKey: ['scheduled-reports'] });
      qc.invalidateQueries({ queryKey: ['scheduled-report', v.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update the schedule.'),
  });

  const scheduleColumns: Column<ScheduleRow>[] = [
    {
      key: 'name', header: 'Name', sortValue: (r) => r.name,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.name}</div>
          <div className={styles.cellSub}>{r.definitionName ?? 'Ad-hoc report'}</div>
        </div>
      ),
    },
    {
      key: 'cadence', header: 'Cadence', sortValue: (r) => CADENCE_ORDER[r.cadence] ?? 99,
      render: (r) => <Badge color={CADENCE_COLOR[r.cadence] ?? 'slate'}>{titleCase(r.cadence)}</Badge>,
    },
    {
      key: 'format', header: 'Format', sortValue: (r) => r.format,
      render: (r) => <Badge color={FORMAT_COLOR[r.format] ?? 'slate'}>{r.format}</Badge>,
    },
    {
      key: 'recipients', header: 'Recipients', align: 'right', sortValue: (r) => r.recipientCount,
      render: (r) => (
        <span className={styles.recipCell}>
          <Mail size={13} aria-hidden />
          <span className={styles.num}>{formatNumber(r.recipientCount)}</span>
        </span>
      ),
    },
    {
      key: 'next', header: 'Next run', align: 'right', sortValue: (r) => r.nextRunAt ?? '',
      render: (r) => <span className={styles.num}>{r.nextRunAt ? formatDate(r.nextRunAt) : '—'}</span>,
    },
    {
      key: 'last', header: 'Last run', align: 'right', sortValue: (r) => r.lastRunAt ?? '',
      render: (r) => <span className={styles.num}>{r.lastRunAt ? formatDate(r.lastRunAt) : '—'}</span>,
    },
    {
      key: 'status', header: 'Status', sortValue: (r) => (r.enabled ? 0 : 1),
      render: (r) => <Badge color={r.enabled ? 'green' : 'slate'}>{r.enabled ? 'Active' : 'Paused'}</Badge>,
    },
  ];
  if (canWrite) {
    scheduleColumns.push({
      key: 'actions', header: '', align: 'right',
      render: (r) => (
        <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm" variant="ghost" icon={<Play size={13} />}
            loading={runMutation.isPending && runMutation.variables === r.id}
            onClick={() => runMutation.mutate(r.id)}
          >
            Run now
          </Button>
          <Button
            size="sm" variant="ghost" icon={<Power size={13} />}
            loading={toggleMutation.isPending && toggleMutation.variables?.id === r.id}
            onClick={() => toggleMutation.mutate({ id: r.id, enabled: !r.enabled })}
          >
            {r.enabled ? 'Pause' : 'Resume'}
          </Button>
        </div>
      ),
    });
  }

  const listColumns: Column<DistributionList>[] = [
    {
      key: 'name', header: 'Name', sortValue: (r) => r.name,
      render: (r) => <div className={styles.cellMain}>{r.name}</div>,
    },
    {
      key: 'description', header: 'Description', sortValue: (r) => r.description ?? '',
      render: (r) => <span className={styles.cellSub}>{r.description || '—'}</span>,
    },
    {
      key: 'recipientCount', header: 'Recipients', align: 'right', sortValue: (r) => r.recipientCount,
      render: (r) => (
        <span className={styles.recipCell}>
          <Users size={13} aria-hidden />
          <span className={styles.num}>{formatNumber(r.recipientCount)}</span>
        </span>
      ),
    },
    {
      key: 'preview', header: 'Members',
      render: (r) => {
        const shown = r.recipients.slice(0, 3);
        const extra = r.recipientCount - shown.length;
        return (
          <span className={styles.cellSub}>
            {shown.length ? shown.join(', ') : '—'}
            {extra > 0 && <span className={styles.moreTag}> +{extra} more</span>}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Scheduled Reports"
        description="Automate report delivery — schedule named reports on a cadence, choose an output format, and distribute them to email recipient lists."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Reporting', to: '/reporting' }, { label: 'Scheduled Reports' }]}
        actions={canWrite ? (
          <>
            <Button variant="secondary" icon={<ListChecks size={16} />} onClick={() => setShowNewList(true)}>New list</Button>
            <Button variant="primary" icon={<PlusCircle size={16} />} onClick={() => setShowNewSchedule(true)}>New schedule</Button>
          </>
        ) : undefined}
      />

      <div className={styles.kpis}>
        <KpiCard label="Schedules" value={totals ? formatNumber(totals.schedules) : '—'} hint="Report schedules configured" icon={<CalendarClock size={20} />} accent="var(--primary)" loading={isLoading} />
        <KpiCard label="Active" value={totals ? formatNumber(totals.enabled) : '—'} hint="Currently enabled" icon={<Power size={20} />} accent="var(--accent-emerald)" loading={isLoading} />
        <KpiCard label="Distribution lists" value={totals ? formatNumber(totals.lists) : '—'} hint="Recipient lists" icon={<Users size={20} />} accent="var(--accent-violet)" loading={isLoading} />
        <KpiCard label="Runs" value={totals ? formatNumber(totals.runs) : '—'} hint="Reports generated to date" icon={<FileText size={20} />} accent="var(--accent-teal)" loading={isLoading} />
      </div>

      <Card padded style={{ marginBottom: 'var(--space-5)' }}>
        <CardHeader title="Schedules by cadence" subtitle="How report schedules are distributed across delivery cadences" />
        {isLoading ? (
          <p className={styles.cellSub}>Loading cadences…</p>
        ) : (
          <BarChart data={barData} metaColors={CADENCE_BAR_META} emptyLabel="No schedules defined yet" />
        )}
      </Card>

      <Card padded={false}>
        <div className={styles.tabsBar}>
          <Tabs
            tabs={[
              { id: 'schedules', label: 'Schedules' },
              { id: 'lists', label: 'Distribution lists' },
            ]}
            active={tab}
            onChange={(id) => setTab(id as 'schedules' | 'lists')}
          />
        </div>
        <div className={styles.tableWrap}>
          {tab === 'schedules' ? (
            <Table
              columns={scheduleColumns}
              rows={schedules}
              loading={isLoading}
              rowKey={(r) => r.id}
              onRowClick={(r) => setDetailId(r.id)}
              empty={<EmptyState icon={<CalendarClock size={18} />} title="No scheduled reports" message="Create a schedule to automate report generation and delivery." />}
              skeletonRows={5}
            />
          ) : (
            <Table
              columns={listColumns}
              rows={lists}
              loading={isLoading}
              rowKey={(r) => r.id}
              empty={<EmptyState icon={<Users size={18} />} title="No distribution lists" message="Create a distribution list to send scheduled reports to a group of recipients." />}
              skeletonRows={5}
            />
          )}
        </div>
      </Card>

      <NewScheduleModal open={showNewSchedule} onClose={() => setShowNewSchedule(false)} lists={lists} />
      <NewListModal open={showNewList} onClose={() => setShowNewList(false)} />
      <ScheduleDrawer
        id={detailId}
        onClose={() => setDetailId(null)}
        canWrite={canWrite}
        onRun={(id) => runMutation.mutate(id)}
        running={runMutation.isPending}
      />
    </>
  );
}

/* ---------------- Detail drawer ---------------- */
function ScheduleDrawer({
  id, onClose, canWrite, onRun, running,
}: {
  id: string | null;
  onClose: () => void;
  canWrite: boolean;
  onRun: (id: string) => void;
  running: boolean;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['scheduled-report', id],
    queryFn: () => api<ScheduleDetail>(`/api/scheduled-reports/${id}`),
    enabled: !!id,
  });

  const runColumns: Column<ScheduleRun>[] = [
    {
      key: 'generatedAt', header: 'Generated at', sortValue: (r) => r.generatedAt,
      render: (r) => <span className={styles.num}>{formatDateTime(r.generatedAt)}</span>,
    },
    {
      key: 'format', header: 'Format',
      render: (r) => <Badge color={FORMAT_COLOR[r.format] ?? 'slate'}>{r.format}</Badge>,
    },
    {
      key: 'rowCount', header: 'Rows', align: 'right', sortValue: (r) => r.rowCount,
      render: (r) => <span className={styles.num}>{formatNumber(r.rowCount)}</span>,
    },
    {
      key: 'recipients', header: 'Recipients', align: 'right', sortValue: (r) => r.recipients,
      render: (r) => <span className={styles.num}>{formatNumber(r.recipients)}</span>,
    },
    {
      key: 'status', header: 'Status',
      render: (r) => <Badge color={RUN_COLOR[r.status] ?? 'slate'}>{titleCase(r.status)}</Badge>,
    },
    {
      key: 'note', header: 'Note',
      render: (r) => <span className={styles.cellSub}>{r.note || '—'}</span>,
    },
  ];

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={620}
      title={data?.name ?? 'Schedule'}
      subtitle={data ? `${titleCase(data.cadence)} · ${data.format}` : undefined}
    >
      {isLoading || !data ? (
        <p className={styles.cellSub}>Loading schedule…</p>
      ) : (
        <div className={styles.drawerBody}>
          {canWrite && (
            <div className={styles.drawerActions}>
              <Button size="sm" variant="primary" icon={<Send size={13} />} loading={running} onClick={() => onRun(data.id)}>
                Run now
              </Button>
            </div>
          )}

          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt>Cadence</dt>
              <dd><Badge color={CADENCE_COLOR[data.cadence] ?? 'slate'}>{titleCase(data.cadence)}</Badge></dd>
            </div>
            <div className={styles.fact}>
              <dt>Format</dt>
              <dd><Badge color={FORMAT_COLOR[data.format] ?? 'slate'}>{data.format}</Badge></dd>
            </div>
            <div className={styles.fact}>
              <dt>Status</dt>
              <dd><Badge color={data.enabled ? 'green' : 'slate'}>{data.enabled ? 'Active' : 'Paused'}</Badge></dd>
            </div>
            <div className={styles.fact}>
              <dt>Report</dt>
              <dd>{data.definitionName ?? 'Ad-hoc report'}</dd>
            </div>
            <div className={styles.fact}>
              <dt>Next run</dt>
              <dd>{data.nextRunAt ? formatDate(data.nextRunAt) : '—'}</dd>
            </div>
            <div className={styles.fact}>
              <dt>Last run</dt>
              <dd>{data.lastRunAt ? formatDate(data.lastRunAt) : '—'}</dd>
            </div>
            <div className={styles.fact}>
              <dt>Distribution list</dt>
              <dd>{data.listName ?? '—'}</dd>
            </div>
          </dl>

          <div>
            <h3 className={styles.sectionHeading}><Mail size={14} aria-hidden /> Recipients</h3>
            {data.recipients.length ? (
              <div className={styles.chips}>
                {data.recipients.map((r) => <span key={r} className={styles.chip}>{r}</span>)}
              </div>
            ) : (
              <p className={styles.cellSub}>No recipients configured for this schedule.</p>
            )}
          </div>

          <div>
            <h3 className={styles.sectionHeading}><FileSpreadsheet size={14} aria-hidden /> Run history</h3>
            <Table
              columns={runColumns}
              rows={data.runs}
              rowKey={(r) => r.id}
              empty={<EmptyState icon={<FileText size={18} />} title="No runs yet" message="This schedule has not generated any reports." />}
              skeletonRows={3}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* ---------------- New schedule ---------------- */
function NewScheduleModal({
  open, onClose, lists,
}: { open: boolean; onClose: () => void; lists: DistributionList[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', cadence: 'MONTHLY' as Cadence, format: 'PDF' as OutputFormat, distributionListId: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const reset = () => setF({ name: '', cadence: 'MONTHLY', format: 'PDF', distributionListId: '' });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string }>('/api/scheduled-reports', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-reports'] });
      toast.success('Schedule created');
      onClose();
      reset();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the schedule.'),
  });

  const submit = () => {
    setError(null);
    create.mutate({
      name: f.name.trim(),
      cadence: f.cadence,
      format: f.format,
      distributionListId: f.distributionListId || undefined,
    });
  };

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="New schedule"
      description="Schedule a report to run automatically and deliver it to a distribution list."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!f.name.trim()}>Create schedule</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Schedule">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Name" value={f.name} onChange={set('name')} required placeholder="e.g. Monthly technical account statement" />
          </div>
          <FormField label="Cadence">
            <Select value={f.cadence} onChange={(e) => set('cadence')(e.target.value)}>
              {CADENCES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
            </Select>
          </FormField>
          <FormField label="Output format">
            <Select value={f.format} onChange={(e) => set('format')(e.target.value)}>
              {FORMATS.map((fmt) => <option key={fmt} value={fmt}>{fmt}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Distribution" description="Optionally deliver each run to a recipient list.">
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField label="Distribution list" hint="Leave empty to configure recipients later.">
              <Select value={f.distributionListId} onChange={(e) => set('distributionListId')(e.target.value)}>
                <option value="">No distribution list</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.recipientCount})</option>)}
              </Select>
            </FormField>
          </div>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/* ---------------- New distribution list ---------------- */
function NewListModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', description: '', recipients: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const parsed = parseRecipients(f.recipients);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string }>('/api/distribution-lists', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-reports'] });
      toast.success('Distribution list created');
      onClose();
      setF({ name: '', description: '', recipients: '' });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the distribution list.'),
  });

  const submit = () => {
    setError(null);
    create.mutate({
      name: f.name.trim(),
      description: f.description.trim() || undefined,
      recipients: parsed,
    });
  };

  return (
    <Modal
      open={open} onClose={onClose} size="md"
      title="New distribution list"
      description="Group email recipients so scheduled reports can be delivered to them in one place."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!f.name.trim() || parsed.length === 0}>Create list</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="List">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Name" value={f.name} onChange={set('name')} required placeholder="e.g. Cedent finance team" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Description" value={f.description} onChange={set('description')} placeholder="Optional context" />
          </div>
        </FormSection>

        <FormSection title="Recipients" description="Enter email addresses separated by commas or new lines.">
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField
              label="Email addresses"
              hint={parsed.length ? `${parsed.length} recipient${parsed.length === 1 ? '' : 's'} parsed.` : 'At least one recipient is required.'}
            >
              <Textarea
                rows={5}
                value={f.recipients}
                onChange={(e) => set('recipients')(e.target.value)}
                placeholder={'finance@cedent.example\nops@cedent.example, cfo@cedent.example'}
              />
            </FormField>
          </div>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
