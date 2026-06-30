import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField, Textarea } from '../components/Form';
import { formatMoney, formatDate, titleCase } from '../lib/format';
import { Target, ClipboardList } from 'lucide-react';
import shared from './shared.module.css';
import styles from './CrmPage.module.css';

/* ---------------- Types ---------------- */
interface PipelineStage {
  stage: string;
  count: number;
  totalMinor: number;
  weightedMinor: number;
}
interface PipelineResponse {
  pipeline: PipelineStage[];
  totalWeightedMinor: number;
}
interface Opportunity {
  id: string;
  partyName: string;
  name: string;
  stage: string;
  amount_minor: number;
  currency: string;
  probability: number;
  expected_close: string | null;
  status: string;
}
interface OpportunitiesResponse { opportunities: Opportunity[]; }
interface Activity {
  id: string;
  partyName: string;
  kind: string;
  subject: string;
  body: string | null;
  due_date: string | null;
  completed: boolean;
  created_at: string;
}
interface ActivitiesResponse { activities: Activity[]; }
interface PartyOption { id: string; shortName: string | null; legalName: string; }
interface PartiesResponse { parties: PartyOption[]; }

const STAGES = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'];
const OPP_STATUSES = ['OPEN', 'WON', 'LOST'];
const ACTIVITY_KINDS = ['call', 'email', 'meeting', 'note', 'task'];

/* ---------------- Data hooks ---------------- */
function usePipeline() {
  return useQuery({
    queryKey: ['crm', 'pipeline'],
    queryFn: () => api<PipelineResponse>('/api/crm/pipeline'),
  });
}
function useOpportunities(params: { stage?: string; status?: string }) {
  return useQuery({
    queryKey: ['crm', 'opportunities', params],
    queryFn: () => api<OpportunitiesResponse>(`/api/crm/opportunities${qs(params)}`),
  });
}
function useActivities(params: { partyId?: string; completed?: string }) {
  return useQuery({
    queryKey: ['crm', 'activities', params],
    queryFn: () => api<ActivitiesResponse>(`/api/crm/activities${qs(params)}`),
  });
}
function usePartyOptions() {
  return useQuery({
    queryKey: ['parties', 'options'],
    queryFn: () => api<PartiesResponse>('/api/parties'),
    staleTime: 5 * 60 * 1000,
  });
}

interface NewOppBody {
  partyId: string; name: string; stage?: string; amount: number;
  currency: string; probability?: number; expectedClose?: string;
}
function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewOppBody) => api('/api/crm/opportunities', { body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm'] }); },
  });
}
function useUpdateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; stage?: string; status?: string; probability?: number }) =>
      api(`/api/crm/opportunities/${id}`, { body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm'] }); },
  });
}

