/**
 * Bordereaux upload wizard + history list (P2-07).
 *
 * Three-step upload flow:
 *   1. Drop / browse  — accepts CSV (XLSX noted as coming soon).
 *   2. Preview & submit — shows the first 20 parsed rows with a quick validity
 *      indicator; user picks contract / kind / currency then submits.
 *   3. Result — VALIDATED or REJECTED status, row summary, "View lines" link.
 *
 * Below the wizard a history table lists all previous uploads with status badges
 * and totals.  Selecting a row opens the existing line-level detail card.
 */

import {
  Upload, FileText, CheckCircle2, XCircle, Grid2x2, Rows3,
  CircleCheck, CircleAlert, Sigma, AlertTriangle,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../lib/api';
import { useStatusColors, useCurrencies } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/Modal';
import { FormField, Select } from '../components/Form';
import { PageLoader, Spinner } from '../components/Feedback';
import { formatMoney, formatDateTime, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './BordereauxPage.module.css';

/* ============================================================
   Types
   ============================================================ */

interface TreatyOption { id: string; reference: string; name: string; currency: string; }
interface TreatiesResponse { treaties: TreatyOption[]; }

interface ParseResult {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
}

interface UploadResult {
  id: string;
  status: string;
  rowCount: number;
  errorCount: number;
  totalMinor: number;
  reconciles: boolean;
  varianceMinor: number;
}

interface BordereauListItem {
  id: string;
  contractId: string | null;
  kind: string;
  reference: string;
  currency: string;
  status: string;
  rowCount: number;
  errorCount: number;
  totalMinor: number;
  createdAt: string;
  processedAt: string | null;
}

interface BordereauHeader {
  id: string;
  contractId?: string | null;
  kind: string;
  currency: string;
  status: string;
  rowCount?: number;
  errorCount?: number;
  totalMinor?: number;
  createdAt?: string | null;
}

interface BordereauLine {
  lineNo: number;
  mapped: Record<string, unknown> | null;
  amountMinor: number | null;
  currency: string;
  isValid: boolean;
  errors: string[] | null;
}

interface BordereauDetail extends BordereauHeader { lines: BordereauLine[]; }

type WizardStep =
  | { step: 'drop'; error?: string }
  | { step: 'parsing'; filename: string }
  | { step: 'configure'; filename: string; parseResult: ParseResult; error?: string; submitting: boolean }
  | { step: 'done'; filename: string; result: UploadResult; currency: string };

/* ============================================================
   Hooks
   ============================================================ */

function useTreatyOptions() {
  return useQuery({
    queryKey: ['bordereaux', 'treaties'],
    queryFn: () => api<TreatiesResponse>(`/api/treaties${qs({})}`),
  });
}

function useBordereauList() {
  return useQuery({
    queryKey: ['bordereaux', 'list'],
    queryFn: () => api<{ bordereaux: BordereauListItem[] }>('/api/bordereaux'),
  });
}

function useBordereau(id: string | undefined) {
  return useQuery({
    queryKey: ['bordereau', id],
    queryFn: () => api<BordereauDetail>(`/api/bordereaux/${id}`),
    enabled: !!id,
  });
}

function useProcessBordereau(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ id: string; status: string }>(`/api/bordereaux/${id}/process`, { body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bordereau', id] });
      qc.invalidateQueries({ queryKey: ['bordereaux', 'list'] });
    },
  });
}

/* ============================================================
   Helpers
   ============================================================ */

const AMOUNT_FIELDS = ['amount', 'premium', 'loss'];
/** Numeric-looking fields the domain validator understands — convert string → number. */
const NUMERIC_FIELDS = ['amount', 'premium', 'loss', 'paid', 'outstanding', 'gross_loss'];

function rowLooksValid(row: Record<string, string>): boolean {
  for (const f of AMOUNT_FIELDS) {
    const v = row[f];
    if (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0) return true;
  }
  return false;
}

/**
 * Coerce known numeric fields to JS numbers so the domain validator accepts them.
 * CSV rows are all strings; without coercion `typeof amount !== 'number'` would
 * fail every row.
 */
