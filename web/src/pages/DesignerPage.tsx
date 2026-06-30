/**
 * Designer surfaces (brief §10.3): the no-code Workflow Designer and Business
 * Rules console. Both browse versioned `config_document` definitions and exercise
 * the server-side pure interpreters live - a workflow simulator (pick a state +
 * event, see the resulting transition) and a rules tester (supply a JSON context,
 * see which rules fire and what they emit). Authoring is gated on `config:write`.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Select, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './DesignerPage.module.css';

interface DefSummary { key: string; version: number; status: string; name?: string | null; createdAt?: string | null }
interface Transition { event: string; from: string; to: string; permission?: string; label?: string }
interface WorkflowBody { key: string; name?: string; initial: string; states: string[]; finalStates?: string[]; transitions: Transition[] }
interface RuleBody { key: string; name?: string; rules: { id: string; name?: string; when: unknown; then: { type: string; target?: string; message?: string; value?: unknown }[] }[] }
interface Version<T> { id: string; key: string; version: number; status: string; body: T; createdAt?: string | null }

function statusColor(s: string): 'green' | 'amber' | 'gray' {
  return s === 'published' ? 'green' : s === 'draft' ? 'amber' : 'gray';
}

export function DesignerPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('config:write');
  const [tab, setTab] = useState('workflows');

  return (
    <>
      <PageHeader
        title="Designer"
        description="Author metadata-driven workflows and business rules - interpreted, never executed as code."
      />
      <Card>
        <Tabs
          tabs={[{ id: 'workflows', label: 'Workflow Designer' }, { id: 'rules', label: 'Business Rules' }]}
          active={tab}
          onChange={setTab}
        />
        <div className={styles.tabBody}>
          {tab === 'workflows' ? <Workflows canWrite={canWrite} /> : <Rules canWrite={canWrite} />}
        </div>
      </Card>
    </>
  );
}

/* ----------------------------- Workflows ----------------------------- */

function Workflows({ canWrite }: { canWrite: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['designer-workflows'], queryFn: () => api<{ definitions: DefSummary[] }>('/api/designer/workflows') });

  const cols: Column<DefSummary>[] = [
    { key: 'key', header: 'Key', render: (r) => <span className={shared.cellRef}>{r.key}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className={shared.cellMain}>{r.name ?? r.key}</span> },
    { key: 'version', header: 'Version', align: 'right', render: (r) => `v${r.version}` },
    { key: 'status', header: 'Status', render: (r) => <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> },
  ];

  return (
    <div className={styles.stack5}>
      <div>
        <p className={`${shared.cellSub} ${styles.introText}`}>
          {canWrite ? 'Select a workflow to inspect its state machine and simulate transitions.' : 'You can view and simulate workflows. Authoring requires the config:write permission.'}
        </p>
        {list.isLoading ? <PageLoader label="Loading workflows…" /> : (
          <Table columns={cols} rows={list.data?.definitions} rowKey={(r) => r.key} onRowClick={(r) => setSelected(r.key)}
            empty={<EmptyState title="No workflows" message="No workflow definitions have been authored." />} />
        )}
      </div>
      {selected && <WorkflowDetail key={selected} wfKey={selected} />}
    </div>
  );
}