interface NewActivityBody {
  partyId: string; kind: string; subject: string; body?: string; dueDate?: string;
}
function useCreateActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewActivityBody) => api('/api/crm/activities', { body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm', 'activities'] }); },
  });
}
function useCompleteActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/crm/activities/${id}/complete`, { body: {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm', 'activities'] }); },
  });
}

const TABS = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'activities', label: 'Activities' },
];

export function CrmPage() {
  const [tab, setTab] = useState('pipeline');

  return (
    <>
      <PageHeader
        title="CRM"
        description="Sales pipeline, opportunities and counterparty activities."
      />

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'pipeline' && <PipelineTab />}
        {tab === 'activities' && <ActivitiesTab />}
      </Card>
    </>
  );
}

/* ---------------- Pipeline tab ---------------- */
function PipelineTab() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('crm:write');
  const { data: pipeline, isLoading: pipelineLoading } = usePipeline();
  const [stage, setStage] = useState('');
  const [status, setStatus] = useState('');
  const { data: opps, isLoading: oppsLoading } = useOpportunities({
    stage: stage || undefined,
    status: status || undefined,
  });
  const [showNew, setShowNew] = useState(false);

  const stages = pipeline?.pipeline ?? [];
  const maxWeighted = Math.max(1, ...stages.map((s) => s.weightedMinor));

  const columns: Column<Opportunity>[] = [
    {
      key: 'name', header: 'Opportunity', sortValue: (o) => o.name,
      render: (o) => (
        <div>
          <div className={shared.cellMain}>{o.name}</div>
          <div className={shared.cellSub}>{o.partyName}</div>
        </div>
      ),
    },
    { key: 'stage', header: 'Stage', sortValue: (o) => o.stage, render: (o) => <StatusPill status={o.stage} /> },
    {
      key: 'amount', header: 'Amount', align: 'right', sortValue: (o) => o.amount_minor,
      render: (o) => <span className={shared.money}>{formatMoney(o.amount_minor, o.currency)}</span>,
    },
    {
      key: 'probability', header: 'Prob.', align: 'right', sortValue: (o) => o.probability,
      render: (o) => `${Math.round((o.probability <= 1 ? o.probability * 100 : o.probability))}%`,
    },
    { key: 'close', header: 'Expected close', sortValue: (o) => o.expected_close ?? '', render: (o) => formatDate(o.expected_close) },
    {
      key: 'status', header: 'Status', align: 'right', sortValue: (o) => o.status,
      render: (o) => (canWrite ? <AdvanceCell opp={o} /> : <StatusPill status={o.status} />),
    },
  ];

  return (
    <>
      <div className={styles.tabBody}>
        <CardHeader
          title="Weighted pipeline"
          subtitle="Opportunity value weighted by win probability across stages."
        />
        <div className={styles.headlineKpi}>
          <span className={styles.headlineLabel}>Total weighted</span>
          <span className={styles.headlineValue}>
            {pipelineLoading ? '…' : formatMoney(pipeline?.totalWeightedMinor ?? 0)}
          </span>
        </div>

        <div className={styles.kpiGrid}>
          {(pipelineLoading ? Array.from({ length: 4 }) : stages).map((s, i) => {
            const st = s as PipelineStage | undefined;
            return (
              <KpiCard
                key={st?.stage ?? `sk-${i}`}
                loading={pipelineLoading}
                label={st ? titleCase(st.stage) : ''}
                value={st ? formatMoney(st.totalMinor) : ''}
                hint={st ? `${st.count} open · ${formatMoney(st.weightedMinor)} weighted` : undefined}
              />
            );
          })}
        </div>

        {!pipelineLoading && stages.length > 0 && (
          <div className={styles.stageBars}>
            {stages.map((s) => (
              <div key={s.stage} className={styles.stageRow}>
                <span className={styles.stageLabel}>{titleCase(s.stage)}</span>
                <div className={styles.track}>
                  <div className={styles.bar} style={{ width: `${(s.weightedMinor / maxWeighted) * 100}%` }} />
                </div>
                <span className={styles.stageValue}>{formatMoney(s.weightedMinor)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }} className={shared.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Stage</span>
          <Select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
            <option value="">All</option>
            {STAGES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All</option>
            {OPP_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New opportunity</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={opps?.opportunities}
        loading={oppsLoading}
        rowKey={(o) => o.id}
        empty={<EmptyState title="No opportunities" message="No opportunities match the current filter." icon={<Target size={16} />} />}
      />

      <NewOpportunityModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function AdvanceCell({ opp }: { opp: Opportunity }) {
  const toast = useToast();
  const update = useUpdateOpportunity();

  const onStage = async (next: string) => {
    if (next === opp.stage) return;
    try {
      await update.mutateAsync({ id: opp.id, stage: next });
      toast.success(`Moved “${opp.name}” to ${titleCase(next)}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the opportunity.');
    }
  };

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: 'inline-block' }}>
      <Select
        value={opp.stage}
        onChange={(e) => onStage(e.target.value)}
        aria-label={`Stage for ${opp.name}`}
        disabled={update.isPending}
      >
        {STAGES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
      </Select>
    </div>
  );
}

function NewOpportunityModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateOpportunity();
  const { data: parties } = usePartyOptions();
  const partyList = parties?.parties ?? [];

  const [partyId, setPartyId] = useState('');
  const [name, setName] = useState('');
  const [stage, setStage] = useState('LEAD');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [probability, setProbability] = useState('');
  const [expectedClose, setExpectedClose] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPartyId(''); setName(''); setStage('LEAD'); setAmount('');
    setCurrency('USD'); setProbability(''); setExpectedClose(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const amt = Number(amount);
    if (!partyId) { setError('Select a party.'); return; }
    if (!name.trim()) { setError('Enter an opportunity name.'); return; }
    if (Number.isNaN(amt) || amt <= 0) { setError('Enter an amount.'); return; }
    const prob = probability === '' ? undefined : Number(probability);
    try {
      await create.mutateAsync({
        partyId,
        name: name.trim(),
        stage,
        amount: amt,
        currency,
        probability: prob,
        expectedClose: expectedClose || undefined,
      });
      toast.success(`Opportunity “${name.trim()}” created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the opportunity.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New opportunity"
      description="Amount is entered in major currency units."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!partyId || !name.trim() || !amount}>Create</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Party" required>
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">Select a party…</option>
            {partyList.map((p) => (
              <option key={p.id} value={p.id}>{p.shortName ?? p.legalName}</option>
            ))}
          </Select>
        </FormField>
        <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. 2026 property cat renewal" />
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Stage" required>
            <Select value={stage} onChange={(e) => setStage(e.target.value)}>
              {STAGES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {['USD', 'EUR', 'GBP', 'JPY', 'CHF'].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </FormField>
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Amount (major units)" required>
            <Input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500000" />
          </FormField>
          <FormField label="Probability (%)">
            <Input type="number" min="0" max="100" step="any" value={probability} onChange={(e) => setProbability(e.target.value)} placeholder="e.g. 60" />
          </FormField>
        </div>
        <FormField label="Expected close">
          <Input type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Activities tab ---------------- */
function ActivitiesTab() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('crm:write');
  const { data: parties } = usePartyOptions();
  const partyList = parties?.parties ?? [];
  const [partyId, setPartyId] = useState('');
  const { data, isLoading } = useActivities({ partyId: partyId || undefined });
  const [showNew, setShowNew] = useState(false);

  const columns: Column<Activity>[] = [
    { key: 'kind', header: 'Kind', sortValue: (a) => a.kind, render: (a) => <StatusPill status={a.kind} /> },
    {
      key: 'subject', header: 'Subject', sortValue: (a) => a.subject,
      render: (a) => (
        <div>
          <div className={shared.cellMain}>{a.subject}</div>
          <div className={shared.cellSub}>{a.partyName}</div>
        </div>
      ),
    },
    { key: 'due', header: 'Due', sortValue: (a) => a.due_date ?? '', render: (a) => formatDate(a.due_date) },
    {
      key: 'completed', header: 'Completed', sortValue: (a) => (a.completed ? 1 : 0),
      render: (a) => <Badge color={a.completed ? 'green' : 'slate'}>{a.completed ? 'Done' : 'Open'}</Badge>,
    },
    {
      key: 'actions', header: '', align: 'right',
      render: (a) => (!a.completed && canWrite ? <CompleteCell activity={a} /> : null),
    },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }} className={shared.toolbar}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Party</span>
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Filter by party">
            <option value="">All</option>
            {partyList.map((p) => <option key={p.id} value={p.id}>{p.shortName ?? p.legalName}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>Log activity</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.activities}
        loading={isLoading}
        rowKey={(a) => a.id}
        empty={<EmptyState title="No activities" message="No activities logged for this filter." icon={<ClipboardList size={16} />} />}
      />

      <LogActivityModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function CompleteCell({ activity }: { activity: Activity }) {
  const toast = useToast();
  const complete = useCompleteActivity();

  const onComplete = async () => {
    try {
      await complete.mutateAsync(activity.id);
      toast.success('Activity completed');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not complete the activity.');
    }
  };

  return (
    <Button size="sm" variant="secondary" loading={complete.isPending} onClick={onComplete}>Complete</Button>
  );
}

function LogActivityModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateActivity();
  const { data: parties } = usePartyOptions();
  const partyList = parties?.parties ?? [];

  const [partyId, setPartyId] = useState('');
  const [kind, setKind] = useState('call');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPartyId(''); setKind('call'); setSubject(''); setBody(''); setDueDate(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!partyId) { setError('Select a party.'); return; }
    if (!subject.trim()) { setError('Enter a subject.'); return; }
    try {
      await create.mutateAsync({
        partyId,
        kind,
        subject: subject.trim(),
        body: body.trim() || undefined,
        dueDate: dueDate || undefined,
      });
      toast.success('Activity logged');
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log the activity.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Log activity"
      description="Record a call, email, meeting, note or task against a party."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!partyId || !subject.trim()}>Log activity</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Party" required>
            <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">Select a party…</option>
              {partyList.map((p) => <option key={p.id} value={p.id}>{p.shortName ?? p.legalName}</option>)}
            </Select>
          </FormField>
          <FormField label="Kind" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
            </Select>
          </FormField>
        </div>
        <TextField label="Subject" value={subject} onChange={setSubject} required placeholder="e.g. Renewal call with broker" />
        <FormField label="Notes">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Optional details…" />
        </FormField>
        <FormField label="Due date">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
