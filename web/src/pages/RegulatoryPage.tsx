import { useState } from 'react';
import { Scale, ShieldCheck, Sigma, Coins, Percent, Layers, AlertTriangle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { KpiCard } from '../components/KpiCard';
import { DefinitionList } from '../components/Feedback';
import { useCurrencies } from '../lib/queries';
import { formatMoney, formatMoneyCompact, formatNumber, formatPercent, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './workspace.module.css';
import local from './RegulatoryPage.module.css';

/* ---------------- Types ---------------- */
interface Measurement {
  earnedPremium: number;
  lrc: number;
  discountedClaims: number;
  riskAdjustment: number;
  lic: number;
  onerous: boolean;
  lossComponent: number;
  totalLiability: number;
}
interface Ifrs17Group {
  id: string;
  name: string;
  measurement_model: string;
  held_or_issued: string;
  currency: string;
  latestMeasurement?: Measurement | null;
}
interface Ifrs17GroupsResponse { groups: Ifrs17Group[]; }

interface Solvency2Module { name: string; scr: number; }
interface Solvency2RunResult {
  basicScr: number;
  scr: number;
  mcr: number;
  solvencyRatio: number;
  modules: Solvency2Module[];
}
interface Solvency2Run {
  id: string;
  as_at: string;
  currency: string;
  scr_minor: number;
  mcr_minor: number;
  solvency_ratio: number;
  modules: Solvency2Module[];
}
interface Solvency2RunsResponse { runs: Solvency2Run[]; }

/* ---------------- Data hooks ---------------- */
function useIfrs17Groups() {
  return useQuery({
    queryKey: ['regulatory', 'ifrs17', 'groups'],
    queryFn: () => api<Ifrs17GroupsResponse>('/api/regulatory/ifrs17/groups'),
  });
}
function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; measurementModel?: string; heldOrIssued?: string; portfolio?: string; cohortYear?: number; currency: string }) =>
      api<Ifrs17Group>('/api/regulatory/ifrs17/groups', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regulatory', 'ifrs17'] }),
  });
}
interface MeasureBody {
  asAt?: string;
  premiumReceived: number;
  acquisitionCashFlows: number;
  coverageElapsed: number;
  expectedClaims: number;
  discountFactor: number;
  riskAdjustmentPct: number;
}
function useMeasureGroup(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MeasureBody) => api<Measurement>(`/api/regulatory/ifrs17/groups/${id}/measure`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regulatory', 'ifrs17'] }),
  });
}
function useSolvency2Runs() {
  return useQuery({
    queryKey: ['regulatory', 'solvency2', 'runs'],
    queryFn: () => api<Solvency2RunsResponse>('/api/regulatory/solvency2/runs'),
  });
}
interface Solvency2RunBody {
  currency: string;
  asAt?: string;
  modules: { name: string; scr: number }[];
  correlation: number[][];
  operationalRisk: number;
  adjustment?: number;
  linearMcr: number;
  absoluteFloor: number;
  ownFunds: number;
}
function useRunSolvency2() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Solvency2RunBody) => api<Solvency2RunResult>('/api/regulatory/solvency2/run', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['regulatory', 'solvency2'] }),
  });
}

// The server currently accepts only the Premium Allocation Approach (PAA).
const MEASUREMENT_MODELS = ['PAA'];
const HELD_OR_ISSUED = ['ISSUED', 'HELD'];

const TABS = [
  { id: 'ifrs17', label: 'IFRS 17' },
  { id: 'solvency2', label: 'Solvency II' },
];

