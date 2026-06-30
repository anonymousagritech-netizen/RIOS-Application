import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { formatDate, formatNumber, titleCase } from '../lib/format';
import { api, ApiError, getToken, API_BASE } from '../lib/api';
import shared from './shared.module.css';

/* ---------------- Source allowlist ---------------- */
const SOURCES: Record<string, string[]> = {
  contracts: ['id', 'reference', 'name', 'contract_kind', 'basis', 'line_of_business', 'direction', 'currency', 'status', 'period_start', 'period_end'],
  claims: ['id', 'reference', 'contract_id', 'currency', 'gross_loss_minor', 'outstanding_minor', 'paid_minor', 'status', 'loss_date', 'notified_date'],
  financial_events: ['id', 'contract_id', 'event_type', 'direction', 'amount_minor', 'currency', 'booked_at'],
  statements: ['id', 'reference', 'contract_id', 'currency', 'balance_minor', 'status'],
  parties: ['id', 'reference', 'legal_name', 'short_name', 'kind', 'country', 'status'],
};
const SOURCE_KEYS = Object.keys(SOURCES);
const OPS = ['=', '!=', '>', '<', '>=', '<=', 'like'] as const;
type Op = typeof OPS[number];

interface Filter { field: string; op: Op; value: string }
interface RunResult { rows: Record<string, unknown>[]; rowCount: number; source: string }
interface ReportDefinition {
  id: string; key: string; name: string; source: string; status: string; is_certified: boolean;
}

function isDateCol(c: string) { return /_(at|date)$/.test(c) || c.endsWith('_start') || c.endsWith('_end'); }
function isMinorCol(c: string) { return c.endsWith('_minor'); }

function renderCell(col: string, value: unknown) {
  if (value == null) return '-';
  if (isMinorCol(col) && (typeof value === 'number' || typeof value === 'string')) {
    const n = Number(value);
    return Number.isNaN(n) ? String(value) : <span className={shared.money}>{formatNumber(n)}</span>;
  }
  if (isDateCol(col) && typeof value === 'string') return formatDate(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/* ---------------- Local data hooks ---------------- */
function useReportDefinitions() {
  return useQuery({
    queryKey: ['report-definitions'],
    queryFn: () => api<{ definitions: ReportDefinition[] }>('/api/reports/definitions'),
  });
}

function useRunReport() {
  return useMutation({
    mutationFn: (body: { source: string; columns: string[]; filters?: Filter[] }) =>
      api<RunResult>('/api/reports/run', { body }),
  });
}

function useRunDefinition() {
  return useMutation({
    mutationFn: (id: string) => api<RunResult>(`/api/reports/definitions/${id}/run`, { body: {} }),
  });
}

function useSaveDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { key: string; name: string; source: string; columns: string[]; filters?: Filter[] }) =>
      api<ReportDefinition>('/api/reports/definitions', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-definitions'] }),
  });
}

