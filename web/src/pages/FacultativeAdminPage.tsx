import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileCheck2, Layers, Gauge, Coins, Building2, PlusCircle, Star, ClipboardCheck, TrendingUp,
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
import { BarChart } from '../components/BarChart';
import { Tabs } from '../components/Tabs';
import { FormField, FormSection, Input, Select, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import type { TokenColor } from '../lib/status';
import { formatMoney, formatMoneyCompact, formatNumber, formatPercent, titleCase, formatDate, formatDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import styles from './FacultativeAdminPage.module.css';

/* ---------------- Types (mirror /api/facultative-admin) ---------------- */
type PlacementStatus = 'UNPLACED' | 'PARTIAL' | 'COMPLETE' | 'OVERSUBSCRIBED';
interface RiskRow {
  id: string; reference: string | null; insuredName: string | null; lineOfBusiness: string | null;
  country: string | null; perilZone: string | null; sumInsuredMinor: number; currency: string;
  inception: string | null; expiry: string | null; signedPct: number; quotes: number; placementStatus: PlacementStatus;
}
interface Quote { id: string; reinsurerName: string | null; sharePct: number; premiumMinor: number; ratePct: number | null; status: string; validUntil: string | null; note?: string | null }
interface PlacementLine { id: string; reinsurerName: string | null; kind: string; writtenPct: number; signedPct: number; premiumMinor: number; status: string }
interface Placement { lineCount: number; writtenPct: number; signedPct: number; premiumMinor: number; shortfallPct: number; oversubscribedPct: number; status: PlacementStatus }
interface Engineering { id: string; kind: string; inspector: string | null; riskGrade: string | null; findings: string | null; inspectedOn: string | null }
interface TimelineItem { at: string; action: string; actor: string | null; entityType: string }
interface RiskDetail extends Omit<RiskRow, 'signedPct' | 'quotes' | 'placementStatus'> {
  description: string | null;
  quotes: Quote[]; bestQuoteId: string | null; averageRatePct: number;
  placementLines: PlacementLine[]; placement: Placement; engineering: Engineering[]; timeline: TimelineItem[];
}
interface Dashboard {
  risks: RiskRow[]; byLob: { key: string; n: number }[]; byStatus: { key: string; n: number }[];
  totals: { risks: number; placed: number; unplaced: number; totalTsiMinor: number; quotes: number; placementRatePct: number };
}

const PLACEMENT_COLOR: Record<string, TokenColor> = { UNPLACED: 'slate', PARTIAL: 'amber', COMPLETE: 'green', OVERSUBSCRIBED: 'violet' };
const QUOTE_COLOR: Record<string, TokenColor> = { PENDING: 'slate', QUOTED: 'blue', ACCEPTED: 'green', DECLINED: 'red', EXPIRED: 'gray' };
const KIND_COLOR: Record<string, TokenColor> = { LEAD: 'indigo', FOLLOW: 'blue', COINSURANCE: 'teal', RETRO: 'violet' };
const GRADE_COLOR: Record<string, TokenColor> = { LOW: 'slate', MODERATE: 'blue', ELEVATED: 'amber', HIGH: 'orange', SEVERE: 'red' };

type Tab = 'quotes' | 'placement' | 'engineering' | 'timeline';

export function FacultativeAdminPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('facultative:write');
  const { success, error } = useToast();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('quotes');
  const [modal, setModal] = useState<'quote' | 'line' | 'eng' | null>(null);

  const dash = useQuery({ queryKey: ['fac-admin'], queryFn: () => api<Dashboard>('/api/facultative-admin') });
  const detail = useQuery({
    queryKey: ['fac-admin', openId], enabled: !!openId,
    queryFn: () => api<RiskDetail>(`/api/facultative-admin/${openId}`),
  });

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['fac-admin'] }); };
  const mut = useMutation({
    mutationFn: (v: { path: string; body: unknown }) => api(v.path, { method: 'POST', body: v.body }),
    onSuccess: () => { invalidate(); setModal(null); success('Saved'); },
    onError: (e) => error(e instanceof ApiError ? e.message : 'Failed'),
  });

  if (dash.isLoading || !dash.data) {
    return (
      <div className={styles.page}>
        <PageHeader title="Facultative Administration" description="Risk submission, market placement, quote comparison and engineering." />
        <PageLoader />
      </div>
    );
  }
  const d = dash.data;

  const cols: Column<RiskRow>[] = [
    { key: 'reference', header: 'Reference', render: (r) => <span className={styles.ref}>{r.reference ?? '—'}</span> },
    { key: 'insured', header: 'Insured', render: (r) => <span className={styles.main}>{r.insuredName ?? '—'}</span> },
    { key: 'lob', header: 'LOB', render: (r) => r.lineOfBusiness ? titleCase(r.lineOfBusiness) : '—' },
    { key: 'country', header: 'Country', render: (r) => r.country ?? '—' },
    { key: 'tsi', header: 'Sum insured', align: 'right', render: (r) => formatMoney(r.sumInsuredMinor, r.currency) },
    { key: 'quotes', header: 'Quotes', align: 'right', render: (r) => formatNumber(r.quotes) },
    { key: 'signed', header: 'Placed', align: 'right', render: (r) => formatPercent(r.signedPct) },
    { key: 'status', header: 'Status', render: (r) => <Badge color={PLACEMENT_COLOR[r.placementStatus]}>{titleCase(r.placementStatus)}</Badge> },
  ];

  return (
    <div className={styles.page}>
      <PageHeader
        title="Facultative Administration"
        description="The facultative workspace — risk register, market placement, quote comparison, coinsurance & retro lines, engineering reports and a placement timeline."
        crumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'Facultative Admin' }]}
      />

      <div className={styles.kpiGrid}>
        <KpiCard label="Facultative risks" value={formatNumber(d.totals.risks)} icon={<FileCheck2 size={18} />} accent="var(--primary)" />
        <KpiCard label="Placed" value={formatNumber(d.totals.placed)} hint={`${formatNumber(d.totals.unplaced)} unplaced`} icon={<Layers size={18} />} accent="var(--accent-emerald)" />
        <KpiCard label="Placement rate" value={formatPercent(d.totals.placementRatePct)} icon={<Gauge size={18} />} accent="var(--accent-violet)" />
        <KpiCard label="Total sum insured" value={formatMoneyCompact(d.totals.totalTsiMinor, 'USD')} icon={<Coins size={18} />} accent="var(--accent-indigo)" />
        <KpiCard label="Market quotes" value={formatNumber(d.totals.quotes)} icon={<TrendingUp size={18} />} accent="var(--accent-orange)" />
      </div>

      <div className={styles.chartGrid}>
        <Card>
          <CardHeader title="Risks by line of business" />
          <BarChart data={d.byLob.map((b) => ({ label: titleCase(b.key), value: b.n }))} />
        </Card>
        <Card>
          <CardHeader title="Placement status" />
          <BarChart data={d.byStatus.map((b) => ({ label: titleCase(b.key), value: b.n, status: b.key }))}
            metaColors={PLACEMENT_COLOR} />
        </Card>
      </div>

      <Card padded={false}>
        <div className={styles.tableHead}><CardHeader title="Facultative register" subtitle="Select a risk for placement, quotes and engineering" /></div>
        <div className={styles.tableBody}>
          <Table rows={d.risks} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => { setOpenId(r.id); setTab('quotes'); }}
            empty={<EmptyState icon={<FileCheck2 size={18} />} title="No facultative risks" message="Facultative risks will appear here." />} />
        </div>
      </Card>

      <Drawer open={!!openId} onClose={() => setOpenId(null)} width={560}
        title={detail.data?.reference ?? 'Facultative risk'} subtitle={detail.data?.insuredName ?? undefined}>
        {detail.isLoading || !detail.data ? <PageLoader /> : (
          <RiskDetailView
            d={detail.data} tab={tab} setTab={setTab} canWrite={canWrite}
            onAdd={(kind) => setModal(kind)}
          />
        )}
      </Drawer>

      {/* --- Modals --- */}
      {openId && (
        <>
          <QuoteModal open={modal === 'quote'} onClose={() => setModal(null)} busy={mut.isPending}
            onSubmit={(body) => mut.mutate({ path: `/api/facultative-admin/${openId}/quotes`, body })} />
          <LineModal open={modal === 'line'} onClose={() => setModal(null)} busy={mut.isPending}
            onSubmit={(body) => mut.mutate({ path: `/api/facultative-admin/${openId}/placement`, body })} />
          <EngModal open={modal === 'eng'} onClose={() => setModal(null)} busy={mut.isPending}
            onSubmit={(body) => mut.mutate({ path: `/api/facultative-admin/${openId}/engineering`, body })} />
        </>
      )}
    </div>
  );
}

