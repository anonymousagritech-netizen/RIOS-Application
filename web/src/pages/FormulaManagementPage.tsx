import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  FunctionSquare, Play, CheckCircle2, XCircle, Variable, ListTree,
  Braces, Save, AlertTriangle,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Input, Textarea } from '../components/Form';
import { CalculatedValue, type CalculationStep } from '../components/CalculatedValue';
import { formatNumber, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './FormulaManagementPage.module.css';

/* ---------------- Types (mirror the /api/formulas contract) ---------------- */
interface FormulaTerm { name: string; label?: string; expr: string }
interface FormulaDefinition {
  key: string;
  name: string;
  category?: string;
  version: number;
  effectiveFrom?: string;
  inputs: string[];
  constants?: Record<string, number>;
  terms: FormulaTerm[];
  result: string;
  resultLabel?: string;
}
interface FormulaVersion { version: number; effectiveFrom?: string }
interface FormulaDetail extends FormulaDefinition { versions?: FormulaVersion[] }
interface EvaluateResponse {
  key: string;
  value: number;
  steps: CalculationStep[];
  version: number;
}
interface ValidateResponse { ok: boolean; errors: string[] }

/* ---------------- Response normalisation (code defensively) ---------------- */
function normaliseList(raw: unknown): FormulaDefinition[] {
  if (Array.isArray(raw)) return raw as FormulaDefinition[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { formulas?: unknown }).formulas)) {
    return (raw as { formulas: FormulaDefinition[] }).formulas;
  }
  return [];
}

/** Identifier-shaped tokens referenced by an expression, minus numeric literals. */
function extractRefs(expr: string): string[] {
  const matches = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) { seen.add(m); out.push(m); }
  }
  return out;
}

/* ---------------- Data hooks ---------------- */
function useFormulas() {
  return useQuery({
    queryKey: ['formulas'],
    queryFn: async () => normaliseList(await api<unknown>('/api/formulas')),
  });
}
function useFormulaDetail(key: string | null) {
  return useQuery({
    queryKey: ['formula', key],
    queryFn: () => api<FormulaDetail>(`/api/formulas/${key}`),
    enabled: !!key,
  });
}

