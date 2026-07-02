import { Grid2x2, Plus, Rows3, CircleCheck, CircleAlert, Sigma } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, Select, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';

/* ---------------- Types ---------------- */
interface TreatyOption {
  id: string;
  reference: string;
  name: string;
  currency: string;
}
interface TreatiesResponse { treaties: TreatyOption[]; }

interface BordereauHeader {
  id: string;
  contract_id?: string | null;
  kind: string;
  currency: string;
  status: string;
  row_count?: number;
  error_count?: number;
  total_minor?: number;
  created_at?: string | null;
}
interface BordereauLine {
  line_no: number;
  mapped: Record<string, unknown> | null;
  amount_minor: number | null;
  currency: string;
  is_valid: boolean;
  errors: string[] | null;
}
interface BordereauDetail extends BordereauHeader {
  lines: BordereauLine[];
}
interface UploadResult {
  id: string;
  status: string;
  rowCount: number;
  errorCount: number;
  totalMinor: number;
}

/* ---------------- Local data hooks ---------------- */
function useTreatyOptions() {
  return useQuery({
    queryKey: ['bordereaux', 'treaties'],
    queryFn: () => api<TreatiesResponse>(`/api/treaties${qs({})}`),
  });
}

function useBordereau(id: string | undefined) {
  return useQuery({
    queryKey: ['bordereau', id],
    queryFn: () => api<BordereauDetail>(`/api/bordereaux/${id}`),
    enabled: !!id,
  });
}

function useUploadBordereau() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { contractId?: string; kind: string; currency: string; rows: unknown[] }) =>
      api<UploadResult>('/api/bordereaux', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bordereau'] }),
  });
}

function useProcessBordereau(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ id: string; status: string }>(`/api/bordereaux/${id}/process`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bordereau', id] }),
  });
}

const KINDS = ['PREMIUM', 'LOSS'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF'];

const SAMPLE_ROWS = `[
  { "amount": 125000, "policy": "POL-001", "insured": "Acme Mfg" },
  { "amount": 84000, "policy": "POL-002", "insured": "Bright Logistics" }
]`;

export function BordereauxPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('bordereaux:write');
  const [showUpload, setShowUpload] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Bordereaux' }]}
        title="Bordereaux"
        description="Ingest premium and loss bordereaux. Malformed rows are rejected with line-level errors; validated bordereaux produce financial events and claims."
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setShowUpload(true)} icon={<Plus size={16} />}>
              Upload bordereau
            </Button>
          ) : (
            <Badge color="slate">read-only</Badge>
          )
        }
      />

      {selectedId ? (
        <BordereauDetailCard id={selectedId} canWrite={canWrite} onClear={() => setSelectedId(null)} />
      ) : (
        <Card>
          <EmptyState
            title="No bordereau selected"
            message="Upload a bordereau to validate its rows. The validation summary and line-level results will appear here."
            icon={<Grid2x2 size={16} />}
          />
        </Card>
      )}

      <UploadModal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        onUploaded={(id) => { setSelectedId(id); setShowUpload(false); }}
      />
    </>
  );
}

