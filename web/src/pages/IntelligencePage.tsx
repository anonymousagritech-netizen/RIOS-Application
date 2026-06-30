/**
 * Intelligence (brief §5, §9.4, §13): AI insights (renewal likelihood),
 * narrative generation, document OCR extraction, and the voice assistant. The
 * scoring/extraction/routing are real; speech I/O and image OCR are external.
 */

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Select, Textarea, Input } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatPercent } from '../lib/format';
import shared from './shared.module.css';
import styles from './IntelligencePage.module.css';

export function IntelligencePage() {
  const [tab, setTab] = useState('insights');
  return (
    <>
      <PageHeader title="Intelligence" description="Predictive insights, narrative generation, document extraction and the voice assistant." />
      <Card>
        <Tabs tabs={[{ id: 'insights', label: 'Insights' }, { id: 'generate', label: 'Generate' }, { id: 'ocr', label: 'Document OCR' }, { id: 'voice', label: 'Voice' }]} active={tab} onChange={setTab} />
        <div className={styles.tabBody}>
          {tab === 'insights' && <Insights />}
          {tab === 'generate' && <Generate />}
          {tab === 'ocr' && <Ocr />}
          {tab === 'voice' && <Voice />}
        </div>
      </Card>
    </>
  );
}

interface Insight { id: string; reference: string; name: string; premiumMinor: number; incurredMinor: number; lossRatio: number; openClaims: number; renewalLikelihood: number; band: string }
const BAND: Record<string, 'red' | 'amber' | 'green'> = { unlikely: 'red', 'at-risk': 'amber', likely: 'green' };

function Insights() {
  const q = useQuery({ queryKey: ['insights-renewals'], queryFn: () => api<{ insights: Insight[] }>('/api/insights/renewals') });
  if (q.isLoading) return <PageLoader label="Scoring renewals…" />;
  const cols: Column<Insight>[] = [
    { key: 'ref', header: 'Contract', render: (i) => <span className={shared.cellMain}>{i.name}</span> },
    { key: 'premium', header: 'Premium', align: 'right', render: (i) => formatMoney(i.premiumMinor) },
    { key: 'lr', header: 'Loss ratio', align: 'right', render: (i) => formatPercent(i.lossRatio) },
    { key: 'open', header: 'Open claims', align: 'right', render: (i) => String(i.openClaims) },
    { key: 'score', header: 'Renewal likelihood', align: 'right', render: (i) => <Badge color={BAND[i.band] ?? 'slate'}>{formatPercent(i.renewalLikelihood)} · {i.band}</Badge> },
  ];
  return <Table columns={cols} rows={q.data?.insights} rowKey={(i) => i.id} empty={<EmptyState title="No contracts" message="No contracts to score." />} />;
}

function Generate() {
  const toast = useToast();
  const [text, setText] = useState('');
  const gen = useMutation({
    mutationFn: () => api<{ narrative: string }>('/api/generate/summary', { body: {} }),
    onSuccess: (r) => setText(r.narrative),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Generation failed'),
  });
  return (
    <div className={styles.console}>
      <p className={shared.cellSub}>Generate a plain-language executive summary from the live portfolio KPIs.</p>
      <Button variant="primary" onClick={() => gen.mutate()} loading={gen.isPending} className={styles.startButton}>Generate summary</Button>
      {text && <Card><div className={styles.narrative}>{text}</div></Card>}
    </div>
  );
}

function Ocr() {
  const toast = useToast();
  const [docType, setDocType] = useState('cover_note');
  const [text, setText] = useState('Policy No: AB-12345\nInsured: Atlantic Mutual\nPremium: USD $1,250,000.00\nSum Insured: 50,000,000\nInception date: 2026-01-01');
  const [result, setResult] = useState<{ fields: Record<string, string | null>; confidence: number } | null>(null);
  const extract = useMutation({
    mutationFn: () => api<{ fields: Record<string, string | null>; confidence: number }>('/api/ocr/extract', { body: { documentType: docType, text } }),
    onSuccess: (r) => setResult(r),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Extraction failed'),
  });
  return (
    <div className={styles.console}>
      <p className={shared.cellSub}>Paste document text (image/PDF → text is an external OCR step). Fields are extracted deterministically.</p>
      <div className={styles.docTypeField}>
        <FormField label="Document type">
          <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="cover_note">Cover note</option>
            <option value="bordereaux">Bordereau</option>
          </Select>
        </FormField>
      </div>
      <FormField label="Document text"><Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className={styles.contextMono} /></FormField>
      <Button variant="primary" onClick={() => extract.mutate()} loading={extract.isPending} className={styles.startButton}>Extract fields</Button>
      {result && (
        <Card>
          <CardHeader title="Extracted fields" actions={<Badge color={result.confidence >= 0.6 ? 'green' : 'amber'}>{formatPercent(result.confidence)} confidence</Badge>} />
          <div className={styles.cardBody}>
            {Object.entries(result.fields).map(([k, v]) => (
              <div key={k} className={styles.fieldRow}>
                <span className={shared.cellSub}>{k}</span>
                <span className={shared.cellMain}>{v ?? <span className={styles.notFound}>not found</span>}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Voice() {
  const toast = useToast();
  const [transcript, setTranscript] = useState('Hey RIOS, show me open claims please');
  const [result, setResult] = useState<{ normalized: string; response: { reply?: string; actions?: { label?: string }[] } } | null>(null);
  const run = useMutation({
    mutationFn: () => api<{ normalized: string; response: { reply?: string; actions?: { label?: string }[] } }>('/api/voice/interpret', { body: { transcript } }),
    onSuccess: (r) => setResult(r),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Voice failed'),
  });
  return (
    <div className={styles.console}>
      <p className={shared.cellSub}>Speech→text is captured on-device; the transcript is normalised here and routed through the assistant.</p>
      <FormField label="Transcript"><Input value={transcript} onChange={(e) => setTranscript(e.target.value)} /></FormField>
      <Button variant="primary" onClick={() => run.mutate()} loading={run.isPending} className={styles.startButton}>Interpret</Button>
      {result && (
        <Card>
          <div className={styles.voiceBody}>
            <p className={shared.cellSub}>Heard: <em>{result.normalized}</em></p>
            {result.response.reply && <p className={shared.cellMain}>{result.response.reply}</p>}
            {(result.response.actions ?? []).map((a, i) => <Badge key={i} color="blue">{a.label}</Badge>)}
          </div>
        </Card>
      )}
    </div>
  );
}
