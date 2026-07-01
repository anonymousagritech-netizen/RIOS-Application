import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Gavel, Inbox, TrendingUp, Gauge, CheckCircle2, Target, Percent,
  FileText, Calculator, Send, Play, XCircle, StickyNote,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useParties, useCodeLists, useCurrencies } from '../lib/queries';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Drawer } from '../components/Drawer';
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
const STRUCTURES = [
  { code: '', label: '—' },
  { code: 'QUOTA_SHARE', label: 'Quota share' },
  { code: 'SURPLUS', label: 'Surplus' },
  { code: 'PER_RISK_XL', label: 'Per-risk XL' },
  { code: 'CAT_XL', label: 'Cat XL' },
  { code: 'AGG_XL', label: 'Aggregate XL' },
  { code: 'STOP_LOSS', label: 'Stop loss' },
];

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
}

const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);
const compact = (minor: number, ccy = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);

/* ---------------- Data hooks ---------------- */
function useKpis() { return useQuery({ queryKey: ['uw', 'kpis'], queryFn: () => api<Kpis>('/api/underwriting/kpis') }); }
function useSubmissions(stage: string) {
  return useQuery({ queryKey: ['uw', 'submissions', stage], queryFn: () => api<{ submissions: SubmissionRow[] }>(`/api/underwriting/submissions${stage ? `?stage=${stage}` : ''}`) });
}
function useSubmission(id: string | null) {
  return useQuery({ queryKey: ['uw', 'submission', id], queryFn: () => api<SubmissionDetail>(`/api/underwriting/submissions/${id}`), enabled: !!id });
}