function WorkflowDetail({ wfKey }: { wfKey: string }) {
  const detail = useQuery({ queryKey: ['designer-workflow', wfKey], queryFn: () => api<{ key: string; versions: Version<WorkflowBody>[] }>(`/api/designer/workflows/${wfKey}`) });
  const current = detail.data?.versions.find((v) => v.status === 'published') ?? detail.data?.versions[0];
  const body = current?.body;

  const [state, setState] = useState<string>('');
  const [event, setEvent] = useState<string>('');
  const [result, setResult] = useState<{ ok: boolean; state: string; reason?: string; available?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const activeState = state || body?.initial || '';
  const events = useMemo(() => (body?.transitions ?? []).filter((t) => t.from === activeState).map((t) => t.event), [body, activeState]);

  const simulate = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const r = await api<{ result: { ok: boolean; state: string; reason?: string }; available: string[] }>(
        '/api/designer/workflows/simulate', { body: { key: wfKey, state: activeState, event: event || events[0] } },
      );
      setResult({ ...r.result, available: r.available });
      if (r.result.ok) setState(r.result.state);
    } finally {
      setBusy(false);
    }
  };

  if (detail.isLoading) return <PageLoader label="Loading definition…" />;
  if (!body) return null;

  return (
    <Card>
      <CardHeader title={body.name ?? body.key} subtitle={`Initial: ${body.initial} · ${body.states.length} states · ${body.transitions.length} transitions`} />
      <div className={styles.detailBody}>
        <div>
          <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}>States</h4>
          <div className={styles.badgeRow}>
            {body.states.map((st) => (
              <Badge key={st} color={st === activeState ? 'blue' : (body.finalStates ?? []).includes(st) ? 'gray' : 'slate'}>{st}</Badge>
            ))}
          </div>
        </div>

        <div>
          <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}>Transitions</h4>
          <Table
            columns={[
              { key: 'event', header: 'Event', render: (t: Transition) => <span className={shared.cellRef}>{t.event}</span> },
              { key: 'from', header: 'From', render: (t: Transition) => t.from },
              { key: 'to', header: 'To', render: (t: Transition) => t.to },
              { key: 'perm', header: 'Permission', render: (t: Transition) => t.permission ?? '-' },
            ]}
            rows={body.transitions}
            rowKey={(t) => `${t.event}:${t.from}:${t.to}`}
          />
        </div>

        <div className={styles.simulator}>
          <h4 className={`${shared.cellMain} ${styles.simHeading}`}>Simulator</h4>
          <div className={styles.toolbar}>
            <div className={styles.field}>
              <FormField label="Current state">
                <Select value={activeState} onChange={(e) => { setState(e.target.value); setEvent(''); setResult(null); }}>
                  {body.states.map((st) => <option key={st} value={st}>{st}</option>)}
                </Select>
              </FormField>
            </div>
            <div className={styles.field}>
              <FormField label="Event">
                <Select value={event || events[0] || ''} onChange={(e) => setEvent(e.target.value)}>
                  {events.length === 0 ? <option value="">- terminal -</option> : events.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
                </Select>
              </FormField>
            </div>
            <Button variant="primary" onClick={simulate} loading={busy} disabled={events.length === 0}>Fire event</Button>
          </div>
          {result && (
            <p className={`${shared.cellSub} ${styles.simResult}`}>
              {result.ok
                ? <>✓ Transitioned to <strong>{result.state}</strong>. Next available: {result.available?.join(', ') || 'none (terminal)'}.</>
                : <>✗ Rejected: {result.reason}</>}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------- Rules ------------------------------- */

function Rules({ canWrite }: { canWrite: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['designer-rules'], queryFn: () => api<{ definitions: DefSummary[] }>('/api/designer/rules') });

  const cols: Column<DefSummary>[] = [
    { key: 'key', header: 'Key', render: (r) => <span className={shared.cellRef}>{r.key}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className={shared.cellMain}>{r.name ?? r.key}</span> },
    { key: 'version', header: 'Version', align: 'right', render: (r) => `v${r.version}` },
    { key: 'status', header: 'Status', render: (r) => <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> },
  ];

  return (
    <div className={styles.stack5}>
      <div>
        <p className={`${shared.cellSub} ${styles.introText}`}>
          {canWrite ? 'Select a rule set to inspect its rules and test it against a sample context.' : 'You can view and test rule sets. Authoring requires the config:write permission.'}
        </p>
        {list.isLoading ? <PageLoader label="Loading rules…" /> : (
          <Table columns={cols} rows={list.data?.definitions} rowKey={(r) => r.key} onRowClick={(r) => setSelected(r.key)}
            empty={<EmptyState title="No rule sets" message="No business rule sets have been authored." />} />
        )}
      </div>
      {selected && <RuleDetail key={selected} ruleKey={selected} />}
    </div>
  );
}

interface Outcome { matched: string[]; errors: string[]; warnings: string[]; set: Record<string, unknown>; flags: string[]; routes: string[]; ok: boolean }

function RuleDetail({ ruleKey }: { ruleKey: string }) {
  const detail = useQuery({ queryKey: ['designer-rule', ruleKey], queryFn: () => api<{ key: string; versions: Version<RuleBody>[] }>(`/api/designer/rules/${ruleKey}`) });
  const current = detail.data?.versions.find((v) => v.status === 'published') ?? detail.data?.versions[0];
  const body = current?.body;

  const [context, setContext] = useState('{\n  "premiumMinor": 25000000,\n  "lob": "PROPERTY"\n}');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const evaluate = async () => {
    setError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(context); } catch { setError('Context is not valid JSON.'); return; }
    setBusy(true);
    try {
      const r = await api<{ outcome: Outcome }>('/api/designer/rules/evaluate', { body: { key: ruleKey, context: parsed } });
      setOutcome(r.outcome);
    } finally {
      setBusy(false);
    }
  };

  if (detail.isLoading) return <PageLoader label="Loading rule set…" />;
  if (!body) return null;

  return (
    <Card>
      <CardHeader title={body.name ?? body.key} subtitle={`${body.rules.length} rules`} />
      <div className={styles.detailBody}>
        <Table
          columns={[
            { key: 'id', header: 'Rule', render: (r: RuleBody['rules'][number]) => <span className={shared.cellRef}>{r.id}</span> },
            { key: 'effects', header: 'Effects', render: (r: RuleBody['rules'][number]) => r.then.map((e) => e.type).join(', ') },
          ]}
          rows={body.rules}
          rowKey={(r) => r.id}
        />

        <div className={styles.simulator}>
          <h4 className={`${shared.cellMain} ${styles.simHeading}`}>Tester</h4>
          <FormField label="Context (JSON)" error={error ?? undefined}>
            <Textarea rows={6} value={context} onChange={(e) => setContext(e.target.value)} className={styles.contextMono} />
          </FormField>
          <div className={styles.evaluateRow}>
            <Button variant="primary" onClick={evaluate} loading={busy}>Evaluate</Button>
          </div>
          {outcome && (
            <div className={styles.outcome}>
              <div><Badge color={outcome.ok ? 'green' : 'red'}>{outcome.ok ? 'Passes' : 'Blocked'}</Badge></div>
              {outcome.matched.length > 0 && <p className={shared.cellSub}>Matched: {outcome.matched.join(', ')}</p>}
              {outcome.errors.map((e, i) => <p key={i} className={`${shared.cellSub} ${styles.errorText}`}>Error: {e}</p>)}
              {outcome.warnings.map((w, i) => <p key={i} className={`${shared.cellSub} ${styles.warningText}`}>Warning: {w}</p>)}
              {outcome.routes.length > 0 && <p className={shared.cellSub}>Routes: {outcome.routes.join(', ')}</p>}
              {outcome.flags.length > 0 && <p className={shared.cellSub}>Flags: {outcome.flags.join(', ')}</p>}
              {Object.keys(outcome.set).length > 0 && <p className={shared.cellSub}>Defaults: {JSON.stringify(outcome.set)}</p>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
