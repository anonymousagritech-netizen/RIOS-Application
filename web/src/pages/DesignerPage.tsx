/**
 * Designer surfaces (brief §10.3): the no-code Workflow Designer and Business
 * Rules console. The Workflow tab is now a genuine authoring surface - name a
 * workflow, add ordered states, mark the initial + final states, and define the
 * allowed transitions (from → to, event, optional required permission) - that
 * round-trips to the versioned `config_document` store via the designer API.
 * Saved definitions list, open for inspection, simulate live (pick a state +
 * event, see the resulting transition), and re-open to edit. The Business Rules
 * tab browses + tests rule sets; authoring rules lives in the Automation Studio.
 * Authoring is gated on `config:write`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Input, Select, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './DesignerPage.module.css';

interface DefSummary { key: string; version: number; status: string; name?: string | null; createdAt?: string | null }
interface Transition { event: string; from: string; to: string; permission?: string; label?: string }
interface WorkflowBody { key: string; name?: string; initial: string; states: string[]; finalStates?: string[]; transitions: Transition[] }
interface RuleBody { key: string; name?: string; rules: { id: string; name?: string; when: unknown; then: { type: string; target?: string; message?: string; value?: unknown }[] }[] }
interface Version<T> { id: string; key: string; version: number; status: string; body: T; createdAt?: string | null }
interface ValidationIssue { code: string; message: string }

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
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Designer' }]}
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
  // null = not authoring; { key: undefined } = new; { key } = editing an existing one.
  const [editing, setEditing] = useState<{ key?: string } | null>(null);
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
        <div className={styles.listHead}>
          <p className={`${shared.cellSub} ${styles.introText}`}>
            {canWrite ? 'Author a workflow as data, or select one to inspect its state machine and simulate transitions.' : 'You can view and simulate workflows. Authoring requires the config:write permission.'}
          </p>
          {canWrite && !editing && (
            <Button variant="primary" size="sm" icon={<Plus size={16} />} onClick={() => { setSelected(null); setEditing({}); }}>New workflow</Button>
          )}
        </div>
        {list.isLoading ? <PageLoader label="Loading workflows…" /> : (
          <Table columns={cols} rows={list.data?.definitions} rowKey={(r) => r.key} onRowClick={(r) => { setEditing(null); setSelected(r.key); }}
            empty={<EmptyState title="No workflows" message="No workflow definitions have been authored." />} />
        )}
      </div>
      {editing ? (
        <WorkflowComposer
          key={editing.key ?? '__new__'}
          editKey={editing.key}
          onCancel={() => setEditing(null)}
          onSaved={(savedKey) => { setEditing(null); setSelected(savedKey); }}
        />
      ) : selected ? (
        <WorkflowDetail key={selected} wfKey={selected} canWrite={canWrite} onEdit={() => { setSelected(null); setEditing({ key: selected }); }} />
      ) : null}
    </div>
  );
}

function WorkflowDetail({ wfKey, canWrite, onEdit }: { wfKey: string; canWrite: boolean; onEdit: () => void }) {
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
      <CardHeader
        title={body.name ?? body.key}
        subtitle={`Initial: ${body.initial} · ${body.states.length} states · ${body.transitions.length} transitions`}
        actions={canWrite ? <Button variant="secondary" size="sm" icon={<Pencil size={15} />} onClick={onEdit}>Edit</Button> : undefined}
      />
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

/* -------------------------- Workflow composer -------------------------- */