function RiskDetailView({ d, tab, setTab, canWrite, onAdd }: {
  d: RiskDetail; tab: Tab; setTab: (t: Tab) => void; canWrite: boolean; onAdd: (k: 'quote' | 'line' | 'eng') => void;
}) {
  return (
    <div className={styles.detail}>
      <div className={styles.factGrid}>
        <Fact label="Sum insured" value={formatMoney(d.sumInsuredMinor, d.currency)} />
        <Fact label="LOB" value={d.lineOfBusiness ? titleCase(d.lineOfBusiness) : '—'} />
        <Fact label="Country" value={d.country ?? '—'} />
        <Fact label="Peril zone" value={d.perilZone ?? '—'} />
        <Fact label="Period" value={`${formatDate(d.inception)} – ${formatDate(d.expiry)}`} />
        <Fact label="Placement" value={<Badge color={PLACEMENT_COLOR[d.placement.status]}>{formatPercent(d.placement.signedPct)} · {titleCase(d.placement.status)}</Badge>} />
      </div>

      <Tabs
        tabs={[
          { id: 'quotes', label: `Quotes (${d.quotes.length})` },
          { id: 'placement', label: `Placement (${d.placementLines.length})` },
          { id: 'engineering', label: `Engineering (${d.engineering.length})` },
          { id: 'timeline', label: 'Timeline' },
        ]}
        active={tab} onChange={(id) => setTab(id as Tab)}
      />

      <div className={styles.tabPane}>
        {tab === 'quotes' && (
          <>
            {canWrite && <Button size="sm" variant="secondary" onClick={() => onAdd('quote')}><PlusCircle size={15} /> Add quote</Button>}
            <div className={styles.metric}>Average quoted rate: <strong>{formatPercent(d.averageRatePct)}</strong></div>
            <table className={styles.mini}>
              <thead><tr><th>Reinsurer</th><th>Share</th><th>Rate</th><th>Premium</th><th>Status</th></tr></thead>
              <tbody>
                {d.quotes.map((q) => (
                  <tr key={q.id} className={q.id === d.bestQuoteId ? styles.best : ''}>
                    <td>{q.id === d.bestQuoteId && <Star size={13} className={styles.star} aria-label="Best quote" />}{q.reinsurerName ?? '—'}</td>
                    <td>{formatPercent(q.sharePct)}</td>
                    <td>{q.ratePct != null ? formatPercent(q.ratePct) : '—'}</td>
                    <td>{formatMoney(q.premiumMinor, d.currency)}</td>
                    <td><Badge color={QUOTE_COLOR[q.status] ?? 'slate'}>{titleCase(q.status)}</Badge></td>
                  </tr>
                ))}
                {!d.quotes.length && <tr><td colSpan={5} className={styles.empty}>No quotes yet.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {tab === 'placement' && (
          <>
            {canWrite && <Button size="sm" variant="secondary" onClick={() => onAdd('line')}><PlusCircle size={15} /> Add line</Button>}
            <div className={styles.summaryRow}>
              <span>Written <strong>{formatPercent(d.placement.writtenPct)}</strong></span>
              <span>Signed <strong>{formatPercent(d.placement.signedPct)}</strong></span>
              <span>{d.placement.shortfallPct > 0 ? <>Shortfall <strong>{formatPercent(d.placement.shortfallPct)}</strong></> : <>Over <strong>{formatPercent(d.placement.oversubscribedPct)}</strong></>}</span>
            </div>
            <table className={styles.mini}>
              <thead><tr><th>Reinsurer</th><th>Role</th><th>Written</th><th>Signed</th><th>Premium</th></tr></thead>
              <tbody>
                {d.placementLines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.reinsurerName ?? '—'}</td>
                    <td><Badge color={KIND_COLOR[l.kind] ?? 'slate'}>{titleCase(l.kind)}</Badge></td>
                    <td>{formatPercent(l.writtenPct)}</td>
                    <td>{formatPercent(l.signedPct)}</td>
                    <td>{formatMoney(l.premiumMinor, d.currency)}</td>
                  </tr>
                ))}
                {!d.placementLines.length && <tr><td colSpan={5} className={styles.empty}>No placement lines yet.</td></tr>}
              </tbody>
            </table>
          </>
        )}

        {tab === 'engineering' && (
          <>
            {canWrite && <Button size="sm" variant="secondary" onClick={() => onAdd('eng')}><PlusCircle size={15} /> Add report</Button>}
            {d.engineering.map((e) => (
              <div key={e.id} className={styles.engCard}>
                <div className={styles.engHead}>
                  <Badge color="indigo">{titleCase(e.kind)}</Badge>
                  {e.riskGrade && <Badge color={GRADE_COLOR[e.riskGrade] ?? 'slate'}>{titleCase(e.riskGrade)}</Badge>}
                  <span className={styles.sub}>{e.inspector ?? '—'} · {formatDate(e.inspectedOn)}</span>
                </div>
                <p className={styles.findings}>{e.findings ?? '—'}</p>
              </div>
            ))}
            {!d.engineering.length && <p className={styles.empty}>No engineering or inspection reports yet.</p>}
          </>
        )}

        {tab === 'timeline' && (
          <ul className={styles.timeline}>
            {d.timeline.map((t, i) => (
              <li key={i}><span className={styles.tAction}>{titleCase(t.action)}</span><span className={styles.sub}>{t.actor ?? '—'} · {formatDateTime(t.at)}</span></li>
            ))}
            {!d.timeline.length && <p className={styles.empty}>No activity recorded yet.</p>}
          </ul>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className={styles.fact}><span className={styles.factLabel}>{label}</span><span className={styles.factValue}>{value}</span></div>;
}

function QuoteModal({ open, onClose, onSubmit, busy }: { open: boolean; onClose: () => void; onSubmit: (b: unknown) => void; busy: boolean }) {
  const [f, setF] = useState({ reinsurerName: '', sharePct: '', premium: '', ratePct: '', status: 'QUOTED' });
  return (
    <Modal open={open} onClose={onClose} title="Add market quote">
      <FormSection>
        <FormField label="Reinsurer"><Input value={f.reinsurerName} onChange={(e) => setF({ ...f, reinsurerName: e.target.value })} placeholder="e.g. Helvetia Re" /></FormField>
        <FormField label="Share %"><Input type="number" value={f.sharePct} onChange={(e) => setF({ ...f, sharePct: e.target.value })} /></FormField>
        <FormField label="Premium"><Input type="number" value={f.premium} onChange={(e) => setF({ ...f, premium: e.target.value })} /></FormField>
        <FormField label="Rate on line %"><Input type="number" value={f.ratePct} onChange={(e) => setF({ ...f, ratePct: e.target.value })} /></FormField>
        <FormField label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          {['PENDING', 'QUOTED', 'ACCEPTED', 'DECLINED', 'EXPIRED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select></FormField>
      </FormSection>
      <div className={styles.modalActions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !f.sharePct} onClick={() => onSubmit({ reinsurerName: f.reinsurerName || undefined, sharePct: Number(f.sharePct), premium: Number(f.premium || 0), ratePct: f.ratePct ? Number(f.ratePct) : undefined, status: f.status })}>Add quote</Button>
      </div>
    </Modal>
  );
}

function LineModal({ open, onClose, onSubmit, busy }: { open: boolean; onClose: () => void; onSubmit: (b: unknown) => void; busy: boolean }) {
  const [f, setF] = useState({ reinsurerName: '', kind: 'FOLLOW', writtenPct: '', signedPct: '', premium: '' });
  return (
    <Modal open={open} onClose={onClose} title="Add placement line">
      <FormSection>
        <FormField label="Reinsurer"><Input value={f.reinsurerName} onChange={(e) => setF({ ...f, reinsurerName: e.target.value })} /></FormField>
        <FormField label="Role"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {['LEAD', 'FOLLOW', 'COINSURANCE', 'RETRO'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select></FormField>
        <FormField label="Written %"><Input type="number" value={f.writtenPct} onChange={(e) => setF({ ...f, writtenPct: e.target.value })} /></FormField>
        <FormField label="Signed %"><Input type="number" value={f.signedPct} onChange={(e) => setF({ ...f, signedPct: e.target.value })} /></FormField>
        <FormField label="Premium"><Input type="number" value={f.premium} onChange={(e) => setF({ ...f, premium: e.target.value })} /></FormField>
      </FormSection>
      <div className={styles.modalActions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !f.signedPct} onClick={() => onSubmit({ reinsurerName: f.reinsurerName || undefined, kind: f.kind, writtenPct: Number(f.writtenPct || 0), signedPct: Number(f.signedPct), premium: Number(f.premium || 0) })}>Add line</Button>
      </div>
    </Modal>
  );
}

function EngModal({ open, onClose, onSubmit, busy }: { open: boolean; onClose: () => void; onSubmit: (b: unknown) => void; busy: boolean }) {
  const [f, setF] = useState({ kind: 'ENGINEERING', inspector: '', riskGrade: '', findings: '' });
  return (
    <Modal open={open} onClose={onClose} title="Add engineering report">
      <FormSection>
        <FormField label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {['ENGINEERING', 'INSPECTION', 'SURVEY', 'VALUATION'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select></FormField>
        <FormField label="Inspector"><Input value={f.inspector} onChange={(e) => setF({ ...f, inspector: e.target.value })} /></FormField>
        <FormField label="Risk grade"><Select value={f.riskGrade} onChange={(e) => setF({ ...f, riskGrade: e.target.value })}>
          <option value="">—</option>
          {['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'SEVERE'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select></FormField>
        <FormField label="Findings"><Textarea rows={4} value={f.findings} onChange={(e) => setF({ ...f, findings: e.target.value })} /></FormField>
      </FormSection>
      <div className={styles.modalActions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={() => onSubmit({ kind: f.kind, inspector: f.inspector || undefined, riskGrade: f.riskGrade || undefined, findings: f.findings || undefined })}>Add report</Button>
      </div>
    </Modal>
  );
}