export function RegulatoryPage() {
  const { hasPermission } = useAuth();
  const [tab, setTab] = useState('ifrs17');
  const canRun = hasPermission('regulatory:run');

  const groupsQuery = useIfrs17Groups();
  const runsQuery = useSolvency2Runs();

  const groups = groupsQuery.data?.groups ?? [];
  const onerous = groups.filter((g) => g.latestMeasurement?.onerous).length;
  const measured = groups.filter((g) => g.latestMeasurement);
  const liabilityCurrency = measured[0]?.currency ?? 'USD';
  const totalLiability = measured.reduce((sum, g) => sum + (g.latestMeasurement?.totalLiability ?? 0), 0);

  return (
    <div className={shared.stack}>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Regulatory' }]}
        title="Regulatory"
        description="IFRS 17 measurement and Solvency II capital reporting."
        actions={
          canRun
            ? <Badge color="green">regulatory:run granted</Badge>
            : <Badge color="slate">read-only</Badge>
        }
      />

      <div className={shared.kpiRow}>
        <KpiCard label="IFRS 17 groups" value={groups.length} loading={groupsQuery.isLoading} icon={<Layers size={20} />} accent="var(--primary)" />
        <KpiCard label="Total liability" value={measured.length ? formatMoneyCompact(totalLiability, liabilityCurrency) : '-'} hint={`${measured.length} measured`} loading={groupsQuery.isLoading} icon={<Scale size={20} />} accent="var(--accent-violet)" />
        <KpiCard label="Onerous groups" value={onerous} loading={groupsQuery.isLoading} icon={<AlertTriangle size={20} />} accent="var(--accent-orange)" />
        <KpiCard label="Solvency II runs" value={runsQuery.data?.runs.length ?? 0} loading={runsQuery.isLoading} icon={<ShieldCheck size={20} />} accent="var(--accent-cyan)" />
      </div>

      <Card padded={false}>
        <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'ifrs17' && <Ifrs17Tab canRun={canRun} />}
        {tab === 'solvency2' && <Solvency2Tab canRun={canRun} />}
      </Card>
    </div>
  );
}

/* ---------------- IFRS 17 ---------------- */
function Ifrs17Tab({ canRun }: { canRun: boolean }) {
  const { data, isLoading } = useIfrs17Groups();
  const [showNew, setShowNew] = useState(false);
  const [measureFor, setMeasureFor] = useState<Ifrs17Group | null>(null);

  const columns: Column<Ifrs17Group>[] = [
    { key: 'name', header: 'Group', sortValue: (g) => g.name, render: (g) => <span className={shared.cellMain}>{g.name}</span> },
    { key: 'model', header: 'Model', render: (g) => <StatusPill status={g.measurement_model} /> },
    { key: 'held', header: 'Held / Issued', render: (g) => <StatusPill status={g.held_or_issued} /> },
    { key: 'ccy', header: 'CCY', render: (g) => g.currency },
    {
      key: 'liability', header: 'Total liability', align: 'right',
      render: (g) => g.latestMeasurement
        ? <span className={shared.money}>{formatMoney(g.latestMeasurement.totalLiability, g.currency)}</span>
        : <span className={shared.cellSub}>Not measured</span>,
    },
    {
      key: 'onerous', header: '',
      render: (g) => g.latestMeasurement?.onerous
        ? <StatusPill status="ONEROUS" label="Onerous" metaColors={{ ONEROUS: 'red' }} />
        : null,
    },
    ...(canRun ? [{
      key: 'action', header: '', align: 'right' as const,
      render: (g: Ifrs17Group) => (
        <Button size="sm" variant="secondary" onClick={() => setMeasureFor(g)}>Measure</Button>
      ),
    }] : []),
  ];

  return (
    <>
      <div className={local.cardPad}>
        <CardHeader
          title="Groups of insurance contracts"
          subtitle="IFRS 17 measurement groups and their latest liability."
          actions={canRun ? <Button size="sm" variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New group</Button> : undefined}
        />
      </div>
      <Table
        columns={columns}
        rows={data?.groups}
        loading={isLoading}
        rowKey={(g) => g.id}
        empty={<EmptyState title="No groups" message="Create a group of contracts to begin IFRS 17 measurement." icon={<Scale size={16} />} />}
      />
      <NewGroupModal open={showNew} onClose={() => setShowNew(false)} />
      <MeasureModal group={measureFor} onClose={() => setMeasureFor(null)} />
    </>
  );
}

function NewGroupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateGroup();
  const { data: ccyData } = useCurrencies();
  const currencies = ccyData?.currencies ?? [];
  const [name, setName] = useState('');
  const [measurementModel, setMeasurementModel] = useState('PAA');
  const [heldOrIssued, setHeldOrIssued] = useState('ISSUED');
  const [portfolio, setPortfolio] = useState('');
  const [cohortYear, setCohortYear] = useState(String(new Date().getFullYear()));
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName(''); setMeasurementModel('PAA'); setHeldOrIssued('ISSUED');
    setPortfolio(''); setCohortYear(String(new Date().getFullYear())); setCurrency('USD'); setError(null);
  };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cohortNum = Number(cohortYear);
    try {
      await create.mutateAsync({
        name,
        measurementModel,
        heldOrIssued,
        portfolio: portfolio || undefined,
        cohortYear: cohortYear && !Number.isNaN(cohortNum) ? cohortNum : undefined,
        currency,
      });
      toast.success(`Group “${name}” created`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the group.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New IFRS 17 group"
      description="Define a group of insurance contracts for measurement."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>Create group</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Group name" value={name} onChange={setName} required placeholder="e.g. Property QS 2026 - Onerous" />
          </div>
          <FormField label="Held / Issued">
            <Select value={heldOrIssued} onChange={(e) => setHeldOrIssued(e.target.value)}>
              {HELD_OR_ISSUED.map((h) => <option key={h} value={h}>{titleCase(h)}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Measurement & aggregation" description="IFRS 17 requires grouping by portfolio and annual cohort. The server measures under the Premium Allocation Approach.">
          <FormField label="Measurement model">
            <Select value={measurementModel} onChange={(e) => setMeasurementModel(e.target.value)}>
              {MEASUREMENT_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </FormField>
          <FormField label="Portfolio" hint="Optional grouping of similar risks">
            <Input value={portfolio} onChange={(e) => setPortfolio(e.target.value)} placeholder="e.g. Property Treaty" />
          </FormField>
          <FormField label="Cohort year" hint="Annual cohort of contracts">
            <Input type="number" value={cohortYear} onChange={(e) => setCohortYear(e.target.value)} />
          </FormField>
        </FormSection>
        {error && <p className={local.errorSpan} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function MeasureModal({ group, onClose }: { group: Ifrs17Group | null; onClose: () => void }) {
  const toast = useToast();
  const measure = useMeasureGroup(group?.id);
  const [asAt, setAsAt] = useState('');
  const [premiumReceived, setPremiumReceived] = useState('');
  const [acquisitionCashFlows, setAcquisitionCashFlows] = useState('');
  const [coverageElapsed, setCoverageElapsed] = useState('');
  const [expectedClaims, setExpectedClaims] = useState('');
  const [discountFactor, setDiscountFactor] = useState('0.97');
  const [riskAdjustmentPct, setRiskAdjustmentPct] = useState('5');
  const [result, setResult] = useState<Measurement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAsAt(''); setPremiumReceived(''); setAcquisitionCashFlows(''); setCoverageElapsed('');
    setExpectedClaims(''); setDiscountFactor('0.97'); setRiskAdjustmentPct('5');
    setResult(null); setError(null);
  };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!group) return;
    try {
      const res = await measure.mutateAsync({
        asAt: asAt || undefined,
        premiumReceived: Number(premiumReceived) || 0,
        acquisitionCashFlows: Number(acquisitionCashFlows) || 0,
        coverageElapsed: Number(coverageElapsed) || 0,
        expectedClaims: Number(expectedClaims) || 0,
        discountFactor: Number(discountFactor) || 0,
        riskAdjustmentPct: Number(riskAdjustmentPct) || 0,
      });
      setResult(res);
      toast.success('Measurement complete');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the measurement.');
    }
  };

  const ccy = group?.currency ?? 'USD';

  return (
    <Modal
      open={!!group}
      onClose={close}
      size="lg"
      title={group ? `Measure - ${group.name}` : 'Measure'}
      description="Premium Allocation Approach inputs (major units)."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Close</Button>
          <Button variant="primary" onClick={submit} loading={measure.isPending}>Run measurement</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Reporting date">
          <FormField label="As at" hint="Measurement date (defaults to today)">
            <Input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} />
          </FormField>
        </FormSection>

        <FormSection title="Liability for remaining coverage (LRC)" description="Premium Allocation Approach inputs.">
          <FormField label="Premium received" hint={`Major units of ${ccy}.`}>
            <Input type="number" step="any" value={premiumReceived} onChange={(e) => setPremiumReceived(e.target.value)} placeholder="e.g. 1000000" />
          </FormField>
          <FormField label="Acquisition cash flows" hint={`Major units of ${ccy}.`}>
            <Input type="number" step="any" value={acquisitionCashFlows} onChange={(e) => setAcquisitionCashFlows(e.target.value)} placeholder="e.g. 50000" />
          </FormField>
          <FormField label="Coverage elapsed" hint="Fraction 0–1, e.g. 0.5">
            <Input type="number" step="any" value={coverageElapsed} onChange={(e) => setCoverageElapsed(e.target.value)} placeholder="0.5" />
          </FormField>
        </FormSection>

        <FormSection title="Liability for incurred claims (LIC)" description="Fulfilment cash flows drive the onerous test.">
          <FormField label="Expected claims" hint={`Major units of ${ccy}.`}>
            <Input type="number" step="any" value={expectedClaims} onChange={(e) => setExpectedClaims(e.target.value)} placeholder="e.g. 700000" />
          </FormField>
          <FormField label="Discount factor" hint="e.g. 0.97">
            <Input type="number" step="any" value={discountFactor} onChange={(e) => setDiscountFactor(e.target.value)} />
          </FormField>
          <FormField label="Risk adjustment %" hint="e.g. 5">
            <Input type="number" step="any" value={riskAdjustmentPct} onChange={(e) => setRiskAdjustmentPct(e.target.value)} />
          </FormField>
        </FormSection>
        {error && <p className={local.errorSpan} role="alert">{error}</p>}
      </form>

      {result && (
        <div className={local.resultBlock}>
          <CardHeader
            title="Measurement result"
            actions={result.onerous ? <StatusPill status="ONEROUS" label="Onerous" metaColors={{ ONEROUS: 'red' }} /> : undefined}
          />
          <DefinitionList
            items={[
              { term: 'Earned premium', value: formatMoney(result.earnedPremium, ccy) },
              { term: 'Liability for remaining coverage (LRC)', value: formatMoney(result.lrc, ccy) },
              { term: 'Discounted claims', value: formatMoney(result.discountedClaims, ccy) },
              { term: 'Risk adjustment', value: formatMoney(result.riskAdjustment, ccy) },
              { term: 'Liability for incurred claims (LIC)', value: formatMoney(result.lic, ccy) },
              { term: 'Loss component', value: formatMoney(result.lossComponent, ccy) },
              { term: 'Total liability', value: formatMoney(result.totalLiability, ccy) },
            ]}
          />
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Solvency II ---------------- */
function Solvency2Tab({ canRun }: { canRun: boolean }) {
  const { data, isLoading } = useSolvency2Runs();
  const run = useRunSolvency2();
  const toast = useToast();
  const { data: ccyData } = useCurrencies();
  const currencies = ccyData?.currencies ?? [];

  const [currency, setCurrency] = useState('USD');
  const [asAt, setAsAt] = useState('');
  const [modules, setModules] = useState<{ name: string; scr: string }[]>([
    { name: 'Market', scr: '' },
    { name: 'Underwriting', scr: '' },
  ]);
  const [operationalRisk, setOperationalRisk] = useState('');
  const [adjustment, setAdjustment] = useState('');
  const [ownFunds, setOwnFunds] = useState('');
  const [linearMcr, setLinearMcr] = useState('');
  const [absoluteFloor, setAbsoluteFloor] = useState('');
  const [result, setResult] = useState<Solvency2RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setModule = (i: number, patch: Partial<{ name: string; scr: string }>) => {
    setModules((m) => m.map((row, idx) => idx === i ? { ...row, ...patch } : row));
  };
  const addModule = () => setModules((m) => [...m, { name: '', scr: '' }]);
  const removeModule = (i: number) => setModules((m) => (m.length <= 1 ? m : m.filter((_, idx) => idx !== i)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const mods = modules
      .filter((m) => m.name.trim())
      .map((m) => ({ name: m.name.trim(), scr: Number(m.scr) || 0 }));
    if (!mods.length) { setError('Add at least one risk module.'); return; }
    // Identity correlation matrix sized to the modules.
    const correlation = mods.map((_, i) => mods.map((_, j) => (i === j ? 1 : 0)));
    try {
      const res = await run.mutateAsync({
        currency,
        asAt: asAt || undefined,
        modules: mods,
        correlation,
        operationalRisk: Number(operationalRisk) || 0,
        adjustment: adjustment.trim() ? Number(adjustment) : undefined,
        linearMcr: Number(linearMcr) || 0,
        absoluteFloor: Number(absoluteFloor) || 0,
        ownFunds: Number(ownFunds) || 0,
      });
      setResult(res);
      toast.success('SCR calculation complete');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the SCR calculation.');
    }
  };

  const fmtMajor = (v: number) => `${formatNumber(Math.round(v))} ${currency}`;

  const runColumns: Column<Solvency2Run>[] = [
    { key: 'as_at', header: 'As at', sortValue: (r) => r.as_at ?? '', render: (r) => formatDate(r.as_at) },
    { key: 'ccy', header: 'CCY', render: (r) => r.currency },
    { key: 'scr', header: 'SCR', align: 'right', sortValue: (r) => r.scr_minor, render: (r) => <span className={shared.money}>{formatMoney(r.scr_minor, r.currency)}</span> },
    { key: 'mcr', header: 'MCR', align: 'right', sortValue: (r) => r.mcr_minor, render: (r) => <span className={shared.money}>{formatMoney(r.mcr_minor, r.currency)}</span> },
    { key: 'ratio', header: 'Solvency ratio', align: 'right', sortValue: (r) => r.solvency_ratio, render: (r) => formatPercent(r.solvency_ratio) },
  ];

  return (
    <div className={styles.tabBody}>
      <div className={styles.stack}>
        <Card>
          <CardHeader title="Run SCR" subtitle="Standard formula - values in major units. Correlation defaults to identity." />
          {canRun ? (
            <form onSubmit={submit} className={local.formStack}>
              <FormSection title="Run parameters">
                <FormField label="Currency" required>
                  <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
                  </Select>
                </FormField>
                <FormField label="As at" hint="Valuation date (defaults to today)">
                  <Input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} />
                </FormField>
              </FormSection>

              <FormSection title="Risk modules" description="Standard-formula risk modules and their SCR (major units). Correlation defaults to identity.">
                {modules.map((m, i) => (
                  <FormField key={i} label={`Module ${i + 1}`} hint="Name and SCR (major)">
                    <div className={`${shared.rowGap} ${local.moduleRow}`}>
                      <Input value={m.name} onChange={(e) => setModule(i, { name: e.target.value })} placeholder="Module name" />
                      <Input type="number" step="any" value={m.scr} onChange={(e) => setModule(i, { scr: e.target.value })} placeholder="SCR" />
                      <Button type="button" size="sm" variant="ghost" onClick={() => removeModule(i)} disabled={modules.length <= 1}>Remove</Button>
                    </div>
                  </FormField>
                ))}
                <div style={{ gridColumn: '1 / -1' }}>
                  <Button type="button" size="sm" variant="secondary" onClick={addModule}>Add module</Button>
                </div>
              </FormSection>

              <FormSection title="Aggregation & capital" description="Operational risk and adjustment feed the basic SCR; own funds and floors size the MCR and solvency ratio.">
                <FormField label="Operational risk" hint={`Major units of ${currency}.`}>
                  <Input type="number" step="any" value={operationalRisk} onChange={(e) => setOperationalRisk(e.target.value)} />
                </FormField>
                <FormField label="Adjustment" hint={`Optional. Major units of ${currency} (e.g. loss-absorbing capacity).`}>
                  <Input type="number" step="any" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} />
                </FormField>
                <FormField label="Own funds" hint={`Major units of ${currency}.`}>
                  <Input type="number" step="any" value={ownFunds} onChange={(e) => setOwnFunds(e.target.value)} />
                </FormField>
                <FormField label="Linear MCR" hint={`Major units of ${currency}.`}>
                  <Input type="number" step="any" value={linearMcr} onChange={(e) => setLinearMcr(e.target.value)} />
                </FormField>
                <FormField label="Absolute floor" hint={`Major units of ${currency}.`}>
                  <Input type="number" step="any" value={absoluteFloor} onChange={(e) => setAbsoluteFloor(e.target.value)} />
                </FormField>
              </FormSection>
              {error && <p className={local.error} role="alert">{error}</p>}
              <div>
                <Button variant="primary" onClick={submit} loading={run.isPending}>Run SCR</Button>
              </div>
            </form>
          ) : (
            <p className={shared.cellSub}>You need the regulatory:run permission to run an SCR calculation.</p>
          )}

          {result && (
            <div className={`${styles.measureGrid} ${local.resultBlock}`}>
              <KpiCard label="SCR" value={fmtMajor(result.scr)} hint={`Basic SCR ${fmtMajor(result.basicScr)}`} icon={<Sigma size={20} />} />
              <KpiCard label="MCR" value={fmtMajor(result.mcr)} icon={<Coins size={20} />} accent="var(--c-amber)" />
              <KpiCard label="Solvency ratio" value={formatPercent(result.solvencyRatio)} icon={<Percent size={20} />} accent="var(--c-green)" />
            </div>
          )}
        </Card>

        <Card padded={false}>
          <div className={local.cardPad}>
            <CardHeader title="Past runs" subtitle="Historical Solvency II calculations." />
          </div>
          <Table
            columns={runColumns}
            rows={data?.runs}
            loading={isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState title="No runs yet" message="Run an SCR calculation to see history here." icon={<ShieldCheck size={16} />} />}
          />
        </Card>
      </div>
    </div>
  );
}
