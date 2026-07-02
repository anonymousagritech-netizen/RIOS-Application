/**
 * AI Automation Studio + Assistant evaluation (brief §5, §12.7). The Rule studio
 * tab is a no-code authoring surface: define a trigger (event), one or more
 * conditions (field / operator / value) and one or more actions (the effect
 * types the rules engine supports), test them live against a sample context, and
 * save. Saving publishes a versioned business-rule definition
 * (POST /api/designer/rules) and, when a trigger is set, binds it to an
 * automation flow (POST /api/automation-studio/flows). The Flows tab runs those
 * trigger→rule→action pipelines; the Eval tab runs the assistant regression
 * suite. All exercise the live engines server-side.
 */

import { CircleCheckBig, FlaskConical, GitBranch, Hash, Pencil, Plus, Trash2, Workflow, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { Tabs } from '../components/Tabs';
import { FormField, Input, Select, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatNumber, formatPercent, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './AutomationStudioPage.module.css';

export function AutomationStudioPage() {
  const [tab, setTab] = useState('author');
  return (
    <>
      <PageHeader
        title="Automation Studio"
        description="Author trigger→condition→action rules, run flows, and the assistant evaluation suite."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Automation Studio' }]}
        actions={<Badge color="violet">Live engines</Badge>}
      />
      <Card>
        <Tabs
          tabs={[{ id: 'author', label: 'Rule studio' }, { id: 'flows', label: 'Automation flows' }, { id: 'eval', label: 'Assistant eval' }]}
          active={tab}
          onChange={setTab}
        />
        <div className={styles.tabBody}>
          {tab === 'author' ? <RuleStudio /> : tab === 'flows' ? <Flows /> : <Eval />}
        </div>
      </Card>
    </>
  );
}

interface Flow { key: string; name: string; body: { trigger: { eventType: string }; ruleSetKey: string; actions: { type: string; target?: string }[] } }
interface RunResult { dispatched: boolean; outcome: { ok: boolean; errors: string[]; matched: string[] }; actions: { type: string; target?: string }[] }

function Flows() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['automation-flows'], queryFn: () => api<{ flows: Flow[] }>('/api/automation-studio/flows') });
  const [flowKey, setFlowKey] = useState('');
  const [context, setContext] = useState('{\n  "premiumMinor": 500000,\n  "lob": "MOTOR",\n  "brokeragePct": 10\n}');
  const [result, setResult] = useState<RunResult | null>(null);

  const run = useMutation({
    mutationFn: (key: string) => api<RunResult>(`/api/automation-studio/flows/${key}/run`, { body: { context: JSON.parse(context) } }),
    onSuccess: (r) => setResult(r),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Run failed (check JSON)'),
  });

  if (q.isLoading) return <PageLoader label="Loading flows…" />;
  const active = flowKey || q.data?.flows[0]?.key || '';
  const flows = q.data?.flows ?? [];
  const triggerCount = new Set(flows.map((f) => f.body.trigger?.eventType).filter(Boolean)).size;
  const ruleSetCount = new Set(flows.map((f) => f.body.ruleSetKey).filter(Boolean)).size;

  const cols: Column<Flow>[] = [
    { key: 'name', header: 'Flow', render: (f) => <span className={shared.cellMain}>{f.name}</span> },
    { key: 'trigger', header: 'Trigger', render: (f) => <Badge color="violet">{f.body.trigger?.eventType}</Badge> },
    { key: 'rules', header: 'Rule set', render: (f) => <span className={shared.cellRef}>{f.body.ruleSetKey}</span> },
    { key: 'actions', header: 'Actions', render: (f) => (f.body.actions ?? []).map((a) => a.type).join(', ') },
  ];

  return (
    <div className={styles.sectionWide}>
      <div className={shared.kpiGrid}>
        <KpiCard label="Flows" value={formatNumber(flows.length)} hint="Configured automations" icon={<Workflow size={20} />} accent="var(--primary)" />
        <KpiCard label="Triggers" value={formatNumber(triggerCount)} hint="Distinct event types" icon={<Zap size={20} />} accent="var(--accent-orange)" />
        <KpiCard label="Rule sets" value={formatNumber(ruleSetCount)} hint="Referenced rule sets" icon={<GitBranch size={20} />} accent="var(--accent-violet)" />
      </div>
      <Card padded={false}>
        <div className={styles.cardHead}>
          <CardHeader title="Automation flows" subtitle="Trigger → rule set → action pipelines defined for this tenant." />
        </div>
        <Table columns={cols} rows={q.data?.flows} rowKey={(f) => f.key} empty={<EmptyState title="No flows" message="No automation flows defined." icon={<Workflow size={28} />} />} />
      </Card>
      <Card>
        <CardHeader title="Run a flow" subtitle="Evaluate the rule set against a sample event context." />
        <div className={styles.runForm}>
          <FormField label="Flow">
            <Select value={active} onChange={(e) => setFlowKey(e.target.value)}>
              {q.data?.flows.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
            </Select>
          </FormField>
          <FormField label="Event context (JSON)"><Textarea rows={5} value={context} onChange={(e) => setContext(e.target.value)} className={styles.monoInput} /></FormField>
          <div><Button variant="primary" onClick={() => run.mutate(active)} loading={run.isPending} disabled={!active}>Run flow</Button></div>
          {result && (
            <div className={styles.resultStack}>
              <Badge color={result.dispatched ? 'green' : 'red'}>{result.dispatched ? 'Dispatched' : 'Blocked'}</Badge>
              {result.outcome.errors.map((e, i) => <p key={i} className={`${shared.cellSub} ${styles.errorText}`}>{e}</p>)}
              {result.actions.map((a, i) => <Badge key={i} color="blue">{a.type}{a.target ? `: ${a.target}` : ''}</Badge>)}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

interface EvalResult { results: { prompt: string; expect: string; pass: boolean }[]; passed: number; total: number; score: number }
function Eval() {
  const toast = useToast();
  const [result, setResult] = useState<EvalResult | null>(null);
  const run = useMutation({
    mutationFn: () => api<EvalResult>('/api/assistant/eval/run', { body: {} }),
    onSuccess: (r) => setResult(r),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Eval failed'),
  });
  return (
    <div className={styles.section}>
      <p className={shared.cellSub}>Run a curated suite of prompts through the assistant and check each response contains the expected signal - a regression check on the intent engine.</p>
      <div><Button variant="primary" onClick={() => run.mutate()} loading={run.isPending}>Run evaluation</Button></div>
      {result && (
        <>
          <div className={shared.kpiGrid}>
            <KpiCard label="Score" value={formatPercent(result.score)} accent={result.score >= 0.8 ? 'var(--accent-emerald)' : 'var(--accent-orange)'} icon={<CircleCheckBig size={20} />} />
            <KpiCard label="Passed" value={`${result.passed} / ${result.total}`} icon={<Hash size={20} />} accent="var(--primary)" />
          </div>
          <Table
            columns={[
              { key: 'prompt', header: 'Prompt', render: (r: EvalResult['results'][number]) => <span className={shared.cellMain}>{r.prompt}</span> },
              { key: 'expect', header: 'Expected', render: (r: EvalResult['results'][number]) => <span className={shared.cellRef}>{r.expect}</span> },
              { key: 'pass', header: 'Result', render: (r: EvalResult['results'][number]) => <Badge color={r.pass ? 'green' : 'red'}>{r.pass ? 'Pass' : 'Fail'}</Badge> },
            ]}
            rows={result.results}
            rowKey={(r) => r.prompt}
          />
        </>
      )}
    </div>
  );
}

/* --------------------------- Rule studio --------------------------- */

type Comparator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'exists' | 'empty';
type EffectType = 'error' | 'warn' | 'set' | 'flag' | 'route';

const OPS: { value: Comparator; label: string }[] = [
  { value: 'eq', label: '= equals' }, { value: 'ne', label: '≠ not equals' },
  { value: 'gt', label: '> greater' }, { value: 'gte', label: '≥ at least' },
  { value: 'lt', label: '< less' }, { value: 'lte', label: '≤ at most' },
  { value: 'in', label: 'in list' }, { value: 'nin', label: 'not in list' },
  { value: 'contains', label: 'contains' }, { value: 'exists', label: 'exists' }, { value: 'empty', label: 'is empty' },
];
const EFFECTS: { value: EffectType; label: string }[] = [
  { value: 'error', label: 'Error (block)' }, { value: 'warn', label: 'Warn' },
  { value: 'set', label: 'Set default' }, { value: 'flag', label: 'Flag' }, { value: 'route', label: 'Route' },
];

const opNeedsValue = (op: Comparator) => op !== 'exists' && op !== 'empty';
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

interface ConditionRow { field: string; op: Comparator; value: string }
interface EffectRow { type: EffectType; target: string; value: string; message: string }
interface RuleSetBody { key: string; name?: string; rules: { id: string; name?: string; when: unknown; then: { type: string; target?: string; value?: unknown; message?: string }[] }[] }
interface RuleDefSummary { key: string; version: number; status: string; name?: string | null }
interface RuleVersion { id: string; key: string; version: number; status: string; body: RuleSetBody }
interface FlowRow { key: string; body: { trigger?: { eventType?: string }; ruleSetKey?: string } }
interface RuleOutcome { matched: string[]; errors: string[]; warnings: string[]; set: Record<string, unknown>; flags: string[]; routes: string[]; ok: boolean }

/** Parse a raw text value into the JSON the engine expects for a given operator. */
function parseValue(op: Comparator, raw: string): unknown {
  const s = raw.trim();
  if (s === '') return undefined;
  if (op === 'in' || op === 'nin') {
    try { const j = JSON.parse(s); if (Array.isArray(j)) return j; } catch { /* fall through to CSV */ }
    return s.split(',').map((x) => { const t = x.trim(); try { return JSON.parse(t); } catch { return t; } });
  }
  try { return JSON.parse(s); } catch { return s; }
}
const stringifyValue = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function statusColor(s: string): 'green' | 'amber' | 'gray' {
  return s === 'published' ? 'green' : s === 'draft' ? 'amber' : 'gray';
}

function RuleStudio() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('config:write');
  const [editing, setEditing] = useState<{ key?: string } | null>(null);
  const list = useQuery({ queryKey: ['designer-rules'], queryFn: () => api<{ definitions: RuleDefSummary[] }>('/api/designer/rules') });

  const cols: Column<RuleDefSummary>[] = [
    { key: 'key', header: 'Key', render: (r) => <span className={shared.cellRef}>{r.key}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className={shared.cellMain}>{r.name ?? r.key}</span> },
    { key: 'version', header: 'Version', align: 'right', render: (r) => `v${r.version}` },
    { key: 'status', header: 'Status', render: (r) => <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> },
  ];

  return (
    <div className={styles.sectionWide}>
      <Card padded={false}>
        <div className={styles.studioHead}>
          <CardHeader title="Business rules" subtitle="Trigger → condition → action rules interpreted by the pure engine, never executed as code." />
          {canWrite && !editing && (
            <Button variant="primary" size="sm" icon={<Plus size={16} />} onClick={() => setEditing({})}>New rule</Button>
          )}
        </div>
        {list.isLoading ? <PageLoader label="Loading rules…" /> : (
          <Table columns={cols} rows={list.data?.definitions}
            rowKey={(r) => r.key}
            onRowClick={canWrite ? (r) => setEditing({ key: r.key }) : undefined}
            empty={<EmptyState title="No rules" message="No business rules authored yet." icon={<GitBranch size={28} />} />} />
        )}
      </Card>
      {editing && canWrite && (
        <RuleComposer key={editing.key ?? '__new__'} editKey={editing.key} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function RuleComposer({ editKey, onClose }: { editKey?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({
    queryKey: ['designer-rule', editKey],
    queryFn: () => api<{ key: string; versions: RuleVersion[] }>(`/api/designer/rules/${editKey}`),
    enabled: !!editKey,
  });
  const flows = useQuery({ queryKey: ['automation-flows'], queryFn: () => api<{ flows: FlowRow[] }>('/api/automation-studio/flows') });

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState('');
  const [combinator, setCombinator] = useState<'all' | 'any'>('all');
  const [conditions, setConditions] = useState<ConditionRow[]>([{ field: 'premiumMinor', op: 'gt', value: '10000000' }]);
  const [effects, setEffects] = useState<EffectRow[]>([{ type: 'error', target: '', value: '', message: 'Premium exceeds threshold' }]);
  const [context, setContext] = useState('{\n  "premiumMinor": 25000000,\n  "lob": "PROPERTY"\n}');
  const [outcome, setOutcome] = useState<RuleOutcome | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const seeded = useRef(false);

  // Seed the editor from the latest/published version + any bound flow trigger.
  useEffect(() => {
    if (!editKey || seeded.current) return;
    const versions = existing.data?.versions;
    if (!versions) return;
    const body = (versions.find((v) => v.status === 'published') ?? versions[0])?.body;
    const rule = body?.rules?.[0];
    if (!body || !rule) return;
    seeded.current = true;
    setKey(body.key);
    setName(body.name ?? '');
    const when = rule.when as Record<string, unknown>;
    let rawConds: unknown[] = [when];
    let comb: 'all' | 'any' = 'all';
    if (when && typeof when === 'object' && Array.isArray(when.all)) { rawConds = when.all; comb = 'all'; }
    else if (when && typeof when === 'object' && Array.isArray(when.any)) { rawConds = when.any; comb = 'any'; }
    setCombinator(comb);
    const conds = rawConds
      .filter((c): c is { field: string; op: Comparator; value?: unknown } => !!c && typeof c === 'object' && 'field' in c && 'op' in c)
      .map((c) => ({ field: c.field, op: c.op, value: stringifyValue(c.value) }));
    if (conds.length) setConditions(conds);
    setEffects((rule.then ?? []).map((e) => ({ type: e.type as EffectType, target: e.target ?? '', value: stringifyValue(e.value), message: e.message ?? '' })));
  }, [editKey, existing.data]);

  // Seed the trigger from a bound automation flow, if one exists for this key.
  useEffect(() => {
    if (!editKey || !flows.data) return;
    const flow = flows.data.flows.find((f) => f.body?.ruleSetKey === editKey);
    if (flow?.body?.trigger?.eventType) setTriggerEvent(flow.body.trigger.eventType);
  }, [editKey, flows.data]);

  const setCond = (i: number, patch: Partial<ConditionRow>) => setConditions((p) => p.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCond = () => setConditions((p) => [...p, { field: '', op: 'eq', value: '' }]);
  const removeCond = (i: number) => setConditions((p) => p.filter((_, idx) => idx !== i));
  const setEff = (i: number, patch: Partial<EffectRow>) => setEffects((p) => p.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const addEff = () => setEffects((p) => [...p, { type: 'warn', target: '', value: '', message: '' }]);
  const removeEff = (i: number) => setEffects((p) => p.filter((_, idx) => idx !== i));

  // Assemble the RuleSet body the designer endpoint expects.
  const buildRuleSet = (): RuleSetBody => {
    const conds = conditions
      .filter((c) => c.field.trim())
      .map((c) => ({ field: c.field.trim(), op: c.op, ...(opNeedsValue(c.op) ? { value: parseValue(c.op, c.value) } : {}) }));
    const when = conds.length === 1 ? conds[0]! : { [combinator]: conds };
    const then = effects.map((e) => {
      const eff: { type: string; target?: string; value?: unknown; message?: string } = { type: e.type };
      if ((e.type === 'set' || e.type === 'flag' || e.type === 'route') && e.target.trim()) eff.target = e.target.trim();
      if (e.type === 'set' && e.value.trim()) { try { eff.value = JSON.parse(e.value); } catch { eff.value = e.value.trim(); } }
      if ((e.type === 'error' || e.type === 'warn') && e.message.trim()) eff.message = e.message.trim();
      return eff;
    });
    const ruleId = slug(name || key) || 'rule_1';
    return { key, name: name.trim() || undefined, rules: [{ id: ruleId, name: name.trim() || undefined, when, then }] };
  };

  const canSave = !!key.trim() && conditions.some((c) => c.field.trim()) && effects.length > 0;

  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      const set = buildRuleSet();
      await api('/api/designer/rules', { body: { key, name: name.trim() || undefined, publish, body: { rules: set.rules } } });
      // Bind the trigger to an automation flow so the rule fires on an event.
      if (triggerEvent.trim()) {
        const actions = set.rules[0]!.then
          .filter((e) => e.type === 'flag' || e.type === 'route' || e.type === 'set')
          .map((e) => ({ type: e.type, ...(e.target ? { target: e.target } : {}) }));
        await api('/api/automation-studio/flows', {
          body: { key, name: name.trim() || key, trigger: { eventType: triggerEvent.trim() }, ruleSetKey: key, actions },
        });
      }
      return { key };
    },
    onSuccess: (_r, publish) => {
      toast.success(publish ? `Published rule ${key}` : `Saved draft ${key}`);
      qc.invalidateQueries({ queryKey: ['designer-rules'] });
      qc.invalidateQueries({ queryKey: ['designer-rule', key] });
      qc.invalidateQueries({ queryKey: ['automation-flows'] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 422) {
        const body = e.body as { issues?: { message: string }[] } | undefined;
        toast.error(body?.issues?.[0]?.message ?? 'Rule is not valid');
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Save failed');
      }
    },
  });

  const evaluate = useMutation({
    mutationFn: () => {
      setCtxError(null);
      let ctx: unknown;
      try { ctx = JSON.parse(context); } catch { setCtxError('Context is not valid JSON.'); throw new Error('bad json'); }
      return api<{ outcome: RuleOutcome }>('/api/designer/rules/evaluate', { body: { ruleSet: buildRuleSet(), context: ctx } });
    },
    onSuccess: (r) => setOutcome(r.outcome),
    onError: (e) => { if (!(e instanceof Error && e.message === 'bad json')) toast.error('Evaluation failed'); },
  });

  if (editKey && existing.isLoading) return <PageLoader label="Loading rule…" />;

  return (
    <Card>
      <CardHeader
        title={editKey ? <><Pencil size={16} /> Edit {editKey}</> : 'New rule'}
        subtitle="A trigger fires the rule; every matching condition emits its actions."
        actions={<Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>}
      />
      <div className={styles.composer}>
        <div className={styles.composerGrid}>
          <FormField label="Key" hint="Stable identifier, e.g. treaty.large-premium">
            <Input value={key} disabled={!!editKey} placeholder="treaty.large-premium" onChange={(e) => setKey(e.target.value)} />
          </FormField>
          <FormField label="Name">
            <Input value={name} placeholder="Large premium referral" onChange={(e) => setName(e.target.value)} />
          </FormField>
        </div>

        <div>
          <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}>Trigger</h4>
          <FormField label="On event (optional)" hint="Event type that fires this rule via an automation flow, e.g. treaty.bound. Leave blank to author the rule set only.">
            <Input value={triggerEvent} placeholder="treaty.bound" onChange={(e) => setTriggerEvent(e.target.value)} />
          </FormField>
        </div>

        <div>
          <div className={styles.condHead}>
            <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}>Conditions</h4>
            <div className={styles.combinator}>
              <label className={styles.checkInline}><input type="radio" name="rule-comb" checked={combinator === 'all'} onChange={() => setCombinator('all')} /> match ALL</label>
              <label className={styles.checkInline}><input type="radio" name="rule-comb" checked={combinator === 'any'} onChange={() => setCombinator('any')} /> match ANY</label>
            </div>
          </div>
          <div className={styles.rowList}>
            {conditions.map((c, i) => (
              <div key={i} className={styles.condRow}>
                <Input className={styles.field} value={c.field} placeholder="field (dot.path)" onChange={(e) => setCond(i, { field: e.target.value })} />
                <Select className={styles.op} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Comparator })}>
                  {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                {opNeedsValue(c.op) && (
                  <Input className={styles.value} value={c.value} placeholder={c.op === 'in' || c.op === 'nin' ? 'a, b, c' : 'value'} onChange={(e) => setCond(i, { value: e.target.value })} />
                )}
                <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => removeCond(i)} aria-label="Remove condition" />
              </div>
            ))}
          </div>
          <div className={styles.addRow}><Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={addCond}>Add condition</Button></div>
        </div>

        <div>
          <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}>Actions</h4>
          <div className={styles.rowList}>
            {effects.map((e, i) => (
              <div key={i} className={styles.condRow}>
                <Select className={styles.op} value={e.type} onChange={(ev) => setEff(i, { type: ev.target.value as EffectType })}>
                  {EFFECTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                {(e.type === 'set' || e.type === 'flag' || e.type === 'route') && (
                  <Input className={styles.field} value={e.target} placeholder={e.type === 'route' ? 'queue/target' : 'field'} onChange={(ev) => setEff(i, { target: ev.target.value })} />
                )}
                {e.type === 'set' && (
                  <Input className={styles.value} value={e.value} placeholder="default value" onChange={(ev) => setEff(i, { value: ev.target.value })} />
                )}
                {(e.type === 'error' || e.type === 'warn') && (
                  <Input className={styles.value} value={e.message} placeholder="message" onChange={(ev) => setEff(i, { message: ev.target.value })} />
                )}
                <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => removeEff(i)} aria-label="Remove action" />
              </div>
            ))}
          </div>
          <div className={styles.addRow}><Button variant="secondary" size="sm" icon={<Plus size={15} />} onClick={addEff}>Add action</Button></div>
        </div>

        <div className={styles.tester}>
          <h4 className={`${shared.cellMain} ${styles.sectionHeading}`}><FlaskConical size={15} /> Test</h4>
          <FormField label="Sample context (JSON)" error={ctxError ?? undefined}>
            <Textarea rows={5} value={context} onChange={(e) => setContext(e.target.value)} className={styles.monoInput} />
          </FormField>
          <div className={styles.addRow}><Button variant="secondary" onClick={() => evaluate.mutate()} loading={evaluate.isPending}>Evaluate</Button></div>
          {outcome && (
            <div className={styles.resultStack}>
              <Badge color={outcome.ok ? 'green' : 'red'}>{outcome.ok ? 'Passes' : 'Blocked'}</Badge>
              {outcome.matched.length > 0 && <p className={shared.cellSub}>Matched: {outcome.matched.join(', ')}</p>}
              {outcome.errors.map((x, i) => <p key={i} className={`${shared.cellSub} ${styles.errorText}`}>Error: {x}</p>)}
              {outcome.warnings.map((x, i) => <p key={i} className={shared.cellSub}>Warning: {x}</p>)}
              {outcome.routes.length > 0 && <p className={shared.cellSub}>Routes: {outcome.routes.join(', ')}</p>}
              {outcome.flags.length > 0 && <p className={shared.cellSub}>Flags: {outcome.flags.join(', ')}</p>}
              {Object.keys(outcome.set).length > 0 && <p className={shared.cellSub}>Defaults: {JSON.stringify(outcome.set)}</p>}
            </div>
          )}
        </div>

        <div className={styles.composerActions}>
          <Button variant="secondary" onClick={() => save.mutate(false)} loading={save.isPending && save.variables === false} disabled={!canSave || save.isPending}>Save draft</Button>
          <Button variant="primary" onClick={() => save.mutate(true)} loading={save.isPending && save.variables === true} disabled={!canSave || save.isPending}>Publish</Button>
        </div>
      </div>
    </Card>
  );
}
