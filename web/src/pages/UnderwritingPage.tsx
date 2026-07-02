import { Fragment, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Gavel, Inbox, TrendingUp, Gauge, CheckCircle2, Percent,
  FileText, Calculator, Send, Play, XCircle, StickyNote,
  Download, Printer, FileSignature, FileBarChart,
  ShieldCheck, Clock, ThumbsUp, ThumbsDown, ArrowUpCircle,
  Sparkles, AlertTriangle, ScrollText, ClipboardCheck, GitCompareArrows,
  FolderOpen, FilePlus2, PenTool, History, ScanText,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, downloadFile } from '../lib/api';
import { printReport } from '../lib/uwReports';
import { useParties, useCurrencies } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Drawer } from '../components/Drawer';
import { AiActionPanel } from '../components/AiActionPanel';
import { FormField, FormSection, Input, Select, TextField, Textarea } from '../components/Form';
import { titleCase } from '../lib/format';
import styles from './UnderwritingPage.module.css';

/* ---------------- Domain constants (mirror @rios/domain stage machine) ---------------- */
const PIPELINE = ['SUBMISSION', 'TRIAGE', 'ANALYSIS', 'PRICING', 'REFERRAL', 'QUOTED', 'BOUND'] as const;
const TRANSITIONS: Record<string, string[]> = {
  SUBMISSION: ['TRIAGE', 'DECLINED', 'LAPSED'],
  TRIAGE: ['ANALYSIS', 'DECLINED', 'LAPSED'],
  ANALYSIS: ['PRICING', 'REFERRAL', 'DECLINED', 'LAPSED'],
  PRICING: ['REFERRAL', 'QUOTED', 'DECLINED', 'LAPSED'],
  REFERRAL: ['PRICING', 'QUOTED', 'DECLINED', 'LAPSED'],
  QUOTED: ['BOUND', 'REFERRAL', 'DECLINED', 'LAPSED'],
  BOUND: [], DECLINED: [], LAPSED: [],
};
const STAGE_COLOR: Record<string, 'slate' | 'blue' | 'indigo' | 'violet' | 'amber' | 'teal' | 'green' | 'red' | 'gray'> = {
  SUBMISSION: 'slate', TRIAGE: 'blue', ANALYSIS: 'indigo', PRICING: 'violet',
  REFERRAL: 'amber', QUOTED: 'teal', BOUND: 'green', DECLINED: 'red', LAPSED: 'gray',
};
const BAND_COLOR: Record<string, 'green' | 'amber' | 'orange' | 'red'> = {
  LOW: 'green', MODERATE: 'amber', ELEVATED: 'orange', HIGH: 'red',
};
/* ---------------- Model catalog (served by /api/underwriting/models) ---------------- */
type ModelFieldType = 'number' | 'percent' | 'money' | 'text' | 'select' | 'boolean';
interface ModelField { key: string; label: string; type: ModelFieldType; group?: string; options?: string[]; unit?: string; help?: string; required?: boolean; }
interface ModelStructure { key: string; label: string; basis: 'PROPORTIONAL' | 'NON_PROPORTIONAL'; blurb: string; fields: ModelField[]; }
interface ModelLine { key: string; label: string; hazard: number; catExposed: boolean; blurb: string; fields: ModelField[]; }
interface ModelCatalog { structures: ModelStructure[]; lines: ModelLine[]; }
interface TermsCheck { ok: boolean; missing: string[]; unknown: string[]; }
type ApprovalLevel = 'UNDERWRITER' | 'SENIOR_UW' | 'CHIEF_UW' | 'COMMITTEE';
interface Approval {
  id: string; level: ApprovalLevel; reason: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED';
  slaDueAt: string | null; decidedAt: string | null; note: string | null; createdAt: string; slaBreached: boolean;
}
interface ApprovalRequirement { level: ApprovalLevel; referralRequired: boolean; reason: string; slaHours: number; chain: ApprovalLevel[]; }
interface Clause { code: string; title: string; rationale: string; }
interface InfoGap { field: string; label: string; severity: 'required' | 'recommended'; }
interface AttentionFlag { code: string; severity: 'high' | 'medium' | 'low'; message: string; }
interface SimilarRisk {
  id: string; reference: string; title: string; structure: string | null; lineOfBusiness: string | null;
  stage: string; currency: string; riskScore: number | null; riskBand: string | null;
  lossRatioPct: number | null; estPremiumMinor: number | null; targetPremiumMinor: number | null;
}
interface Advisor { clauses: Clause[]; missingInfo: InfoGap[]; flags: AttentionFlag[]; executiveSummary: string; similar: SimilarRisk[]; }
interface Extraction { kind: string; confidence: number; fields: { key: string; value: string; confidence: number }[]; unresolved: string[]; provider: string; }
interface SubmissionDoc {
  id: string; name: string; kind: string; version: number; status: string;
  extraction: Extraction | null; supersedesId: string | null; signature: string | null;
  signedAt: string | null; createdAt: string; uploadedBy: string | null;
}

/* ---------------- Types ---------------- */
interface SubmissionRow {
  id: string; reference: string; title: string; kind: string; basis: string | null; structure: string | null;
  lineOfBusiness: string | null; currency: string; stage: string; riskScore: number | null; riskBand: string | null;
  estPremiumMinor: number | null; targetPremiumMinor: number | null; cedentName: string | null; brokerName: string | null;
}
interface Kpis { open: number; bound: number; declined: number; lapsed: number; pipelineEpiMinor: number; avgRiskScore: number; hitRatioPct: number; byStage: Record<string, number>; }
interface ScoreContribution { factor: string; points: number; detail: string; }
interface Activity { kind: string; fromStage: string | null; toStage: string | null; note: string | null; createdAt: string; }
interface SubmissionDetail extends SubmissionRow {
  inception: string | null; expiry: string | null; territory: string | null;
  sumInsuredMinor: number | null; attachmentMinor: number | null; limitMinor: number | null;
  lossRatioPct: number | null; catExposed: boolean; classHazard: number | null; priorClaims: number | null; yearsWithCedent: number | null;
  scoreBreakdown: ScoreContribution[]; activity: Activity[];
  terms: Record<string, unknown> | null; termsCheck?: TermsCheck;
  approvals?: Approval[]; approvalRequirement?: ApprovalRequirement;
}