export function FormulaManagementPage() {
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('admin:manage') || hasPermission('config:write');

  const { data: formulas, isLoading } = useFormulas();
  const list = formulas ?? [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, FormulaDefinition[]>();
    for (const f of list) {
      const cat = f.category?.trim() || 'Uncategorised';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(f);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);

  // Default the selection to the first formula once loaded.
  const effectiveKey = selectedKey ?? list[0]?.key ?? null;
  const categoryCount = grouped.length;

  return (
    <div className={shared.stack}>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Administration' }, { label: 'Formula Engine' }]}
        title="Formula Engine"
        description="Inspect, test and govern the calculation formulas that drive premiums, commissions and accounting figures across RIOS."
        actions={<Badge color={isAdmin ? 'green' : 'slate'}>{isAdmin ? 'admin' : 'read-only'}</Badge>}
      />

      <div className={shared.kpiRow}>
        <KpiCard label="Formulas" value={formatNumber(list.length)} loading={isLoading} icon={<FunctionSquare size={20} />} accent="var(--primary)" />
        <KpiCard label="Categories" value={formatNumber(categoryCount)} loading={isLoading} icon={<ListTree size={20} />} accent="var(--accent-violet)" />
        <KpiCard label="Governance" value={isAdmin ? 'Editable' : 'Read-only'} loading={isLoading} icon={<Variable size={20} />} accent="var(--accent-teal)" />
      </div>

      <div className={styles.layout}>
        <Card padded={false} className={styles.listCard}>
          <div className={styles.listHead}>
            <CardHeader title="Formulas" subtitle="Grouped by category" />
          </div>
          <div className={styles.listBody}>
            {isLoading ? (
              <p className={styles.emptyNote}>Loading formulas…</p>
            ) : grouped.length === 0 ? (
              <p className={styles.emptyNote}>No formulas are defined yet.</p>
            ) : (
              grouped.map(([cat, items]) => (
                <div key={cat} className={styles.group}>
                  <div className={styles.groupLabel}>{titleCase(cat)}</div>
                  {items.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={`${styles.formulaItem} ${effectiveKey === f.key ? styles.formulaItemActive : ''}`}
                      onClick={() => setSelectedKey(f.key)}
                    >
                      <span className={styles.formulaName}>{f.name}</span>
                      <span className={styles.formulaKey}>{f.key} · v{f.version}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </Card>

        <div className={styles.detailCol}>
          {effectiveKey ? (
            <FormulaDetailPanel key={effectiveKey} formulaKey={effectiveKey} isAdmin={isAdmin} />
          ) : (
            <Card>
              <p className={styles.emptyNote}>Select a formula to inspect its definition, dependencies and test sandbox.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Detail panel ---------------- */
function FormulaDetailPanel({ formulaKey, isAdmin }: { formulaKey: string; isAdmin: boolean }) {
  const { data, isLoading } = useFormulaDetail(formulaKey);
  const [tab, setTab] = useState<'overview' | 'sandbox' | 'editor'>('overview');

  if (isLoading || !data) {
    return <Card><p className={styles.emptyNote}>Loading formula…</p></Card>;
  }

  const tabs = [
    { id: 'overview', label: 'Definition' },
    { id: 'sandbox', label: 'Test Sandbox' },
    ...(isAdmin ? [{ id: 'editor', label: 'Editor' }] : []),
  ];

  return (
    <>
      <Card>
        <div className={styles.detailHeader}>
          <div>
            <h2 className={styles.detailTitle}>{data.name}</h2>
            <div className={styles.detailMeta}>
              <span className={styles.metaKey}>{data.key}</span>
              {data.category && <Badge color="violet">{titleCase(data.category)}</Badge>}
              <Badge color="indigo">v{data.version}</Badge>
              {data.effectiveFrom && <span className={styles.metaDate}>Effective {formatDate(data.effectiveFrom)}</span>}
            </div>
          </div>
        </div>
        <div className={styles.tabsBar}>
          <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as typeof tab)} />
        </div>
      </Card>

      {tab === 'overview' && <OverviewTab def={data} />}
      {tab === 'sandbox' && <SandboxTab def={data} />}
      {tab === 'editor' && isAdmin && <EditorTab def={data} />}
    </>
  );
}

/* ---------------- Definition / dependencies ---------------- */
function OverviewTab({ def }: { def: FormulaDetail }) {
  const inputSet = new Set(def.inputs);
  const constSet = new Set(Object.keys(def.constants ?? {}));
  const termNames = new Set(def.terms.map((t) => t.name));

  const classify = (ref: string): 'input' | 'const' | 'term' | 'unknown' => {
    if (inputSet.has(ref)) return 'input';
    if (constSet.has(ref)) return 'const';
    if (termNames.has(ref)) return 'term';
    return 'unknown';
  };

  return (
    <>
      <Card>
        <CardHeader title="Inputs & constants" subtitle="The variables that drive this calculation." />
        <div className={styles.chipSection}>
          <div className={styles.chipGroup}>
            <span className={styles.chipGroupLabel}>Inputs</span>
            <div className={styles.chips}>
              {def.inputs.length ? def.inputs.map((i) => (
                <span key={i} className={`${styles.varChip} ${styles.varInput}`}>{i}</span>
              )) : <span className={styles.emptyNote}>None</span>}
            </div>
          </div>
          {def.constants && Object.keys(def.constants).length > 0 && (
            <div className={styles.chipGroup}>
              <span className={styles.chipGroupLabel}>Constants</span>
              <div className={styles.chips}>
                {Object.entries(def.constants).map(([k, v]) => (
                  <span key={k} className={`${styles.varChip} ${styles.varConst}`}>{k} = {v}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <div className={styles.sectionPad}>
          <CardHeader title="Terms & dependencies" subtitle="Each intermediate term and the variables it references." />
        </div>
        <div className={styles.termList}>
          {def.terms.map((t) => {
            const refs = extractRefs(t.expr);
            return (
              <div key={t.name} className={styles.term}>
                <div className={styles.termHead}>
                  <span className={styles.termName}>{t.name}</span>
                  {t.label && <span className={styles.termLabel}>{t.label}</span>}
                </div>
                <code className={styles.expr}>{t.expr}</code>
                <div className={styles.deps}>
                  {refs.map((r) => {
                    const kind = classify(r);
                    if (kind === 'unknown') return null;
                    return (
                      <span key={r} className={`${styles.depChip} ${styles[`dep_${kind}`]}`}>
                        {r}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className={`${styles.term} ${styles.resultTerm}`}>
            <div className={styles.termHead}>
              <span className={styles.termName}>{def.resultLabel ?? 'Result'}</span>
              <Badge color="green">result</Badge>
            </div>
            <code className={styles.expr}>{def.result}</code>
          </div>
        </div>
      </Card>
    </>
  );
}

/* ---------------- Test sandbox ---------------- */
function SandboxTab({ def }: { def: FormulaDetail }) {
  const [inputs, setInputs] = useState<Record<string, string>>(
    () => Object.fromEntries(def.inputs.map((i) => [i, ''])),
  );
  const [result, setResult] = useState<EvaluateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const evaluate = useMutation({
    mutationFn: (body: { inputs: Record<string, number> }) =>
      api<EvaluateResponse>(`/api/formulas/${def.key}/evaluate`, { body }),
    onSuccess: (res) => { setResult(res); setError(null); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not evaluate the formula.'),
  });

  const run = () => {
    setError(null);
    const parsed: Record<string, number> = {};
    for (const key of def.inputs) {
      const num = Number(inputs[key]);
      if (inputs[key]?.trim() === '' || Number.isNaN(num)) {
        setError(`Enter a numeric value for "${key}".`);
        return;
      }
      parsed[key] = num;
    }
    evaluate.mutate({ inputs: parsed });
  };

  return (
    <Card>
      <CardHeader
        title="Test sandbox"
        subtitle="Provide sample inputs and evaluate the formula to see the result and its step breakdown."
      />
      <div className={styles.sandbox}>
        <div className={styles.inputGrid}>
          {def.inputs.length ? def.inputs.map((i) => (
            <FormField key={i} label={i}>
              <Input
                type="number"
                step="any"
                value={inputs[i] ?? ''}
                onChange={(e) => setInputs((p) => ({ ...p, [i]: e.target.value }))}
                placeholder="0"
              />
            </FormField>
          )) : <p className={styles.emptyNote}>This formula takes no inputs.</p>}
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <div>
          <Button variant="primary" icon={<Play size={16} />} loading={evaluate.isPending} onClick={run}>
            Run
          </Button>
        </div>

        {result && (
          <div className={styles.resultPanel}>
            <CalculatedValue
              label={def.resultLabel ?? 'Result'}
              value={result.value}
              status="SYSTEM"
              steps={result.steps}
              formatValue={(n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(n)}
            />
            <span className={styles.resultVersion}>Computed with v{result.version}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ---------------- Editor (admin) ---------------- */
function EditorTab({ def }: { def: FormulaDetail }) {
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify(stripVersions(def), null, 2));
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const parse = (): FormulaDefinition | null => {
    try {
      const parsed = JSON.parse(text) as FormulaDefinition;
      setParseError(null);
      return parsed;
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON.');
      return null;
    }
  };

  const validateMut = useMutation({
    mutationFn: (definition: FormulaDefinition) =>
      api<ValidateResponse>('/api/formulas/validate', { body: { definition } }),
    onSuccess: (res) => setValidation(res),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Validation failed.'),
  });

  const saveMut = useMutation({
    mutationFn: (definition: FormulaDefinition) =>
      api<FormulaDefinition>('/api/formulas', { method: 'POST', body: definition }),
    onSuccess: () => toast.success('Formula saved'),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the formula.'),
  });

  const onValidate = () => {
    const d = parse();
    if (d) validateMut.mutate(d);
  };
  const onSave = async () => {
    const d = parse();
    if (!d) return;
    const res = await validateMut.mutateAsync(d);
    setValidation(res);
    if (res.ok) saveMut.mutate(d);
  };

  return (
    <Card>
      <CardHeader
        title="Definition editor"
        subtitle="Edit the formula definition as JSON. Validate before saving; save runs validation first."
      />
      <div className={styles.editor}>
        <FormField label={<span className={styles.editorLabel}><Braces size={13} /> Definition JSON</span>}>
          <Textarea
            rows={16}
            value={text}
            onChange={(e) => { setText(e.target.value); setValidation(null); setParseError(null); }}
            className={styles.jsonArea}
            spellCheck={false}
          />
        </FormField>

        {parseError && (
          <p className={styles.error} role="alert"><AlertTriangle size={13} /> {parseError}</p>
        )}

        {validation && (
          <div className={`${styles.validation} ${validation.ok ? styles.validOk : styles.validBad}`}>
            {validation.ok ? (
              <p className={styles.validLine}><CheckCircle2 size={15} /> Definition is valid.</p>
            ) : (
              <>
                <p className={styles.validLine}><XCircle size={15} /> {validation.errors.length} issue(s) found:</p>
                <ul className={styles.errList}>
                  {validation.errors.map((err, idx) => <li key={idx}>{err}</li>)}
                </ul>
              </>
            )}
          </div>
        )}

        <div className={styles.editorActions}>
          <Button variant="secondary" icon={<CheckCircle2 size={16} />} loading={validateMut.isPending} onClick={onValidate}>
            Validate
          </Button>
          <Button variant="primary" icon={<Save size={16} />} loading={saveMut.isPending} onClick={onSave}>
            Save formula
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Drop server-managed fields the editor should not round-trip. */
function stripVersions(def: FormulaDetail): FormulaDefinition {
  const { versions: _versions, ...rest } = def;
  void _versions;
  return rest;
}