const slug = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function WorkflowComposer({ editKey, onCancel, onSaved }: { editKey?: string; onCancel: () => void; onSaved: (key: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({
    queryKey: ['designer-workflow', editKey],
    queryFn: () => api<{ key: string; versions: Version<WorkflowBody>[] }>(`/api/designer/workflows/${editKey}`),
    enabled: !!editKey,
  });

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [states, setStates] = useState<string[]>(['DRAFT', 'SUBMITTED', 'APPROVED']);
  const [initial, setInitial] = useState('DRAFT');
  const [finalStates, setFinalStates] = useState<string[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([
    { event: 'submit', from: 'DRAFT', to: 'SUBMITTED' },
    { event: 'approve', from: 'SUBMITTED', to: 'APPROVED', permission: 'workflow:write' },
  ]);
  const [newState, setNewState] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const seeded = useRef(false);

  // Seed the editor from the existing published/latest version once it loads.
  useEffect(() => {
    if (!editKey || seeded.current) return;
    const versions = existing.data?.versions;
    if (!versions) return;
    const body = (versions.find((v) => v.status === 'published') ?? versions[0])?.body;
    if (!body) return;
    seeded.current = true;
    setKey(body.key);
    setName(body.name ?? '');
    setStates(body.states ?? []);
    setInitial(body.initial ?? body.states?.[0] ?? '');
    setFinalStates(body.finalStates ?? []);
    setTransitions(body.transitions ?? []);
  }, [editKey, existing.data]);

  const addState = () => {
    const s = slug(newState);
    if (!s || states.includes(s)) return;
    setStates((prev) => [...prev, s]);
    if (!initial) setInitial(s);
    setNewState('');
  };
  const removeState = (s: string) => {
    setStates((prev) => prev.filter((x) => x !== s));
    setFinalStates((prev) => prev.filter((x) => x !== s));
    setTransitions((prev) => prev.filter((t) => t.from !== s && t.to !== s));
    if (initial === s) setInitial(states.filter((x) => x !== s)[0] ?? '');
  };
  const moveState = (i: number, dir: -1 | 1) => {
    setStates((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };
  const toggleFinal = (s: string) => setFinalStates((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const setTransition = (i: number, patch: Partial<Transition>) =>
    setTransitions((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addTransition = () => setTransitions((prev) => [...prev, { event: '', from: states[0] ?? '', to: states[0] ?? '' }]);
  const removeTransition = (i: number) => setTransitions((prev) => prev.filter((_, idx) => idx !== i));

  const save = useMutation({
    mutationFn: (publish: boolean) => {
      const cleanTransitions = transitions
        .filter((t) => t.event.trim() && t.from && t.to)
        .map((t) => ({ event: t.event.trim(), from: t.from, to: t.to, ...(t.permission?.trim() ? { permission: t.permission.trim() } : {}) }));
      return api<{ key: string; version: number; status: string }>('/api/designer/workflows', {
        body: {
          key,
          name: name.trim() || undefined,
          publish,
          body: { initial, states, finalStates, transitions: cleanTransitions },
        },
      });
    },
    onSuccess: (_r, publish) => {
      setIssues([]);
      toast.success(publish ? `Published ${key}` : `Saved draft ${key}`);
      qc.invalidateQueries({ queryKey: ['designer-workflows'] });
      qc.invalidateQueries({ queryKey: ['designer-workflow', key] });
      onSaved(key);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 422 && e.body && typeof e.body === 'object' && 'issues' in e.body) {
        setIssues((e.body as { issues: ValidationIssue[] }).issues ?? []);
        toast.error('Workflow has validation issues');
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Save failed');
      }
    },
  });

  const canSave = !!key.trim() && states.length > 0 && !!initial;

  if (editKey && existing.isLoading) return <PageLoader label="Loading definition…" />;

  return (
    <Card>
      <CardHeader
        title={editKey ? `Edit ${editKey}` : 'New workflow'}
        subtitle="Define states and the transitions between them. Saving publishes a new version of this definition."
        actions={<Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
      />
      <div className={styles.composer}>
        <div className={styles.composerGrid}>
          <FormField label="Key" hint="Stable identifier, e.g. treaty.lifecycle">
            <Input value={key} disabled={!!editKey} placeholder="treaty.lifecycle" onChange={(e) => setKey(e.target.value)} />
          </FormField>
          <FormField label="Name">
            <Input value={name} placeholder="Treaty lifecycle" onChange={(e) => setName(e.target.value)} />
          </FormField>
        </div>

        <div>
          <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}>States</h4>
          <div className={styles.rowList}>
            {states.map((s, i) => (
              <div key={s} className={styles.stateRow}>
                <span className={styles.stateName}>{s}</span>
                <label className={styles.checkInline}>
                  <input type="radio" name="wf-initial" checked={initial === s} onChange={() => setInitial(s)} /> initial
                </label>
                <label className={styles.checkInline}>
                  <input type="checkbox" checked={finalStates.includes(s)} onChange={() => toggleFinal(s)} /> final
                </label>
                <div className={styles.rowActions}>
                  <Button variant="ghost" size="sm" icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => moveState(i, -1)} aria-label="Move up" />
                  <Button variant="ghost" size="sm" icon={<ArrowDown size={14} />} disabled={i === states.length - 1} onClick={() => moveState(i, 1)} aria-label="Move down" />
                  <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => removeState(s)} aria-label="Remove" />
                </div>
              </div>
            ))}
          </div>
          <div className={styles.addRow}>
            <Input value={newState} placeholder="Add a state (e.g. BOUND)" onChange={(e) => setNewState(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addState(); } }} />
            <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={addState}>Add state</Button>
          </div>
        </div>

        <div>
          <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}>Transitions</h4>
          <div className={styles.rowList}>
            {transitions.map((t, i) => (
              <div key={i} className={styles.transitionRow}>
                <Input className={styles.tEvent} value={t.event} placeholder="event" onChange={(e) => setTransition(i, { event: e.target.value })} />
                <Select value={t.from} onChange={(e) => setTransition(i, { from: e.target.value })}>
                  {states.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
                <span className={styles.arrow}>→</span>
                <Select value={t.to} onChange={(e) => setTransition(i, { to: e.target.value })}>
                  {states.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
                <Input className={styles.tPerm} value={t.permission ?? ''} placeholder="permission (optional)" onChange={(e) => setTransition(i, { permission: e.target.value })} />
                <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => removeTransition(i)} aria-label="Remove transition" />
              </div>
            ))}
            {transitions.length === 0 && <p className={shared.cellSub}>No transitions yet.</p>}
          </div>
          <div className={styles.addRow}>
            <Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={addTransition} disabled={states.length === 0}>Add transition</Button>
          </div>
        </div>

        {issues.length > 0 && (
          <div className={styles.issues}>
            {issues.map((iss, idx) => <p key={idx} className={`${shared.cellSub} ${styles.errorText}`}>{iss.message}</p>)}
          </div>
        )}

        <div className={styles.composerActions}>
          <Button variant="secondary" onClick={() => save.mutate(false)} loading={save.isPending && !save.variables} disabled={!canSave || save.isPending}>Save draft</Button>
          <Button variant="primary" onClick={() => save.mutate(true)} loading={save.isPending && !!save.variables} disabled={!canSave || save.isPending}>Publish</Button>
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
          {canWrite ? 'Select a rule set to inspect its rules and test it against a sample context. Author new rules in the Automation Studio.' : 'You can view and test rule sets. Authoring requires the config:write permission.'}
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