interface ScenarioBase {
  lossRatioPct: number; expenseRatioPct: number; combinedRatioPct: number; underwritingResultMinor: number; marginPct: number;
}
interface ScenarioCell {
  rateChange: number; lossShock: number; premiumMinor: number; expectedLossMinor: number; combinedRatioPct: number; underwritingResultMinor: number;
}
interface SensitivityPoint { driver: string; value: number; combinedRatioPct: number; }
interface ScenarioResult {
  basePremiumMinor: number; expectedLossMinor: number;
  base: ScenarioBase;
  grid: ScenarioCell[];
  sensitivity: { rate: SensitivityPoint[]; loss: SensitivityPoint[] };
  rateChanges: number[]; lossShocks: number[];
}

const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
const compact = (minor: number, ccy = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);

/* ---------------- Data hooks ---------------- */
function useModelCatalog() {
  return useQuery({ queryKey: ['uw', 'models'], queryFn: () => api<ModelCatalog>('/api/underwriting/models'), staleTime: 60 * 60 * 1000 });
}
function useKpis() { return useQuery({ queryKey: ['uw', 'kpis'], queryFn: () => api<Kpis>('/api/underwriting/kpis') }); }
function useSubmissions(stage: string) {
  return useQuery({ queryKey: ['uw', 'submissions', stage], queryFn: () => api<{ submissions: SubmissionRow[] }>(`/api/underwriting/submissions${stage ? `?stage=${stage}` : ''}`) });
}
function useSubmission(id: string | null) {
  return useQuery({ queryKey: ['uw', 'submission', id], queryFn: () => api<SubmissionDetail>(`/api/underwriting/submissions/${id}`), enabled: !!id });
}
function useAdvisor(id: string | null) {
  return useQuery({ queryKey: ['uw', 'advisor', id], queryFn: () => api<Advisor>(`/api/underwriting/submissions/${id}/advisor`), enabled: !!id });
}
function useDocuments(id: string | null) {
  return useQuery({ queryKey: ['uw', 'documents', id], queryFn: () => api<{ documents: SubmissionDoc[] }>(`/api/underwriting/submissions/${id}/documents`), enabled: !!id });
}
const DOC_KINDS = ['SLIP', 'SOV', 'LOSS_RUN', 'WORDING', 'FINANCIALS', 'BORDEREAU', 'EMAIL', 'OTHER'] as const;

export function UnderwritingPage() {
  const [params, setParams] = useSearchParams();
  const [stage, setStage] = useState('');
  const [showNew, setShowNew] = useState(false);
  // Deep-link: /underwriting?submission=<id> opens that submission's drawer, so
  // other modules (broker/cedent portfolios) can link straight into it.
  const [detailId, setDetailId] = useState<string | null>(params.get('submission'));
  const kpis = useKpis();
  const list = useSubmissions(stage);
  const k = kpis.data;

  const columns: Column<SubmissionRow>[] = [
    {
      key: 'ref', header: 'Submission', sortValue: (r) => r.reference,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.title}</div>
          <div className={styles.cellRef}>{r.reference} · {r.cedentName ?? 'Cedent TBC'}</div>
        </div>
      ),
    },
    { key: 'structure', header: 'Structure', render: (r) => <span className={styles.cellSub}>{r.structure ? titleCase(r.structure.replace(/_/g, ' ')) : titleCase(r.kind)}</span> },
    { key: 'risk', header: 'Risk', render: (r) => r.riskBand ? <Badge color={BAND_COLOR[r.riskBand] ?? 'gray'}>{r.riskScore} · {titleCase(r.riskBand)}</Badge> : <span className={styles.cellSub}>—</span> },
    { key: 'epi', header: 'EPI', align: 'right', render: (r) => <span className={styles.num}>{money(r.estPremiumMinor, r.currency)}</span> },
    { key: 'stage', header: 'Stage', align: 'right', render: (r) => <Badge color={STAGE_COLOR[r.stage] ?? 'slate'}>{titleCase(r.stage)}</Badge> },
  ];

  const stageFilters = ['', ...PIPELINE, 'DECLINED', 'LAPSED'];

  return (
    <>
      <PageHeader
        title="Underwriting Workbench"
        description="Submission-to-bind lifecycle: triage, risk score, price, refer, quote and bind — with a full audit trail."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Underwriting' }]}
        actions={<>
          <Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadFile(`/api/underwriting/export.csv${stage ? `?stage=${stage}` : ''}`, 'underwriting-pipeline.csv')}>Export CSV</Button>
          <Button variant="primary" icon={<Gavel size={16} />} onClick={() => setShowNew(true)}>New submission</Button>
        </>}
      />

      <div className={styles.kpis}>
        <KpiCard label="Open submissions" value={String(k?.open ?? 0)} hint="In the pipeline" icon={<Inbox size={20} />} accent="var(--primary)" loading={kpis.isLoading} />
        <KpiCard label="Pipeline EPI" value={k ? compact(k.pipelineEpiMinor) : '—'} hint="Estimated premium in flight" icon={<TrendingUp size={20} />} accent="var(--accent-cyan)" loading={kpis.isLoading} />
        <KpiCard label="Avg risk score" value={String(k?.avgRiskScore ?? 0)} hint="0 = benign · 100 = severe" icon={<Gauge size={20} />} accent="var(--accent-violet)" loading={kpis.isLoading} />
        <KpiCard label="Bound" value={String(k?.bound ?? 0)} hint="Won this book" icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" loading={kpis.isLoading} />
        <KpiCard label="Hit ratio" value={`${k?.hitRatioPct ?? 0}%`} hint="Bound of decided" icon={<Percent size={20} />} accent="var(--accent-orange)" loading={kpis.isLoading} />
      </div>

      <AiActionPanel
        title="AI underwriting recommendation"
        buttonLabel="AI insight"
        insightDomain="underwriting"
        context={{
          openSubmissions: k?.open ?? 0,
          pipelineEpi: k ? compact(k.pipelineEpiMinor) : 'n/a',
          avgRiskScore: k?.avgRiskScore ?? 0,
          hitRatio: `${k?.hitRatioPct ?? 0}%`,
        }}
      />

      <Card padded={false}>
        <CardHeader title="Submissions" subtitle="Every risk moving through underwriting" />
        <div className={styles.filterBar}>
          {stageFilters.map((s) => (
            <button
              key={s || 'all'}
              className={`${styles.filterChip} ${stage === s ? styles.filterActive : ''}`}
              onClick={() => setStage(s)}
            >
              {s ? titleCase(s) : 'All'}
              {s && k?.byStage?.[s] ? <span className={styles.filterCount}>{k.byStage[s]}</span> : null}
            </button>
          ))}
        </div>
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={list.data?.submissions}
            loading={list.isLoading}
            rowKey={(r) => r.id}
            onRowClick={(r) => setDetailId(r.id)}
            empty={<EmptyState icon={<FileText size={18} />} title="No submissions" message="Create a submission to start the underwriting lifecycle." />}
            skeletonRows={6}
          />
        </div>
      </Card>

      <NewSubmissionModal open={showNew} onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setDetailId(id); }} />
      <SubmissionDrawer id={detailId} onClose={() => { setDetailId(null); if (params.has('submission')) { params.delete('submission'); setParams(params, { replace: true }); } }} />
    </>
  );
}

