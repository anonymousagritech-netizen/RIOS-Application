/**
 * AI Automation Studio + Assistant evaluation (brief §5, §12.7). Run trigger→
 * rule→action flows against a sample event, and run the assistant regression
 * suite. Both exercise the live engines server-side.
 */

import { CheckCircle2, Hash } from 'lucide-react';
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Select, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatPercent } from '../lib/format';
import shared from './shared.module.css';
import styles from './AutomationStudioPage.module.css';

export function AutomationStudioPage() {
  const [tab, setTab] = useState('flows');
  return (
    <>
      <PageHeader title="Automation Studio" description="Trigger→rule→action flows, and the assistant evaluation suite." />
      <Card>
        <Tabs tabs={[{ id: 'flows', label: 'Automation flows' }, { id: 'eval', label: 'Assistant eval' }]} active={tab} onChange={setTab} />
        <div className={styles.tabBody}>
          {tab === 'flows' ? <Flows /> : <Eval />}
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

  const cols: Column<Flow>[] = [
    { key: 'name', header: 'Flow', render: (f) => <span className={shared.cellMain}>{f.name}</span> },
    { key: 'trigger', header: 'Trigger', render: (f) => <Badge color="violet">{f.body.trigger?.eventType}</Badge> },
    { key: 'rules', header: 'Rule set', render: (f) => <span className={shared.cellRef}>{f.body.ruleSetKey}</span> },
    { key: 'actions', header: 'Actions', render: (f) => (f.body.actions ?? []).map((a) => a.type).join(', ') },
  ];

  return (
    <div className={styles.sectionWide}>
      <Table columns={cols} rows={q.data?.flows} rowKey={(f) => f.key} empty={<EmptyState title="No flows" message="No automation flows defined." />} />
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
            <KpiCard label="Score" value={formatPercent(result.score)} accent={result.score >= 0.8 ? 'var(--c-green)' : 'var(--c-amber)'} icon={<CheckCircle2 size={20} />} />
            <KpiCard label="Passed" value={`${result.passed} / ${result.total}`} icon={<Hash size={20} />} />
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