export function UnderwritingPage() {
  const [stage, setStage] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
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
        actions={<Button variant="primary" icon={<Gavel size={16} />} onClick={() => setShowNew(true)}>New submission</Button>}
      />

      <div className={styles.kpis}>
        <KpiCard label="Open submissions" value={String(k?.open ?? 0)} hint="In the pipeline" icon={<Inbox size={20} />} accent="var(--primary)" loading={kpis.isLoading} />
        <KpiCard label="Pipeline EPI" value={k ? compact(k.pipelineEpiMinor) : '—'} hint="Estimated premium in flight" icon={<TrendingUp size={20} />} accent="var(--accent-cyan)" loading={kpis.isLoading} />
        <KpiCard label="Avg risk score" value={String(k?.avgRiskScore ?? 0)} hint="0 = benign · 100 = severe" icon={<Gauge size={20} />} accent="var(--accent-violet)" loading={kpis.isLoading} />
        <KpiCard label="Bound" value={String(k?.bound ?? 0)} hint="Won this book" icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" loading={kpis.isLoading} />
        <KpiCard label="Hit ratio" value={`${k?.hitRatioPct ?? 0}%`} hint="Bound of decided" icon={<Percent size={20} />} accent="var(--accent-orange)" loading={kpis.isLoading} />
      </div>

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
      <SubmissionDrawer id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

/* ---------------- New submission slip ---------------- */
function NewSubmissionModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: partyData } = useParties({});
  const { data: codeLists } = useCodeLists();
  const { data: ccy } = useCurrencies();
  const parties = partyData?.parties ?? [];
  const lobOptions = codeLists?.lists?.line_of_business ?? [];
  const currencies = ccy?.currencies ?? [];

  const [f, setF] = useState({
    title: '', kind: 'TREATY', basis: 'NON_PROPORTIONAL', structure: 'CAT_XL', lineOfBusiness: '',
    cedentPartyId: '', brokerPartyId: '', currency: 'USD', inception: '', expiry: '', territory: '',
    sumInsured: '', attachment: '', limit: '', estPremium: '',
    lossRatioPct: '', catExposed: false, classHazard: '3', priorClaims: '', yearsWithCedent: '', capacityUtilPct: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const numv = (v: string) => (v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string; reference: string; riskBand: string }>('/api/underwriting/submissions', { body }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['uw'] });
      toast.success(`Submission ${res.reference} created · risk ${titleCase(res.riskBand)}`);
      onCreated(res.id);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the submission.'),
  });

  const submit = () => {
    setError(null);
    create.mutate({
      title: f.title, kind: f.kind, basis: f.basis, structure: f.structure || undefined,
      lineOfBusiness: f.lineOfBusiness || undefined, cedentPartyId: f.cedentPartyId || undefined, brokerPartyId: f.brokerPartyId || undefined,
      currency: f.currency, inception: f.inception || undefined, expiry: f.expiry || undefined, territory: f.territory || undefined,
      sumInsured: numv(f.sumInsured), attachment: numv(f.attachment), limit: numv(f.limit), estPremium: numv(f.estPremium),
      lossRatioPct: numv(f.lossRatioPct), catExposed: f.catExposed, classHazard: numv(f.classHazard),
      priorClaims: numv(f.priorClaims), yearsWithCedent: numv(f.yearsWithCedent), capacityUtilPct: numv(f.capacityUtilPct),
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
          <FormField label="Basis"><Select value={f.basis} onChange={(e) => set('basis')(e.target.value)}><option value="PROPORTIONAL">Proportional</option><option value="NON_PROPORTIONAL">Non-proportional</option></Select></FormField>
          <FormField label="Structure"><Select value={f.structure} onChange={(e) => set('structure')(e.target.value)}>{STRUCTURES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</Select></FormField>
          <FormField label="Line of business"><Select value={f.lineOfBusiness} onChange={(e) => set('lineOfBusiness')(e.target.value)}><option value="">Unspecified</option>{lobOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</Select></FormField>
          <FormField label="Currency"><Select value={f.currency} onChange={(e) => set('currency')(e.target.value)}>{(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => <option key={c} value={c}>{c}</option>)}</Select></FormField>
        </FormSection>

        <FormSection title="Parties & period">
          <FormField label="Cedent / reinsured"><Select value={f.cedentPartyId} onChange={(e) => set('cedentPartyId')(e.target.value)}><option value="">Select…</option>{parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}</Select></FormField>
          <FormField label="Broker"><Select value={f.brokerPartyId} onChange={(e) => set('brokerPartyId')(e.target.value)}><option value="">Direct / none</option>{parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}</Select></FormField>
          <TextField label="Inception" type="date" value={f.inception} onChange={set('inception')} />
          <TextField label="Expiry" type="date" value={f.expiry} onChange={set('expiry')} />
          <div style={{ gridColumn: '1 / -1' }}><TextField label="Territory" value={f.territory} onChange={set('territory')} placeholder="e.g. Worldwide excl. USA & Canada" /></div>
        </FormSection>

        <FormSection title="Structure terms & premium">
          <TextField label="Sum insured / limit (major)" type="number" value={f.sumInsured} onChange={set('sumInsured')} placeholder="e.g. 50000000" />
          <TextField label="Attachment (major)" type="number" value={f.attachment} onChange={set('attachment')} placeholder="e.g. 1000000" />
          <TextField label="Layer limit (major)" type="number" value={f.limit} onChange={set('limit')} placeholder="e.g. 4000000" />
          <TextField label="Estimated premium income (major)" type="number" value={f.estPremium} onChange={set('estPremium')} placeholder="e.g. 5000000" />
        </FormSection>

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

/* ---------------- Submission detail drawer ---------------- */
function SubmissionDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: s, isLoading } = useSubmission(id);
  const [note, setNote] = useState('');

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['uw'] }); };
  const act = <T,>(path: string, body: unknown, ok: string) =>
    api<T>(`/api/underwriting/submissions/${id}/${path}`, { body }).then((r) => { invalidate(); toast.success(ok); return r; })
      .catch((e) => { toast.error(e instanceof ApiError ? e.message : 'Action failed'); throw e; });

  const transition = useMutation({ mutationFn: (to: string) => act(`transition`, { to }, `Moved to ${titleCase(to)}`) });
  const price = useMutation({ mutationFn: () => act(`price`, {}, 'Technical premium computed') });
  const rescore = useMutation({ mutationFn: () => act(`score`, {}, 'Risk re-scored') });
  const addNote = useMutation({ mutationFn: (n: string) => act(`note`, { note: n }, 'Note added').then(() => setNote('')) });

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

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{value}</span>
    </div>
  );
}