/* ---------------- New submission slip ---------------- */
function NewSubmissionModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: partyData } = useParties({});
  const { data: ccy } = useCurrencies();
  const { data: catalog } = useModelCatalog();
  const { data: allSubs } = useSubmissions('');
  const parties = partyData?.parties ?? [];
  const currencies = ccy?.currencies ?? [];
  const structures = catalog?.structures ?? [];
  const lines = catalog?.lines ?? [];
  const priorSubmissions = allSubs?.submissions ?? [];

  const [f, setF] = useState({
    title: '', kind: 'TREATY', basis: 'NON_PROPORTIONAL', structure: 'CAT_XL', lineOfBusiness: '',
    cedentPartyId: '', brokerPartyId: '', currency: 'USD', inception: '', expiry: '', territory: '',
    sumInsured: '', attachment: '', limit: '', estPremium: '',
    lossRatioPct: '', catExposed: false, classHazard: '3', priorClaims: '', yearsWithCedent: '', capacityUtilPct: '',
    renewalOfId: '', expiringPremium: '',
  });
  // Model-specific term values, keyed by field key. Kept as strings/booleans and
  // coerced on submit against the field type (money → integer minor units).
  const [terms, setTerms] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const numv = (v: string) => (v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const setTerm = (key: string, v: string | boolean) => setTerms((p) => ({ ...p, [key]: v }));

  const selectedStructure = structures.find((s) => s.key === f.structure);
  const selectedLine = lines.find((l) => l.key === f.lineOfBusiness);
  const modelFields: ModelField[] = [...(selectedStructure?.fields ?? []), ...(selectedLine?.fields ?? [])];
  // Group model fields by their `group` heading, preserving first-seen order.
  const groupedFields: [string, ModelField[]][] = (() => {
    const map = new Map<string, ModelField[]>();
    for (const fld of modelFields) {
      const g = fld.group ?? 'Terms';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(fld);
    }
    return [...map.entries()];
  })();

  // Picking a structure aligns the basis; picking a line seeds hazard + cat flag.
  const onStructure = (key: string) => {
    const st = structures.find((s) => s.key === key);
    setF((p) => ({ ...p, structure: key, basis: st?.basis ?? p.basis }));
  };
  const onLine = (key: string) => {
    const l = lines.find((x) => x.key === key);
    setF((p) => ({ ...p, lineOfBusiness: key, ...(l ? { classHazard: String(l.hazard), catExposed: l.catExposed } : {}) }));
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string; reference: string; riskBand: string; termsCheck?: TermsCheck }>('/api/underwriting/submissions', { body }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['uw'] });
      const gap = res.termsCheck && !res.termsCheck.ok ? ` · ${res.termsCheck.missing.length} term(s) still to capture` : '';
      toast.success(`Submission ${res.reference} created · risk ${titleCase(res.riskBand)}${gap}`);
      onCreated(res.id);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the submission.'),
  });

  // Coerce term inputs against their declared type: money → minor units (×100),
  // percent/number → number, boolean stays boolean, select/text stay string.
  const buildTerms = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const fld of modelFields) {
      const raw = terms[fld.key];
      if (raw === undefined || raw === '' ) continue;
      if (fld.type === 'boolean') { out[fld.key] = Boolean(raw); continue; }
      if (fld.type === 'text' || fld.type === 'select') { out[fld.key] = String(raw); continue; }
      const n = Number(raw);
      if (Number.isNaN(n)) continue;
      out[fld.key] = fld.type === 'money' ? Math.round(n * 100) : n;
    }
    return out;
  };

  const submit = () => {
    setError(null);
    create.mutate({
      title: f.title, kind: f.kind, basis: f.basis, structure: f.structure || undefined,
      lineOfBusiness: f.lineOfBusiness || undefined, cedentPartyId: f.cedentPartyId || undefined, brokerPartyId: f.brokerPartyId || undefined,
      currency: f.currency, inception: f.inception || undefined, expiry: f.expiry || undefined, territory: f.territory || undefined,
      sumInsured: numv(f.sumInsured), attachment: numv(f.attachment), limit: numv(f.limit), estPremium: numv(f.estPremium),
      lossRatioPct: numv(f.lossRatioPct), catExposed: f.catExposed, classHazard: numv(f.classHazard),
      priorClaims: numv(f.priorClaims), yearsWithCedent: numv(f.yearsWithCedent), capacityUtilPct: numv(f.capacityUtilPct),
      renewalOfId: f.renewalOfId || undefined, expiringPremium: numv(f.expiringPremium),
      terms: buildTerms(),
    });
  };

  const partyName = (p: { shortName: string | null; legalName: string }) => p.shortName || p.legalName;

  return (
    <Modal
      open={open} onClose={onClose} size="lg"
      title="New submission"
      description="Capture the risk and its factors. RIOS scores it on the spot; you can price and progress it through the workbench."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!f.title.trim()}>Create & score</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Risk identification">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Submission title" value={f.title} onChange={set('title')} required placeholder="e.g. North Atlantic Property Cat XL 2026" />
          </div>
          <FormField label="Kind"><Select value={f.kind} onChange={(e) => set('kind')(e.target.value)}><option value="TREATY">Treaty</option><option value="FACULTATIVE">Facultative</option></Select></FormField>
          <FormField label="Structure / model">
            <Select value={f.structure} onChange={(e) => onStructure(e.target.value)}>
              <option value="">—</option>
              {structures.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
          </FormField>
          <FormField label="Basis"><Select value={f.basis} onChange={(e) => set('basis')(e.target.value)}><option value="PROPORTIONAL">Proportional</option><option value="NON_PROPORTIONAL">Non-proportional</option></Select></FormField>
          <FormField label="Line of business">
            <Select value={f.lineOfBusiness} onChange={(e) => onLine(e.target.value)}>
              <option value="">Unspecified</option>
              {lines.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency"><Select value={f.currency} onChange={(e) => set('currency')(e.target.value)}>{(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => <option key={c} value={c}>{c}</option>)}</Select></FormField>
        </FormSection>

        {(selectedStructure || selectedLine) && (
          <p className={styles.modelBlurb}>
            {selectedStructure?.blurb}{selectedStructure && selectedLine ? ' ' : ''}{selectedLine?.blurb}
          </p>
        )}

        <FormSection title="Parties & period">
          <FormField label="Cedent / reinsured"><Select value={f.cedentPartyId} onChange={(e) => set('cedentPartyId')(e.target.value)}><option value="">Select…</option>{parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}</Select></FormField>
          <FormField label="Broker"><Select value={f.brokerPartyId} onChange={(e) => set('brokerPartyId')(e.target.value)}><option value="">Direct / none</option>{parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}</Select></FormField>
          <TextField label="Inception" type="date" value={f.inception} onChange={set('inception')} />
          <TextField label="Expiry" type="date" value={f.expiry} onChange={set('expiry')} />
          <div style={{ gridColumn: '1 / -1' }}><TextField label="Territory" value={f.territory} onChange={set('territory')} placeholder="e.g. Worldwide excl. USA & Canada" /></div>
        </FormSection>

        <FormSection title="Renewal" description="Link an expiring submission to track rate change and retention.">
          <FormField label="Renewal of (prior submission)">
            <Select value={f.renewalOfId} onChange={(e) => set('renewalOfId')(e.target.value)}>
              <option value="">New business</option>
              {priorSubmissions.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.title}</option>)}
            </Select>
          </FormField>
          <TextField label="Expiring premium (major)" type="number" value={f.expiringPremium} onChange={set('expiringPremium')} placeholder="Prior-year premium" />
        </FormSection>

        <FormSection title="Headline terms & premium">
          <TextField label="Sum insured / limit (major)" type="number" value={f.sumInsured} onChange={set('sumInsured')} placeholder="e.g. 50000000" />
          <TextField label="Attachment (major)" type="number" value={f.attachment} onChange={set('attachment')} placeholder="e.g. 1000000" />
          <TextField label="Layer limit (major)" type="number" value={f.limit} onChange={set('limit')} placeholder="e.g. 4000000" />
          <TextField label="Estimated premium income (major)" type="number" value={f.estPremium} onChange={set('estPremium')} placeholder="e.g. 5000000" />
        </FormSection>

        {/* Model-specific slip terms, rendered from the catalog for the chosen structure × line. */}
        {groupedFields.map(([group, fields]) => (
          <FormSection key={group} title={`${selectedStructure?.label ?? selectedLine?.label ?? 'Model'} · ${group}`}>
            {fields.map((fld) => (
              <ModelFieldInput key={fld.key} field={fld} value={terms[fld.key]} onChange={(v) => setTerm(fld.key, v)} currency={f.currency} />
            ))}
          </FormSection>
        ))}

        <FormSection title="Risk factors" description="These drive the transparent risk score.">
          <TextField label="Historical loss ratio %" type="number" value={f.lossRatioPct} onChange={set('lossRatioPct')} placeholder="e.g. 65" />
          <FormField label="Class hazard (1–5)"><Select value={f.classHazard} onChange={(e) => set('classHazard')(e.target.value)}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}</option>)}</Select></FormField>
          <TextField label="Capacity utilisation %" type="number" value={f.capacityUtilPct} onChange={set('capacityUtilPct')} placeholder="e.g. 40" />
          <TextField label="Prior claims" type="number" value={f.priorClaims} onChange={set('priorClaims')} placeholder="e.g. 2" />
          <TextField label="Years with cedent" type="number" value={f.yearsWithCedent} onChange={set('yearsWithCedent')} placeholder="e.g. 3" />
          <FormField label="Catastrophe exposed">
            <label className={styles.check}><input type="checkbox" checked={f.catExposed} onChange={(e) => setF((p) => ({ ...p, catExposed: e.target.checked }))} /> Materially cat-exposed</label>
          </FormField>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/* One model-catalog field → the right input. Money/percent/number use numeric
 * inputs; select renders its options; boolean is a checkbox. */