function BordereauDetailCard({ id, canWrite, onClear }: { id: string; canWrite: boolean; onClear: () => void }) {
  const toast = useToast();
  const { data, isLoading } = useBordereau(id);
  const process = useProcessBordereau(id);
  const [confirm, setConfirm] = useState(false);

  const doProcess = async () => {
    try {
      const res = await process.mutateAsync();
      toast.success(`Bordereau processed - ${titleCase(res.status)}`);
      setConfirm(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Processing failed');
      setConfirm(false);
    }
  };

  if (isLoading) return <Card><PageLoader label="Loading bordereau…" /></Card>;
  if (!data) return <Card><EmptyState title="Bordereau not found" message="It may have been removed." /></Card>;

  const errorCount = (data.lines ?? []).filter((l) => !l.is_valid).length;
  const validCount = (data.lines ?? []).length - errorCount;
  const canProcess = data.status === 'VALIDATED';

  const columns: Column<BordereauLine>[] = [
    { key: 'line', header: '#', align: 'right', sortValue: (l) => l.line_no, render: (l) => l.line_no },
    {
      key: 'valid',
      header: 'Result',
      render: (l) => l.is_valid
        ? <Badge color="green">Valid</Badge>
        : <Badge color="red">Invalid</Badge>,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (l) => l.amount_minor ?? 0,
      render: (l) => <span className={shared.money}>{formatMoney(l.amount_minor, l.currency || data.currency)}</span>,
    },
    {
      key: 'mapped',
      header: 'Mapped fields',
      render: (l) => {
        const entries = Object.entries(l.mapped ?? {}).filter(([k]) => k !== 'amount');
        if (!entries.length) return <span className={shared.cellSub}>-</span>;
        return <span className={shared.cellSub}>{entries.map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</span>;
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
                {titleCase(data.kind)} · {data.currency} · {formatDate(data.created_at)}
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
          <KpiCard label="Rows" value={data.lines.length} icon={<Rows3 size={20} />} accent="var(--primary)" />
          <KpiCard label="Valid" value={validCount} icon={<CircleCheck size={20} />} accent="var(--accent-emerald)" />
          <KpiCard label="Errors" value={errorCount} icon={<CircleAlert size={20} />} accent={errorCount ? 'var(--accent-rose)' : 'var(--accent-cyan)'} />
          <KpiCard label="Total" value={formatMoney(data.total_minor, data.currency)} icon={<Sigma size={20} />} accent="var(--accent-violet)" />
        </div>

        <Table
          columns={columns}
          rows={data.lines}
          rowKey={(l) => String(l.line_no)}
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

function SummaryStat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'bad' }) {
  return (
    <div>
      <div className={shared.cellSub}>{label}</div>
      <div
        className={shared.money}
        style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-medium)', color: tone === 'bad' ? 'var(--danger)' : undefined }}
      >
        {value}
      </div>
    </div>
  );
}

function UploadModal({ open, onClose, onUploaded }: {
  open: boolean; onClose: () => void; onUploaded: (id: string) => void;
}) {
  const toast = useToast();
  const upload = useUploadBordereau();
  const { data: treatyData } = useTreatyOptions();

  const [contractId, setContractId] = useState('');
  const [kind, setKind] = useState('PREMIUM');
  const [currency, setCurrency] = useState('USD');
  const [rowsText, setRowsText] = useState(SAMPLE_ROWS);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);

  const treaties = treatyData?.treaties ?? [];

  const parsed = useMemo<{ rows: unknown[] | null; err: string | null }>(() => {
    if (!rowsText.trim()) return { rows: null, err: 'Paste a JSON array of rows.' };
    try {
      const value = JSON.parse(rowsText);
      if (!Array.isArray(value)) return { rows: null, err: 'Rows must be a JSON array.' };
      return { rows: value, err: null };
    } catch {
      return { rows: null, err: 'Invalid JSON.' };
    }
  }, [rowsText]);

  const reset = () => {
    setContractId(''); setKind('PREMIUM'); setCurrency('USD');
    setRowsText(SAMPLE_ROWS); setError(null); setResult(null);
  };

  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!parsed.rows) { setError(parsed.err); return; }
    try {
      const res = await upload.mutateAsync({
        contractId: contractId || undefined,
        kind,
        currency,
        rows: parsed.rows,
      });
      setResult(res);
      if (res.errorCount > 0) {
        toast.error(`${res.errorCount} row(s) rejected - see line errors`);
      } else {
        toast.success(`Bordereau ${titleCase(res.status)} - ${res.rowCount} row(s)`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not upload the bordereau.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Upload bordereau"
      description="Paste a JSON array of rows. Each row needs at least an amount (major units); other fields are mapped through."
      size="lg"
      footer={
        result ? (
          <>
            <Button variant="ghost" onClick={close}>Close</Button>
            <Button variant="primary" onClick={() => onUploaded(result.id)}>View lines</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={submit} loading={upload.isPending} disabled={!parsed.rows}>
              Upload
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span className={shared.cellSub}>Status</span>
            <StatusPill status={result.status} />
          </div>
          <div className={shared.grid3} style={{ display: 'grid' }}>
            <SummaryStat label="Rows" value={result.rowCount} />
            <SummaryStat label="Errors" value={result.errorCount} tone={result.errorCount ? 'bad' : undefined} />
            <SummaryStat label="Total" value={formatMoney(result.totalMinor, currency)} />
          </div>
          <p className={shared.cellSub}>
            {result.errorCount > 0
              ? 'Some rows were rejected. Open the lines to see per-line errors.'
              : 'All rows validated. Open the lines and process when ready.'}
          </p>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div className={shared.grid3} style={{ display: 'grid' }}>
            <FormField label="Contract" hint="Optional">
              <Select value={contractId} onChange={(e) => setContractId(e.target.value)}>
                <option value="">Unassigned</option>
                {treaties.map((t) => (
                  <option key={t.id} value={t.id}>{t.reference ? `${t.reference} - ${t.name}` : t.name}</option>
                ))}
              </Select>
            </FormField>
            <FormField label="Kind" required>
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
              </Select>
            </FormField>
            <FormField label="Currency" required>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </FormField>
          </div>
          <FormField
            label="Rows (JSON array)"
            hint="amount is in major units; rows with a missing or zero amount raise the error count."
            error={error ?? undefined}
          >
            <Textarea
              value={rowsText}
              onChange={(e) => setRowsText(e.target.value)}
              rows={10}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
            />
          </FormField>
        </form>
      )}
    </Modal>
  );
}