function prepareRows(rows: Record<string, string>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of NUMERIC_FIELDS) {
      const raw = row[key];
      if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) {
        out[key] = Number(raw);
      }
    }
    return out;
  });
}

/* ============================================================
   Step indicator
   ============================================================ */

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const STEPS = [
    { n: 1, label: 'Upload file' },
    { n: 2, label: 'Preview & submit' },
    { n: 3, label: 'Result' },
  ] as const;
  return (
    <div className={styles.steps}>
      {STEPS.map((s, idx) => {
        const done = current > s.n;
        const active = current === s.n;
        return (
          <div key={s.n} style={{ display: 'contents' }}>
            <div className={`${styles.stepItem} ${done ? styles.stepDone : ''} ${active ? styles.stepCurrent : ''}`}>
              <div className={styles.stepNum}>
                {done ? <CheckCircle2 size={12} /> : s.n}
              </div>
              <span className={styles.stepLabel}>{s.label}</span>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={`${styles.stepConnector} ${done ? styles.stepConnectorDone : ''}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   Step 1 — Drop zone
   ============================================================ */

function DropZoneStep({
  state, onFile,
}: {
  state: Extract<WizardStep, { step: 'drop' }>;
  onFile: (file: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = (file: File | undefined) => {
    if (!file) return;
    onFile(file);
  };

  return (
    <div>
      <div
        className={`${styles.dropZone} ${dragOver ? styles.dropZoneDragOver : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); handle(e.dataTransfer.files[0]); }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        role="button"
        tabIndex={0}
        aria-label="Drop CSV file here or click to browse"
      >
        <Upload size={32} className={styles.dropIcon} />
        <p className={styles.dropTitle}>Drop a CSV file here</p>
        <p className={styles.dropSub}>or click to browse</p>
        <p className={styles.dropFormats}>Accepted: .csv · .xlsx (XLSX requires export as CSV first)</p>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          style={{ display: 'none' }}
          onChange={(e) => { handle(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>
      {state.error && (
        <p className={styles.dropError} role="alert">
          <AlertTriangle size={14} />
          {state.error}
        </p>
      )}
    </div>
  );
}

/* ============================================================
   Step 1 — Parsing in progress
   ============================================================ */

function ParsingStep({ filename }: { filename: string }) {
  return (
    <div className={styles.parsingBox}>
      <Spinner size={26} />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Parsing file…</span>
      <span className={styles.parsingFilename}>{filename}</span>
    </div>
  );
}

/* ============================================================
   Step 2 — Configure + preview
   ============================================================ */

function ConfigureStep({
  state, treaties, currencies,
  contractId, setContractId,
  kind, setKind,
  currency, setCurrency,
  onBack, onSubmit,
}: {
  state: Extract<WizardStep, { step: 'configure' }>;
  treaties: TreatyOption[];
  currencies: { code: string; name: string }[];
  contractId: string; setContractId: (v: string) => void;
  kind: 'PREMIUM' | 'LOSS'; setKind: (v: 'PREMIUM' | 'LOSS') => void;
  currency: string; setCurrency: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const { parseResult, filename, error, submitting } = state;
  const previewRows = parseResult.rows.slice(0, 20);
  const totalRows = parseResult.rowCount;
  const validCount = parseResult.rows.filter(rowLooksValid).length;
  const warnCount = totalRows - validCount;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* Validation summary */}
      <div className={styles.summaryBar}>
        <FileText size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span className={styles.summaryFile}>{filename}</span>
        <span style={{ color: 'var(--text-muted)' }}>·</span>
        <span style={{ fontSize: 'var(--text-sm)' }}>{totalRows.toLocaleString()} row{totalRows !== 1 ? 's' : ''} parsed</span>
        <span style={{ color: 'var(--text-muted)' }}>·</span>
        <span className={styles.summaryOk}>{validCount} appear valid</span>
        {warnCount > 0 && (
          <>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span className={styles.summaryWarn}>{warnCount} may have errors</span>
          </>
        )}
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Final validation occurs on submission
        </span>
      </div>

      {/* Config form */}
      <div className={styles.configGrid}>
        <FormField label="Contract" hint="Optional">
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)}>
            <option value="">Unassigned</option>
            {treaties.map((t) => (
              <option key={t.id} value={t.id}>
                {t.reference ? `${t.reference} — ${t.name}` : t.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Kind" required>
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'PREMIUM' | 'LOSS')}>
            <option value="PREMIUM">Premium</option>
            <option value="LOSS">Loss</option>
          </Select>
        </FormField>
        <FormField label="Currency" required>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
            ))}
          </Select>
        </FormField>
      </div>

      {/* Preview table — first 20 rows */}
      {previewRows.length > 0 && (
        <div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
            Preview (first {previewRows.length} of {totalRows} rows) — rows flagged
            <span style={{ color: 'var(--danger)' }}> red</span> have no recognised amount field
          </p>
          <div className={styles.previewWrap}>
            <table className={styles.previewTable}>
              <thead>
                <tr>
                  <th>#</th>
                  {parseResult.headers.map((h) => <th key={h}>{h}</th>)}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => {
                  const valid = rowLooksValid(row);
                  return (
                    <tr key={i} className={!valid ? styles.rowInvalid : ''}>
                      <td style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                      {parseResult.headers.map((h) => (
                        <td key={h}>
                          {row[h] != null && row[h] !== '' ? row[h] : (
                            <span className={styles.cellEmpty}>—</span>
                          )}
                        </td>
                      ))}
                      <td>
                        {valid
                          ? <Badge color="green">OK</Badge>
                          : <Badge color="red">No amount</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totalRows > 20 && (
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
              Showing 20 of {totalRows.toLocaleString()} rows — all rows will be submitted.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className={styles.dropError} role="alert">
          <AlertTriangle size={14} />{error}
        </p>
      )}

      <div className={styles.wizardActions}>
        <Button variant="ghost" onClick={onBack} disabled={submitting}>Back</Button>
        <div className={styles.wizardActionsRight}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {totalRows.toLocaleString()} row{totalRows !== 1 ? 's' : ''} will be submitted
          </span>
          <Button variant="primary" onClick={onSubmit} loading={submitting}>
            Upload bordereau
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Step 3 — Result
   ============================================================ */

function ResultStep({
  state, onViewLines, onReset,
}: {
  state: Extract<WizardStep, { step: 'done' }>;
  onViewLines: (id: string) => void;
  onReset: () => void;
}) {
  const { result, currency } = state;
  const ok = result.status === 'VALIDATED';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* Icon + heading */}
      <div style={{ textAlign: 'center', paddingTop: 'var(--space-2)' }}>
        <div className={`${styles.resultIcon} ${ok ? styles.resultIconOk : styles.resultIconFail}`}>
          {ok ? <CheckCircle2 size={28} /> : <XCircle size={28} />}
        </div>
        <h3 className={styles.resultHeading}>
          {ok ? 'Bordereau validated' : 'Bordereau rejected'}
        </h3>
        <p className={styles.resultSub}>
          {ok
            ? 'All rows passed validation. Review the lines and process when ready.'
            : `${result.errorCount} row${result.errorCount !== 1 ? 's' : ''} failed validation. Open the lines to see per-line errors.`}
        </p>
      </div>

      {/* Summary stats */}
      <div className={shared.grid3} style={{ display: 'grid' }}>
        <SummaryStat label="Rows" value={result.rowCount} />
        <SummaryStat
          label="Errors"
          value={result.errorCount}
          tone={result.errorCount > 0 ? 'bad' : undefined}
        />
        <SummaryStat
          label="Total"
          value={formatMoney(result.totalMinor, currency)}
        />
      </div>

      {!result.reconciles && result.varianceMinor !== 0 && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--danger)', textAlign: 'center' }}>
          Control total mismatch — variance: {formatMoney(result.varianceMinor, currency)}
        </p>
      )}

      <div className={styles.wizardActions}>
        <Button variant="ghost" onClick={onReset}>Upload another</Button>
        <Button variant="primary" onClick={() => onViewLines(result.id)}>
          View lines
        </Button>
      </div>
    </div>
  );
}

/* ============================================================
   Wizard card — orchestrates all steps
   ============================================================ */

function UploadWizard({ onDone }: { onDone: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: treatyData } = useTreatyOptions();
  const { data: ccyData } = useCurrencies();

  const treaties = treatyData?.treaties ?? [];
  const currencies = ccyData?.currencies ?? [];

  // Config state — persists across wizard resets so the user doesn't re-enter defaults
  const [contractId, setContractId] = useState('');
  const [kind, setKind] = useState<'PREMIUM' | 'LOSS'>('PREMIUM');
  const [currency, setCurrency] = useState('USD');

  const [wiz, setWiz] = useState<WizardStep>({ step: 'drop' });

  const currentStepNum = (): 1 | 2 | 3 => {
    if (wiz.step === 'drop' || wiz.step === 'parsing') return 1;
    if (wiz.step === 'configure') return 2;
    return 3;
  };

  const handleFile = async (file: File) => {
    const name = file.name.toLowerCase();
    const isXlsx = name.endsWith('.xlsx');
    const isCsv = name.endsWith('.csv') || file.type === 'text/csv' || file.type === 'text/plain';

    if (isXlsx) {
      setWiz({
        step: 'drop',
        error: 'XLSX files cannot be parsed without additional dependencies. Please re-save the file as CSV and upload again.',
      });
      return;
    }
    if (!isCsv && !isXlsx) {
      setWiz({ step: 'drop', error: 'Only .csv files are supported. Please convert your file to CSV and try again.' });
      return;
    }

    setWiz({ step: 'parsing', filename: file.name });

    try {
      const text = await file.text();
      const parseResult = await api<ParseResult>('/api/bordereaux/parse', { body: { csv: text } });
      setWiz({ step: 'configure', filename: file.name, parseResult, submitting: false });
    } catch (err) {
      setWiz({
        step: 'drop',
        error: err instanceof ApiError ? err.message : 'Failed to parse the CSV file.',
      });
    }
  };

  const handleSubmit = async () => {
    if (wiz.step !== 'configure') return;
    setWiz({ ...wiz, submitting: true, error: undefined });
    try {
      const body = {
        contractId: contractId || undefined,
        kind,
        currency,
        rows: prepareRows(wiz.parseResult.rows),
      };
      const result = await api<UploadResult>('/api/bordereaux', { body });
      qc.invalidateQueries({ queryKey: ['bordereaux', 'list'] });
      if (result.errorCount > 0) {
        toast.error(`${result.errorCount} row${result.errorCount !== 1 ? 's' : ''} rejected — see line errors`);
      } else {
        toast.success(`Bordereau ${titleCase(result.status)} — ${result.rowCount} row${result.rowCount !== 1 ? 's' : ''}`);
      }
      setWiz({ step: 'done', filename: wiz.filename, result, currency });
    } catch (err) {
      setWiz({
        ...wiz,
        submitting: false,
        error: err instanceof ApiError ? err.message : 'Could not upload the bordereau.',
      });
    }
  };

  const reset = () => setWiz({ step: 'drop' });

  return (
    <Card>
      <StepIndicator current={currentStepNum()} />

      {wiz.step === 'drop' && (
        <DropZoneStep state={wiz} onFile={handleFile} />
      )}

      {wiz.step === 'parsing' && (
        <ParsingStep filename={wiz.filename} />
      )}

      {wiz.step === 'configure' && (
        <ConfigureStep
          state={wiz}
          treaties={treaties}
          currencies={currencies}
          contractId={contractId} setContractId={setContractId}
          kind={kind} setKind={setKind}
          currency={currency} setCurrency={setCurrency}
          onBack={reset}
          onSubmit={handleSubmit}
        />
      )}

      {wiz.step === 'done' && (
        <ResultStep
          state={wiz}
          onViewLines={(id) => { onDone(id); reset(); }}
          onReset={reset}
        />
      )}
    </Card>
  );
}

/* ============================================================
   History table
   ============================================================ */

function HistoryCard({ onSelect }: { onSelect: (id: string) => void }) {
  const { data, isLoading } = useBordereauList();
  const statusColors = useStatusColors('bordereau_status');
  const list = data?.bordereaux ?? [];

  const columns: Column<BordereauListItem>[] = [
    {
      key: 'ref',
      header: 'Reference',
      sortValue: (b) => b.reference ?? '',
      render: (b) => <span className={shared.cellRef}>{b.reference ?? '—'}</span>,
    },
    {
      key: 'date',
      header: 'Uploaded',
      sortValue: (b) => b.createdAt ?? '',
      render: (b) => <span className={shared.cellSub}>{formatDateTime(b.createdAt)}</span>,
    },
    {
      key: 'kind',
      header: 'Kind',
      render: (b) => titleCase(b.kind),
    },
    {
      key: 'ccy',
      header: 'Currency',
      render: (b) => <span className={shared.cellRef}>{b.currency}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) => <StatusPill status={b.status} metaColors={statusColors} />,
    },
    {
      key: 'rows',
      header: 'Rows',
      align: 'right',
      sortValue: (b) => b.rowCount ?? 0,
      render: (b) => b.rowCount ?? '—',
    },
    {
      key: 'errors',
      header: 'Errors',
      align: 'right',
      sortValue: (b) => b.errorCount ?? 0,
      render: (b) => (
        b.errorCount > 0
          ? <span style={{ color: 'var(--danger)', fontVariantNumeric: 'tabular-nums' }}>{b.errorCount}</span>
          : <span className={shared.cellSub}>0</span>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      sortValue: (b) => b.totalMinor ?? 0,
      render: (b) => (
        <span className={shared.money}>{formatMoney(b.totalMinor ?? 0, b.currency)}</span>
      ),
    },
    {
      key: 'action',
      header: '',
      render: (b) => (
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onSelect(b.id); }}>
          View
        </Button>
      ),
    },
  ];

  return (
    <Card padded={false}>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader
          title="Upload history"
          subtitle="Most recent bordereaux — select to view line-level detail"
        />
      </div>
      <Table
        columns={columns}
        rows={list}
        rowKey={(b) => b.id}
        loading={isLoading}
        skeletonRows={4}
        empty={
          <EmptyState
            title="No bordereaux uploaded yet"
            message="Use the upload wizard above to ingest your first bordereau."
            icon={<Grid2x2 size={16} />}
          />
        }
      />
    </Card>
  );
}

/* ============================================================
   Line-level detail card  (existing, unchanged behaviour)
   ============================================================ */

function SummaryStat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'bad' }) {
  return (
    <div>
      <div className={shared.cellSub}>{label}</div>
      <div
        className={shared.money}
        style={{
          fontSize: 'var(--text-lg)',
          fontWeight: 'var(--weight-medium)',
          color: tone === 'bad' ? 'var(--danger)' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function BordereauDetailCard({
  id, canWrite, onClear,
}: {
  id: string; canWrite: boolean; onClear: () => void;
}) {
  const toast = useToast();
  const { data, isLoading } = useBordereau(id);
  const process = useProcessBordereau(id);
  const [confirm, setConfirm] = useState(false);

  const doProcess = async () => {
    try {
      const res = await process.mutateAsync();
      toast.success(`Bordereau processed — ${titleCase(res.status)}`);
      setConfirm(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Processing failed');
      setConfirm(false);
    }
  };

  if (isLoading) return <Card><PageLoader label="Loading bordereau…" /></Card>;
  if (!data) return <Card><EmptyState title="Bordereau not found" message="It may have been removed." /></Card>;

  const errorCount = (data.lines ?? []).filter((l) => !l.isValid).length;
  const validCount = (data.lines ?? []).length - errorCount;
  const canProcess = data.status === 'VALIDATED';

  const columns: Column<BordereauLine>[] = [
    {
      key: 'line',
      header: '#',
      align: 'right',
      sortValue: (l) => l.lineNo,
      render: (l) => l.lineNo,
    },
    {
      key: 'valid',
      header: 'Result',
      render: (l) => l.isValid
        ? <Badge color="green">Valid</Badge>
        : <Badge color="red">Invalid</Badge>,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (l) => l.amountMinor ?? 0,
      render: (l) => (
        <span className={shared.money}>
          {formatMoney(l.amountMinor, l.currency || data.currency)}
        </span>
      ),
    },
    {
      key: 'mapped',
      header: 'Mapped fields',
      render: (l) => {
        const entries = Object.entries(l.mapped ?? {}).filter(([k]) => k !== 'amount');
        if (!entries.length) return <span className={shared.cellSub}>-</span>;
        return (
          <span className={shared.cellSub}>
            {entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}
          </span>
        );
      },
    },
    {
      key: 'errors',
      header: 'Errors',
      render: (l) => l.errors?.length
        ? <span style={{ color: 'var(--danger)', fontSize: 'var(--text-xs)' }}>{l.errors.join('; ')}</span>
        : <span className={shared.cellSub}>-</span>,
    },
  ];

  return (
    <>
      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader
            title={
              <span>
                Bordereau <span className={shared.cellRef}>{data.id}</span>
              </span>
            }
            subtitle={
              <span>
                {titleCase(data.kind)} · {data.currency} · {formatDate(data.createdAt)}
              </span>
            }
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <StatusPill status={data.status} />
                <Button size="sm" variant="ghost" onClick={onClear}>Close</Button>
                {canWrite && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setConfirm(true)}
                    disabled={!canProcess}
                    title={canProcess ? undefined : 'Only VALIDATED bordereaux can be processed'}
                  >
                    Process
                  </Button>
                )}
              </div>
            }
          />
        </div>

        <div className={shared.kpiRow} style={{ padding: 'var(--space-4) var(--space-5)', marginBottom: 0 }}>
          <KpiCard label="Rows" value={(data.lines ?? []).length} icon={<Rows3 size={20} />} accent="var(--primary)" />
          <KpiCard label="Valid" value={validCount} icon={<CircleCheck size={20} />} accent="var(--accent-emerald)" />
          <KpiCard label="Errors" value={errorCount} icon={<CircleAlert size={20} />} accent={errorCount ? 'var(--accent-rose)' : 'var(--accent-cyan)'} />
          <KpiCard label="Total" value={formatMoney(data.totalMinor, data.currency)} icon={<Sigma size={20} />} accent="var(--accent-violet)" />
        </div>

        <Table
          columns={columns}
          rows={data.lines ?? []}
          rowKey={(l) => String(l.lineNo)}
          empty={<EmptyState title="No lines" message="This bordereau has no rows." />}
          skeletonRows={3}
        />
      </Card>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={doProcess}
        loading={process.isPending}
        title="Process bordereau?"
        confirmLabel="Process"
        message={
          data.kind === 'PREMIUM'
            ? 'Processing books a financial event for each valid premium row. Material accounting action.'
            : 'Processing registers a claim for each valid loss row. Material action.'
        }
      />
    </>
  );
}

/* ============================================================
   Page root
   ============================================================ */

export function BordereauxPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('bordereaux:write');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className={shared.stack}>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Bordereaux' }]}
        title="Bordereaux"
        description="Ingest premium and loss bordereaux. Validated rows produce financial events or claims; rejected rows carry line-level error detail."
      />

      {selectedId ? (
        <BordereauDetailCard
          id={selectedId}
          canWrite={canWrite}
          onClear={() => setSelectedId(null)}
        />
      ) : canWrite ? (
        <UploadWizard onDone={(id) => setSelectedId(id)} />
      ) : (
        <Card>
          <EmptyState
            title="Read-only access"
            message="You do not have permission to upload bordereaux. Select a row from the history below to view line details."
            icon={<Grid2x2 size={16} />}
          />
        </Card>
      )}

      <HistoryCard onSelect={(id) => { setSelectedId(id); }} />
    </div>
  );
}