/* ---------------- Page ---------------- */
export function ReportsPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const canWrite = hasPermission('reporting:write');

  const [source, setSource] = useState<string>(SOURCE_KEYS[0]!);
  const [columns, setColumns] = useState<string[]>(SOURCES[SOURCE_KEYS[0]!]!.slice(0, 5));
  const [filter, setFilter] = useState<Filter>({ field: SOURCES[SOURCE_KEYS[0]!]![0]!, op: '=', value: '' });
  const [result, setResult] = useState<RunResult | null>(null);
  const [showSave, setShowSave] = useState(false);

  const run = useRunReport();
  const allCols = SOURCES[source]!;

  const onChangeSource = (next: string) => {
    setSource(next);
    setColumns(SOURCES[next]!.slice(0, 5));
    setFilter({ field: SOURCES[next]![0]!, op: '=', value: '' });
    setResult(null);
  };

  const toggleColumn = (col: string) => {
    setColumns((cur) => (cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col]));
  };

  const activeFilters = (): Filter[] | undefined =>
    filter.value.trim() ? [{ field: filter.field, op: filter.op, value: filter.value.trim() }] : undefined;

  const runReport = async () => {
    if (!columns.length) { toast.error('Select at least one column.'); return; }
    try {
      const res = await run.mutateAsync({ source, columns, filters: activeFilters() });
      setResult(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not run the report.');
    }
  };

  const resultColumns: Column<Record<string, unknown>>[] = useMemo(
    () =>
      columns.map((col) => ({
        key: col,
        header: titleCase(col),
        align: isMinorCol(col) ? 'right' : 'left',
        sortValue: (row) => {
          const v = row[col];
          if (typeof v === 'number') return v;
          return v == null ? '' : String(v);
        },
        render: (row) => renderCell(col, row[col]),
      })),
    [columns],
  );

  return (
    <>
      <PageHeader
        title="Reports"
        description="Build ad-hoc reports over portfolio data and save reusable definitions."
        actions={
          canWrite ? <Badge color="green">reporting:write granted</Badge> : <Badge color="slate">read-only</Badge>
        }
      />

      <Card>
        <CardHeader
          title="Report builder"
          subtitle="Pick a source, choose columns, optionally filter, then run."
          actions={
            canWrite ? (
              <Button size="sm" variant="secondary" onClick={() => setShowSave(true)} disabled={!columns.length}>
                Save definition
              </Button>
            ) : null
          }
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <FormField label="Source" required>
            <Select value={source} onChange={(e) => onChangeSource(e.target.value)}>
              {SOURCE_KEYS.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </FormField>

          <FormField label="Columns" hint="Select the fields to include.">
            <div className={shared.checkGroup}>
              {allCols.map((col) => {
                const active = columns.includes(col);
                return (
                  <label key={col} className={`${shared.check} ${active ? shared.checkActive : ''}`}>
                    <input type="checkbox" checked={active} onChange={() => toggleColumn(col)} />
                    {col}
                  </label>
                );
              })}
            </div>
          </FormField>

          <FormField label="Filter (optional)" hint="Leave the value blank to skip filtering.">
            <div className={shared.toolbar}>
              <Select
                value={filter.field}
                onChange={(e) => setFilter((f) => ({ ...f, field: e.target.value }))}
                aria-label="Filter field"
              >
                {allCols.map((col) => <option key={col} value={col}>{col}</option>)}
              </Select>
              <Select
                value={filter.op}
                onChange={(e) => setFilter((f) => ({ ...f, op: e.target.value as Op }))}
                aria-label="Filter operator"
              >
                {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </Select>
              <Input
                value={filter.value}
                onChange={(e) => setFilter((f) => ({ ...f, value: e.target.value }))}
                placeholder="Value"
                aria-label="Filter value"
                style={{ minWidth: 160 }}
              />
            </div>
          </FormField>

          <div>
            <Button variant="primary" onClick={runReport} loading={run.isPending} disabled={!columns.length}>
              Run report
            </Button>
          </div>
        </div>
      </Card>

      {result && (
        <Card padded={false}>
          <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
            <CardHeader
              title="Results"
              subtitle={`${formatNumber(result.rowCount)} row${result.rowCount === 1 ? '' : 's'} from ${titleCase(result.source)}`}
            />
          </div>
          <Table
            columns={resultColumns}
            rows={result.rows}
            rowKey={(r) => String(r.id ?? JSON.stringify(r))}
            empty={<EmptyState title="No rows" message="The query returned no rows. Adjust the filter." icon="▤" />}
          />
        </Card>
      )}

      <SavedDefinitions />

      <SaveDefinitionModal
        open={showSave}
        onClose={() => setShowSave(false)}
        source={source}
        columns={columns}
        filters={activeFilters()}
      />
    </>
  );
}

/* ---------------- Saved definitions ---------------- */
function SavedDefinitions() {
  const { data, isLoading } = useReportDefinitions();
  const toast = useToast();
  const runDef = useRunDefinition();
  const [exporting, setExporting] = useState<string | null>(null);
  const [view, setView] = useState<{ name: string; result: RunResult } | null>(null);

  const onRun = async (def: ReportDefinition) => {
    try {
      const res = await runDef.mutateAsync(def.id);
      setView({ name: def.name, result: res });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not run the definition.');
    }
  };

  const onExport = async (def: ReportDefinition) => {
    setExporting(def.id);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/reports/definitions/${def.id}/export?format=csv`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new ApiError(res.status, res.statusText || 'Export failed');
      const csv = await res.text();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${def.key}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${def.key}.csv`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not export the report.');
    } finally {
      setExporting(null);
    }
  };

  const columns: Column<ReportDefinition>[] = [
    { key: 'key', header: 'Key', sortValue: (d) => d.key, render: (d) => <span className={shared.cellRef}>{d.key}</span> },
    { key: 'name', header: 'Name', sortValue: (d) => d.name, render: (d) => <span className={shared.cellMain}>{d.name}</span> },
    { key: 'source', header: 'Source', sortValue: (d) => d.source, render: (d) => titleCase(d.source) },
    { key: 'status', header: 'Status', sortValue: (d) => d.status, render: (d) => <StatusPill status={d.status} /> },
    {
      key: 'certified',
      header: 'Certified',
      render: (d) => (d.is_certified ? <Badge color="green">Certified</Badge> : <span className={shared.cellSub}>-</span>),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (d) => (
        <div style={{ display: 'inline-flex', gap: 'var(--space-2)' }}>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => onRun(d)}
            loading={runDef.isPending && runDef.variables === d.id}
          >
            Run
          </Button>
          <Button size="sm" variant="subtle" onClick={() => onExport(d)} loading={exporting === d.id}>
            Export CSV
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader title="Saved definitions" subtitle="Run or export previously saved reports." />
        </div>
        <Table
          columns={columns}
          rows={data?.definitions}
          loading={isLoading}
          rowKey={(d) => d.id}
          empty={<EmptyState title="No saved definitions" message="Build a report above and save it to reuse later." icon="▤" />}
        />
      </Card>

      <Modal
        open={!!view}
        onClose={() => setView(null)}
        title={view?.name ?? 'Report'}
        description={view ? `${formatNumber(view.result.rowCount)} row${view.result.rowCount === 1 ? '' : 's'}` : undefined}
        size="lg"
        footer={<Button variant="ghost" onClick={() => setView(null)}>Close</Button>}
      >
        {view && <DefinitionResultTable result={view.result} />}
      </Modal>
    </>
  );
}

function DefinitionResultTable({ result }: { result: RunResult }) {
  const cols = result.rows.length ? Object.keys(result.rows[0]!) : [];
  const columns: Column<Record<string, unknown>>[] = cols.map((col) => ({
    key: col,
    header: titleCase(col),
    align: isMinorCol(col) ? 'right' : 'left',
    render: (row) => renderCell(col, row[col]),
  }));
  return (
    <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
      <Table
        columns={columns}
        rows={result.rows}
        rowKey={(r) => String(r.id ?? JSON.stringify(r))}
        empty={<EmptyState title="No rows" />}
      />
    </div>
  );
}

/* ---------------- Save definition modal ---------------- */
function SaveDefinitionModal({
  open, onClose, source, columns, filters,
}: {
  open: boolean; onClose: () => void; source: string; columns: string[]; filters?: Filter[];
}) {
  const toast = useToast();
  const save = useSaveDefinition();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setKey(''); setName(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!key.trim() || !name.trim()) { setError('Key and name are required.'); return; }
    if (!columns.length) { setError('Select at least one column before saving.'); return; }
    try {
      await save.mutateAsync({ key: key.trim(), name: name.trim(), source, columns, filters });
      toast.success(`Definition “${name}” saved`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the definition.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Save report definition"
      description={`Saves the current ${titleCase(source)} report (${columns.length} column${columns.length === 1 ? '' : 's'}).`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!key.trim() || !name.trim()}>
            Save definition
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Key" value={key} onChange={setKey} required placeholder="e.g. active_contracts" />
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Active contracts" />
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