function ModelFieldInput({ field, value, onChange, currency }: {
  field: ModelField; value: string | boolean | undefined; onChange: (v: string | boolean) => void; currency: string;
}) {
  const req = field.required ? ' *' : '';
  if (field.type === 'boolean') {
    return (
      <FormField label={field.label + req} hint={field.help}>
        <label className={styles.check}>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> Yes
        </label>
      </FormField>
    );
  }
  if (field.type === 'select') {
    return (
      <FormField label={field.label + req} hint={field.help}>
        <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      </FormField>
    );
  }
  const unit = field.type === 'money' ? `${currency} (major)` : field.type === 'percent' ? '%' : field.unit;
  const label = unit ? `${field.label}${req} · ${unit}` : field.label + req;
  return (
    <TextField label={label} hint={field.help} type="number" value={String(value ?? '')} onChange={(v) => onChange(v)} />
  );
}

/* ---------------- Submission detail drawer ---------------- */
function SubmissionDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: s, isLoading } = useSubmission(id);
  const { data: catalog } = useModelCatalog();
  const { data: advisor, isLoading: advisorLoading } = useAdvisor(id);
  const { data: docsData } = useDocuments(id);
  const { hasPermission } = useAuth();
  const canApprove = hasPermission('underwriting:approve');
  const [note, setNote] = useState('');
  const [scenario, setScenario] = useState<ScenarioResult | null>(null);

  const runScenarios = useMutation({
    mutationFn: () => api<ScenarioResult>(`/api/underwriting/submissions/${id}/scenarios`, { body: {} }),
    onSuccess: (r) => { setScenario(r); toast.success('Pricing scenarios computed'); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not run scenarios'),
  });
  useEffect(() => { setScenario(null); }, [id]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['uw'] }); };
  const act = <T,>(path: string, body: unknown, ok: string) =>
    api<T>(`/api/underwriting/submissions/${id}/${path}`, { body }).then((r) => { invalidate(); toast.success(ok); return r; })
      .catch((e) => { toast.error(e instanceof ApiError ? e.message : 'Action failed'); throw e; });

  const transition = useMutation({ mutationFn: (to: string) => act(`transition`, { to }, `Moved to ${titleCase(to)}`) });
  const price = useMutation({ mutationFn: () => act(`price`, {}, 'Technical premium computed') });
  const rescore = useMutation({ mutationFn: () => act(`score`, {}, 'Risk re-scored') });
  const addNote = useMutation({ mutationFn: (n: string) => act(`note`, { note: n }, 'Note added').then(() => setNote('')) });
  const raiseReferral = useMutation({ mutationFn: () => act<{ referralRequired: boolean; level: string }>(`approvals`, {}, 'Referral raised') });
  const addDoc = useMutation({
    mutationFn: (body: { name: string; kind: string }) => act(`documents`, body, `Added ${body.name}`),
  });
  const supersedeDoc = useMutation({
    mutationFn: (docId: string) => api(`/api/underwriting/documents/${docId}/supersede`, { body: {} })
      .then((r) => { invalidate(); toast.success('New version created'); return r; })
      .catch((e) => { toast.error(e instanceof ApiError ? e.message : 'Failed'); throw e; }),
  });
  const signDoc = useMutation({
    mutationFn: (docId: string) => api(`/api/underwriting/documents/${docId}/sign`, { body: {} })
      .then((r) => { invalidate(); toast.success('Document signed'); return r; })
      .catch((e) => { toast.error(e instanceof ApiError ? e.message : 'Failed'); throw e; }),
  });
  const decide = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: 'APPROVED' | 'REJECTED' }) =>
      api(`/api/underwriting/approvals/${approvalId}/decision`, { body: { decision } })
        .then((r) => { invalidate(); toast.success(`Referral ${decision.toLowerCase()}`); return r; })
        .catch((e) => { toast.error(e instanceof ApiError ? e.message : 'Decision failed'); throw e; }),
  });

  const allowed = s ? (TRANSITIONS[s.stage] ?? []) : [];

  return (
    <Drawer open={!!id} onClose={onClose} width={520}
      title={s ? <span className={styles.drawerTitle}><Gavel size={16} /> {s.title}</span> : 'Submission'}
      subtitle={s ? `${s.reference} · ${s.cedentName ?? 'Cedent TBC'}${s.brokerName ? ' · ' + s.brokerName : ''}` : undefined}
    >
      {isLoading || !s ? <p className={styles.cellSub}>Loading…</p> : (
        <div className={styles.drawer}>
          {/* Stage tracker */}
          <div className={styles.tracker}>
            {PIPELINE.map((st, i) => {
              const idx = PIPELINE.indexOf(s.stage as typeof PIPELINE[number]);
              const done = idx >= 0 && i < idx;
              const current = s.stage === st;
              return (
                <div key={st} className={`${styles.step} ${done ? styles.stepDone : ''} ${current ? styles.stepCurrent : ''}`}>
                  <span className={styles.stepDot}>{i + 1}</span>
                  <span className={styles.stepLabel}>{titleCase(st)}</span>
                </div>
              );
            })}
          </div>
          {(s.stage === 'DECLINED' || s.stage === 'LAPSED') && (
            <div className={styles.terminalBanner}><XCircle size={15} /> {titleCase(s.stage)}</div>
          )}

          {/* Risk score gauge + breakdown */}
          <Card padded>
            <CardHeader title="Risk score" subtitle="Transparent, factor-by-factor" actions={<Button size="sm" variant="secondary" onClick={() => rescore.mutate()} loading={rescore.isPending}>Re-score</Button>} />
            <div className={styles.gaugeRow}>
              <div className={styles.gaugeValue} data-band={s.riskBand}>{s.riskScore ?? '—'}</div>
              <div className={styles.gaugeBarWrap}>
                <div className={styles.gaugeBar}><span className={styles.gaugeFill} data-band={s.riskBand} style={{ width: `${s.riskScore ?? 0}%` }} /></div>
                <div className={styles.gaugeMeta}>{s.riskBand ? <Badge color={BAND_COLOR[s.riskBand] ?? 'gray'}>{titleCase(s.riskBand)}</Badge> : null}</div>
              </div>
            </div>
            <ul className={styles.breakdown}>
              {s.scoreBreakdown.map((c) => (
                <li key={c.factor}>
                  <span className={styles.bkFactor}>{c.factor}</span>
                  <span className={styles.bkDetail}>{c.detail}</span>
                  <span className={`${styles.bkPoints} ${c.points < 0 ? styles.bkCredit : ''}`}>{c.points > 0 ? '+' : ''}{c.points}</span>
                </li>
              ))}
            </ul>
          </Card>

          {/* Key facts + pricing */}
          <div className={styles.facts}>
            <Fact label="Structure" value={s.structure ? titleCase(s.structure.replace(/_/g, ' ')) : titleCase(s.kind)} />
            <Fact label="Line of business" value={s.lineOfBusiness ? titleCase(s.lineOfBusiness) : '—'} />
            <Fact label="Period" value={s.inception ? `${s.inception} → ${s.expiry ?? '?'}` : '—'} />
            <Fact label="Territory" value={s.territory ?? '—'} />
            <Fact label="EPI" value={money(s.estPremiumMinor, s.currency)} />
            <Fact label="Technical premium" value={s.targetPremiumMinor ? money(s.targetPremiumMinor, s.currency) : <Button size="sm" variant="secondary" icon={<Calculator size={14} />} onClick={() => price.mutate()} loading={price.isPending}>Price</Button>} />
            <Fact label="Loss ratio" value={s.lossRatioPct != null ? `${s.lossRatioPct}%` : '—'} />
            <Fact label="Cat exposed" value={s.catExposed ? 'Yes' : 'No'} />
          </div>

          {/* AI underwriting advisor */}
          <AdvisorCard advisor={advisor} loading={advisorLoading} currency={s.currency} />

          {/* Model-specific slip terms */}
          <ModelTermsCard submission={s} catalog={catalog} />

          {/* Workflow actions */}
          <Card padded>
            <CardHeader title="Progress" subtitle="Advance, refer, quote, bind or decline" />
            {allowed.length ? (
              <div className={styles.actions}>
                {allowed.map((to) => {
                  const danger = to === 'DECLINED' || to === 'LAPSED';
                  const icon = to === 'BOUND' ? <CheckCircle2 size={14} /> : to === 'REFERRAL' ? <Send size={14} /> : danger ? <XCircle size={14} /> : <Play size={14} />;
                  return (
                    <Button key={to} size="sm" variant={to === 'BOUND' ? 'primary' : danger ? 'danger' : 'secondary'} icon={icon} loading={transition.isPending} onClick={() => transition.mutate(to)}>
                      {to === 'BOUND' ? 'Bind' : titleCase(to)}
                    </Button>
                  );
                })}
              </div>
            ) : <p className={styles.cellSub}>This submission is {titleCase(s.stage)} — no further moves.</p>}
          </Card>

          {/* Approval / referral engine */}
          <ApprovalCard
            submission={s}
            canApprove={canApprove}
            onRaise={() => raiseReferral.mutate()}
            raising={raiseReferral.isPending}
            onDecide={(approvalId, decision) => decide.mutate({ approvalId, decision })}
            deciding={decide.isPending}
          />

          {/* Documents — printable slip / quote / summary */}
          <Card padded>
            <CardHeader title="Documents" subtitle="Generate a market-ready slip, quote or summary (print → PDF)" />
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" icon={<FileSignature size={14} />} onClick={() => printReport('slip', s, catalog, scenario)}>Slip</Button>
              <Button size="sm" variant="secondary" icon={<Printer size={14} />} onClick={() => printReport('quote', s, catalog, scenario)}>Quote</Button>
              <Button size="sm" variant="secondary" icon={<FileBarChart size={14} />} onClick={() => printReport('summary', s, catalog, scenario)}>UW summary</Button>
            </div>
          </Card>

          {/* Data room — versioned documents with extraction + signature */}
          <DataRoomCard
            documents={docsData?.documents ?? []}
            onAdd={(name, kind) => addDoc.mutate({ name, kind })}
            adding={addDoc.isPending}
            onSupersede={(docId) => supersedeDoc.mutate(docId)}
            onSign={(docId) => signDoc.mutate(docId)}
            busy={supersedeDoc.isPending || signDoc.isPending}
          />

          {/* Pricing scenarios (what-if) */}
          <Card padded>
            <CardHeader
              title="Pricing scenarios"
              subtitle="What-if combined ratio across rate & loss shocks"
              actions={<Button size="sm" variant="secondary" icon={<Calculator size={14} />} loading={runScenarios.isPending} onClick={() => runScenarios.mutate()}>Run</Button>}
            />
            {!scenario ? (
              <p className={styles.cellSub}>Run scenarios to model combined ratio sensitivity to rate change and loss shocks.</p>
            ) : (
              <div className={styles.scenario}>
                {/* Base ratio chips */}
                <div className={styles.statChips}>
                  <StatChip label="Loss ratio" value={`${scenario.base.lossRatioPct}%`} />
                  <StatChip label="Expense ratio" value={`${scenario.base.expenseRatioPct}%`} />
                  <StatChip label="Combined ratio" value={`${scenario.base.combinedRatioPct}%`} headline band={crBand(scenario.base.combinedRatioPct)} />
                  <StatChip label="Margin" value={`${scenario.base.marginPct}%`} />
                </div>

                {/* Combined-ratio matrix */}
                <div className={styles.matrixWrap}>
                  <div className={styles.matrixLabel}>Combined ratio · rate change × loss shock</div>
                  <div
                    className={styles.matrix}
                    style={{ gridTemplateColumns: `auto repeat(${scenario.rateChanges.length}, minmax(48px, 1fr))` }}
                  >
                    <span className={styles.matrixCorner} />
                    {scenario.rateChanges.map((rc) => (
                      <span key={`col-${rc}`} className={styles.matrixHead}>{fmtRate(rc)}</span>
                    ))}
                    {scenario.lossShocks.map((ls) => (
                      <Fragment key={`row-${ls}`}>
                        <span className={styles.matrixRowHead}>{fmtShock(ls)}</span>
                        {scenario.rateChanges.map((rc) => {
                          const cell = scenario.grid.find((g) => g.rateChange === rc && g.lossShock === ls);
                          const cr = cell?.combinedRatioPct;
                          return (
                            <span
                              key={`cell-${rc}-${ls}`}
                              className={styles.matrixCell}
                              data-band={cr == null ? undefined : crBand(cr)}
                            >
                              {cr == null ? '—' : `${cr}%`}
                            </span>
                          );
                        })}
                      </Fragment>
                    ))}
                  </div>
                </div>

                {/* Sensitivity readout */}
                <div className={styles.sensBlock}>
                  <SensRow label="Rate change" points={scenario.sensitivity.rate} fmt={fmtRate} />
                  <SensRow label="Loss shock" points={scenario.sensitivity.loss} fmt={fmtShock} />
                </div>
              </div>
            )}
          </Card>

          {/* Activity trail */}
          <Card padded>
            <CardHeader title="Activity" subtitle="Audited underwriting trail" />
            <div className={styles.noteRow}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an underwriting note…" />
              <Button size="sm" variant="secondary" icon={<StickyNote size={14} />} disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate(note.trim())}>Add</Button>
            </div>
            <ul className={styles.activity}>
              {s.activity.map((a, i) => (
                <li key={i}>
                  <span className={styles.actKind} data-kind={a.kind}>{titleCase(a.kind)}</span>
                  <span className={styles.actNote}>
                    {a.fromStage && a.toStage ? `${titleCase(a.fromStage)} → ${titleCase(a.toStage)}` : ''}
                    {a.note ? (a.fromStage ? ' · ' : '') + a.note : ''}
                  </span>
                  <span className={styles.actTime}>{new Date(a.createdAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </Drawer>
  );
}

/* The deterministic AI underwriting advisor: executive summary, consistency
 * flags, recommended clauses, missing information and similar-risk benchmarking. */
const FLAG_COLOR: Record<string, 'red' | 'amber' | 'slate'> = { high: 'red', medium: 'amber', low: 'slate' };

function AdvisorCard({ advisor, loading, currency }: { advisor?: Advisor; loading: boolean; currency: string }) {
  return (
    <Card padded>
      <CardHeader title={<span className={styles.drawerTitle}><Sparkles size={15} /> Underwriting advisor</span>} subtitle="Grounded, rule-based decision support" />
      {loading || !advisor ? (
        <p className={styles.cellSub}>Analysing submission…</p>
      ) : (
        <div className={styles.advisor}>
          <p className={styles.advisorSummary}>{advisor.executiveSummary}</p>

          {advisor.flags.length > 0 && (
            <div className={styles.advisorBlock}>
              <div className={styles.advisorLabel}><AlertTriangle size={13} /> Attention flags</div>
              <ul className={styles.flagList}>
                {advisor.flags.map((f) => (
                  <li key={f.code} className={styles.flagItem}>
                    <Badge color={FLAG_COLOR[f.severity] ?? 'slate'}>{titleCase(f.severity)}</Badge>
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {advisor.missingInfo.length > 0 && (
            <div className={styles.advisorBlock}>
              <div className={styles.advisorLabel}><ClipboardCheck size={13} /> Missing information</div>
              <div className={styles.chipRow}>
                {advisor.missingInfo.map((g) => (
                  <span key={g.field} className={`${styles.infoChip} ${g.severity === 'required' ? styles.infoChipReq : ''}`}>{g.label}</span>
                ))}
              </div>
            </div>
          )}

          <div className={styles.advisorBlock}>
            <div className={styles.advisorLabel}><ScrollText size={13} /> Recommended clauses</div>
            <div className={styles.chipRow}>
              {advisor.clauses.map((c) => <span key={c.code} className={styles.clauseChip} title={c.rationale}>{c.title}</span>)}
            </div>
          </div>

          {advisor.similar.length > 0 && (
            <div className={styles.advisorBlock}>
              <div className={styles.advisorLabel}><GitCompareArrows size={13} /> Similar risks in the book</div>
              <ul className={styles.similarList}>
                {advisor.similar.map((r) => (
                  <li key={r.id} className={styles.similarItem}>
                    <span className={styles.similarTitle}>{r.title}</span>
                    <span className={styles.similarMeta}>
                      {r.riskBand ? <Badge color={BAND_COLOR[r.riskBand] ?? 'gray'}>{r.riskScore}</Badge> : null}
                      {r.lossRatioPct != null ? <span className={styles.cellSub}>LR {r.lossRatioPct}%</span> : null}
                      <span className={styles.num}>{money(r.targetPremiumMinor ?? r.estPremiumMinor, r.currency || currency)}</span>
                      <Badge color={STAGE_COLOR[r.stage] ?? 'slate'}>{titleCase(r.stage)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* The submission data room: a versioned document register with OCR/AI extraction
 * and a lightweight digital-signature seal. */
const DOC_KIND_LABEL: Record<string, string> = {
  SLIP: 'Slip', SOV: 'SOV', LOSS_RUN: 'Loss run', WORDING: 'Wording', FINANCIALS: 'Financials', BORDEREAU: 'Bordereau', EMAIL: 'Email', OTHER: 'Other',
};
const DOC_STATUS_COLOR: Record<string, 'blue' | 'violet' | 'green' | 'gray' | 'teal'> = {
  RECEIVED: 'blue', EXTRACTED: 'violet', REVIEWED: 'teal', SIGNED: 'green', SUPERSEDED: 'gray',
};

function DataRoomCard({ documents, onAdd, adding, onSupersede, onSign, busy }: {
  documents: SubmissionDoc[]; onAdd: (name: string, kind: string) => void; adding: boolean;
  onSupersede: (docId: string) => void; onSign: (docId: string) => void; busy: boolean;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const submit = () => { if (name.trim()) { onAdd(name.trim(), kind || 'OTHER'); setName(''); setKind(''); } };

  return (
    <Card padded>
      <CardHeader title={<span className={styles.drawerTitle}><FolderOpen size={15} /> Data room</span>} subtitle="Versioned documents · OCR/AI extraction · e-signature" />
      <div className={styles.docAddRow}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Document name, e.g. Acme_SOV_2026.xlsx" />
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Auto-detect</option>
          {DOC_KINDS.map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
        </Select>
        <Button size="sm" variant="secondary" icon={<FilePlus2 size={14} />} disabled={!name.trim()} loading={adding} onClick={submit}>Add</Button>
      </div>
      {documents.length === 0 ? (
        <p className={styles.cellSub}>No documents yet. Register the slip, SOV, loss run and wordings — each is extracted and versioned.</p>
      ) : (
        <ul className={styles.docList}>
          {documents.map((d) => (
            <li key={d.id} className={`${styles.docItem} ${d.status === 'SUPERSEDED' ? styles.docSuperseded : ''}`}>
              <div className={styles.docMain}>
                <div className={styles.docTop}>
                  <Badge color="indigo">{DOC_KIND_LABEL[d.kind] ?? d.kind}</Badge>
                  <span className={styles.docName}>{d.name}</span>
                  <span className={styles.docVersion}>v{d.version}</span>
                  <Badge color={DOC_STATUS_COLOR[d.status] ?? 'gray'}>{titleCase(d.status)}</Badge>
                </div>
                <div className={styles.docMeta}>
                  {d.extraction && (
                    <span className={styles.docExtract}><ScanText size={12} /> {Math.round(d.extraction.confidence * 100)}% · {d.extraction.fields.length} field(s){d.extraction.unresolved.length ? `, ${d.extraction.unresolved.length} to verify` : ''}</span>
                  )}
                  {d.signature && <span className={styles.docSig}><PenTool size={12} /> {d.signature}</span>}
                  {d.uploadedBy && <span className={styles.cellSub}>{d.uploadedBy}</span>}
                </div>
              </div>
              {d.status !== 'SUPERSEDED' && (
                <div className={styles.docActions}>
                  <Button size="sm" variant="ghost" icon={<History size={13} />} loading={busy} onClick={() => onSupersede(d.id)} title="New version">v+</Button>
                  {d.status !== 'SIGNED' && <Button size="sm" variant="ghost" icon={<PenTool size={13} />} loading={busy} onClick={() => onSign(d.id)} title="Sign">Sign</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* Renders the model-specific slip terms stored on a submission, resolving their
 * labels/types from the catalog and flagging any required terms still missing. */
function ModelTermsCard({ submission, catalog }: { submission: SubmissionDetail; catalog?: ModelCatalog }) {
  const structure = catalog?.structures.find((x) => x.key === submission.structure);
  const line = catalog?.lines.find((x) => x.key === submission.lineOfBusiness);
  const fields: ModelField[] = [...(structure?.fields ?? []), ...(line?.fields ?? [])];
  if (!fields.length) return null;
  const terms = submission.terms ?? {};
  const present = fields.filter((fld) => terms[fld.key] !== undefined && terms[fld.key] !== null && terms[fld.key] !== '');
  const missing = submission.termsCheck?.missing ?? [];
  const labelFor = (key: string) => fields.find((fld) => fld.key === key)?.label ?? key;

  return (
    <Card padded>
      <CardHeader
        title="Model terms"
        subtitle={[structure?.label, line?.label].filter(Boolean).join(' · ') || 'Slip terms'}
      />
      {present.length ? (
        <div className={styles.termsGrid}>
          {present.map((fld) => (
            <div key={fld.key} className={styles.termItem}>
              <span className={styles.termLabel}>{fld.label}</span>
              <span className={styles.termValue}>{fmtTerm(fld, terms[fld.key], submission.currency)}</span>
            </div>
          ))}
        </div>
      ) : <p className={styles.cellSub}>No model terms captured yet.</p>}
      {missing.length > 0 && (
        <div className={styles.termsMissing}>
          <StickyNote size={14} /> {missing.length} required term(s) to complete: {missing.map(labelFor).join(', ')}
        </div>
      )}
    </Card>
  );
}

// Format a stored term value for display, honouring its declared type.
function fmtTerm(field: ModelField, value: unknown, currency: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'money') return money(Number(value), currency);
  if (field.type === 'percent') return `${value}%`;
  if (field.type === 'number') return `${value}${field.unit ? ' ' + field.unit : ''}`;
  return String(value);
}

/* The approval / referral engine: shows the authority the matrix requires, lets
 * an underwriter raise a referral, and lets an approver sign it off or reject it. */
const APPROVAL_LEVEL_LABEL: Record<string, string> = {
  UNDERWRITER: 'Underwriter', SENIOR_UW: 'Senior Underwriter', CHIEF_UW: 'Chief Underwriter', COMMITTEE: 'Committee',
};
const APPROVAL_STATUS_COLOR: Record<string, 'amber' | 'green' | 'red'> = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red' };

function ApprovalCard({ submission, canApprove, onRaise, raising, onDecide, deciding }: {
  submission: SubmissionDetail; canApprove: boolean;
  onRaise: () => void; raising: boolean;
  onDecide: (approvalId: string, decision: 'APPROVED' | 'REJECTED') => void; deciding: boolean;
}) {
  const req = submission.approvalRequirement;
  const approvals = submission.approvals ?? [];
  const pending = approvals.find((a) => a.status === 'PENDING');
  const hasApproved = approvals.some((a) => a.status === 'APPROVED');
  const referralNeeded = req?.referralRequired ?? false;
  const terminal = submission.stage === 'BOUND' || submission.stage === 'DECLINED' || submission.stage === 'LAPSED';

  return (
    <Card padded>
      <CardHeader
        title="Approval & referral"
        subtitle={referralNeeded ? `Authority required: ${APPROVAL_LEVEL_LABEL[req!.level] ?? req!.level}` : 'Within delegated authority'}
        actions={referralNeeded && !pending && !hasApproved && !terminal
          ? <Button size="sm" variant="secondary" icon={<ArrowUpCircle size={14} />} loading={raising} onClick={onRaise}>Raise referral</Button>
          : undefined}
      />
      {referralNeeded ? (
        <>
          <div className={styles.approvalReq}>
            <ShieldCheck size={15} />
            <span>{req!.reason} · SLA {req!.slaHours}h</span>
            <span className={styles.approvalChain}>
              {req!.chain.map((l) => <span key={l} className={styles.approvalStep}>{APPROVAL_LEVEL_LABEL[l] ?? l}</span>)}
            </span>
          </div>
          {approvals.length === 0 ? (
            <p className={styles.cellSub}>No referral raised yet. This submission exceeds delegated authority and must be referred before binding.</p>
          ) : (
            <ul className={styles.approvalList}>
              {approvals.map((a) => (
                <li key={a.id} className={styles.approvalItem}>
                  <div className={styles.approvalItemMain}>
                    <Badge color={APPROVAL_STATUS_COLOR[a.status] ?? 'gray'}>{titleCase(a.status)}</Badge>
                    <span className={styles.approvalLevel}>{APPROVAL_LEVEL_LABEL[a.level] ?? a.level}</span>
                    {a.reason && <span className={styles.cellSub}>· {a.reason}</span>}
                    {a.status === 'PENDING' && a.slaDueAt && (
                      <span className={`${styles.approvalSla} ${a.slaBreached ? styles.approvalSlaBreached : ''}`}>
                        <Clock size={12} /> {a.slaBreached ? 'SLA breached' : `due ${new Date(a.slaDueAt).toLocaleDateString([], { day: '2-digit', month: 'short' })}`}
                      </span>
                    )}
                    {a.note && <span className={styles.cellSub}>“{a.note}”</span>}
                  </div>
                  {a.status === 'PENDING' && canApprove && (
                    <div className={styles.approvalActions}>
                      <Button size="sm" variant="primary" icon={<ThumbsUp size={13} />} loading={deciding} onClick={() => onDecide(a.id, 'APPROVED')}>Approve</Button>
                      <Button size="sm" variant="danger" icon={<ThumbsDown size={13} />} loading={deciding} onClick={() => onDecide(a.id, 'REJECTED')}>Reject</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className={styles.cellSub}>Binding this submission is within a normal underwriter's authority — no senior sign-off required.</p>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{value}</span>
    </div>
  );
}

/* ---------------- Pricing scenario helpers ---------------- */
// combinedRatioPct band: <100 green, 100–110 amber, >110 red
const crBand = (cr: number): 'green' | 'amber' | 'red' => (cr < 100 ? 'green' : cr <= 110 ? 'amber' : 'red');
// rateChange is a fraction (0.15 → "+15%")
const fmtRate = (rc: number) => `${rc > 0 ? '+' : ''}${Math.round(rc * 100)}%`;
// lossShock is a multiplier (1.25 → "×1.25")
const fmtShock = (ls: number) => `×${(Math.round(ls * 100) / 100).toString()}`;

function StatChip({ label, value, headline, band }: { label: string; value: string; headline?: boolean; band?: 'green' | 'amber' | 'red' }) {
  return (
    <div className={`${styles.statChip} ${headline ? styles.statChipHeadline : ''}`} data-band={band}>
      <span className={styles.statChipLabel}>{label}</span>
      <span className={styles.statChipValue}>{value}</span>
    </div>
  );
}

function SensRow({ label, points, fmt }: { label: string; points: SensitivityPoint[]; fmt: (v: number) => string }) {
  return (
    <div className={styles.sensRow}>
      <span className={styles.sensLabel}>{label}</span>
      <div className={styles.sensPoints}>
        {points.map((p, i) => (
          <span key={i} className={styles.sensPoint} data-band={crBand(p.combinedRatioPct)}>
            <span className={styles.sensPointDriver}>{fmt(p.value)}</span>
            <span className={styles.sensPointCr}>{p.combinedRatioPct}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
