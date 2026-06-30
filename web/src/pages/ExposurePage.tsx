import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatPercent, titleCase } from '../lib/format';
import { Radar } from 'lucide-react';
import shared from './shared.module.css';
import styles from './ExposurePage.module.css';

/* ---------------- Types ---------------- */
interface Accumulation {
  id: string;
  peril: string;
  zone: string;
  currency: string;
  capacity_minor: number;
  usedMinor: number;
  netMinor: number;
  utilisationPct: number;
  breached: boolean;
}
interface AccumulationsResponse { accumulations: Accumulation[]; }

interface AccumulationEntry {
  id: string;
  risk_id?: string | null;
  contract_id?: string | null;
  gross_exposure_minor?: number | null;
  net_exposure_minor?: number | null;
  currency: string;
}
interface AccumulationDetail extends Accumulation {
  entries: AccumulationEntry[];
}

interface SummaryRow { peril: string; zone: string; grossMinor: number; netMinor: number; }
interface SummaryResponse { summary: SummaryRow[]; }

/* ---------------- Local data hooks ---------------- */
function useAccumulations() {
  return useQuery({
    queryKey: ['exposure', 'accumulations'],
    queryFn: () => api<AccumulationsResponse>('/api/exposure/accumulations'),
  });
}

function useAccumulation(id: string | undefined) {
  return useQuery({
    queryKey: ['exposure', 'accumulation', id],
    queryFn: () => api<AccumulationDetail>(`/api/exposure/accumulations/${id}`),
    enabled: !!id,
  });
}

function useExposureSummary() {
  return useQuery({
    queryKey: ['exposure', 'summary'],
    queryFn: () => api<SummaryResponse>(`/api/exposure/summary${qs({})}`),
  });
}

function useCreateAccumulation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { peril: string; zone: string; currency: string; capacity: number }) =>
      api<Accumulation>('/api/exposure/accumulations', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exposure', 'accumulations'] });
      qc.invalidateQueries({ queryKey: ['exposure', 'summary'] });
    },
  });
}

function useAddEntry(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { riskId?: string; contractId?: string; grossExposure: number; netExposure: number; currency: string }) =>
      api<AccumulationEntry>(`/api/exposure/accumulations/${id}/entries`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['exposure', 'accumulation', id] });
      qc.invalidateQueries({ queryKey: ['exposure', 'accumulations'] });
      qc.invalidateQueries({ queryKey: ['exposure', 'summary'] });
    },
  });
}

const PERILS = ['EARTHQUAKE', 'WINDSTORM', 'FLOOD', 'WILDFIRE', 'TERROR'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF'];

export function ExposurePage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('exposure:write');
  const { data, isLoading } = useAccumulations();
  const [showNew, setShowNew] = useState(false);
  const [entryFor, setEntryFor] = useState<Accumulation | null>(null);

  const rows = data?.accumulations ?? [];

  const columns: Column<Accumulation>[] = useMemo(() => [
    {
      key: 'peril',
      header: 'Peril / Zone',
      sortValue: (a) => `${a.peril} ${a.zone}`,
      render: (a) => (
        <div>
          <div className={shared.cellMain}>{titleCase(a.peril)}</div>
          <div className={shared.cellSub}>{a.zone}</div>
        </div>
      ),
    },
    { key: 'currency', header: 'CCY', render: (a) => a.currency },
    {
      key: 'capacity',
      header: 'Capacity',
      align: 'right',
      sortValue: (a) => a.capacity_minor,
      render: (a) => <span className={shared.money}>{formatMoney(a.capacity_minor, a.currency)}</span>,
    },
    {
      key: 'used',
      header: 'Used (net)',
      align: 'right',
      sortValue: (a) => a.usedMinor,
      render: (a) => <span className={shared.money}>{formatMoney(a.usedMinor, a.currency)}</span>,
    },
    {
      key: 'utilisation',
      header: 'Utilisation',
      sortValue: (a) => a.utilisationPct,
      render: (a) => <UtilisationBar pct={a.utilisationPct} breached={a.breached} />,
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (a) => a.breached
        ? <StatusPill status="BREACHED" metaColors={{ BREACHED: 'red' }} />
        : <Badge color="green">Within capacity</Badge>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) => canWrite
        ? <Button size="sm" variant="secondary" onClick={() => setEntryFor(a)}>Add entry</Button>
        : null,
    },
  ], [canWrite]);

  return (
    <>
      <PageHeader
        title="Exposure"
        description="Aggregate accumulations by peril and zone. Utilisation tracks net exposure against capacity; breaches are flagged."
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>
              New accumulation
            </Button>
          ) : (
            <Badge color="slate">read-only</Badge>
          )
        }
      />

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader title="Accumulations" subtitle="Net exposure against declared capacity per peril/zone." />
        </div>
        <Table
          columns={columns}
          rows={rows}
          loading={isLoading}
          rowKey={(a) => a.id}
          empty={<EmptyState title="No accumulations" message="Create an accumulation to start tracking exposure." icon={<Radar size={16} />} />}
        />
      </Card>

      <SummaryCard />

      <NewAccumulationModal open={showNew} onClose={() => setShowNew(false)} />
      <AddEntryModal accumulation={entryFor} onClose={() => setEntryFor(null)} />
    </>
  );
}

function UtilisationBar({ pct, breached }: { pct: number; breached: boolean }) {
  const value = Math.max(0, pct);
  const width = Math.min(100, value * 100);
  const tone = breached ? 'var(--danger)' : value >= 0.8 ? 'var(--c-amber)' : 'var(--c-green)';
  return (
    <div className={styles.barWrap}>
      <div className={styles.barTrack}>
        <div className={styles.barFill} style={{ width: `${width}%`, background: tone }} />
      </div>
      <span className={styles.barValue}>{formatPercent(value)}</span>
    </div>
  );
}

function SummaryCard() {
  const { data, isLoading } = useExposureSummary();
  const rows = data?.summary ?? [];

  const columns: Column<SummaryRow>[] = [
    {
      key: 'group',
      header: 'Peril / Zone',
      sortValue: (s) => `${s.peril} ${s.zone}`,
      render: (s) => (
        <div>
          <div className={shared.cellMain}>{titleCase(s.peril)}</div>
          <div className={shared.cellSub}>{s.zone}</div>
        </div>
      ),
    },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (s) => s.grossMinor, render: (s) => <span className={shared.money}>{formatMoney(s.grossMinor)}</span> },
    { key: 'net', header: 'Net', align: 'right', sortValue: (s) => s.netMinor, render: (s) => <span className={shared.money}>{formatMoney(s.netMinor)}</span> },
  ];

  return (
    <Card padded={false}>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader title="Gross / net by peril and zone" subtitle="Aggregated exposure across all accumulation entries." />
      </div>
      <Table
        columns={columns}
        rows={rows}
        loading={isLoading}
        rowKey={(s) => `${s.peril}|${s.zone}`}
        empty={<EmptyState title="No exposure recorded" message="Add accumulation entries to populate the summary." />}
        skeletonRows={3}
      />
    </Card>
  );
}

function NewAccumulationModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateAccumulation();
  const [peril, setPeril] = useState('EARTHQUAKE');
  const [zone, setZone] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [capacity, setCapacity] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setPeril('EARTHQUAKE'); setZone(''); setCurrency('USD'); setCapacity(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cap = Number(capacity);
    if (!zone.trim()) { setError('Zone is required.'); return; }
    if (!capacity || Number.isNaN(cap) || cap <= 0) { setError('Enter a positive capacity.'); return; }
    try {
      await create.mutateAsync({ peril, zone: zone.trim(), currency, capacity: cap });
      toast.success(`Accumulation created for ${titleCase(peril)} / ${zone.trim()}`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the accumulation.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New accumulation"
      description="Declare capacity for a peril and zone. Entries accumulate net exposure against it."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!zone.trim() || !capacity}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className={shared.grid2} style={{ display: 'grid' }}>
        <FormField label="Peril" required>
          <Select value={peril} onChange={(e) => setPeril(e.target.value)}>
            {PERILS.map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}
          </Select>
        </FormField>
        <FormField label="Zone" required>
          <Input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="e.g. CA-SoCal" required />
        </FormField>
        <FormField label="Currency" required>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </FormField>
        <FormField label="Capacity" required hint={`Major units of ${currency}.`}>
          <Input type="number" min="0" step="any" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="e.g. 50000000" required />
        </FormField>
        {error && <p style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

function AddEntryModal({ accumulation, onClose }: { accumulation: Accumulation | null; onClose: () => void }) {
  const toast = useToast();
  const detail = useAccumulation(accumulation?.id);
  const add = useAddEntry(accumulation?.id);

  const [riskId, setRiskId] = useState('');
  const [contractId, setContractId] = useState('');
  const [gross, setGross] = useState('');
  const [net, setNet] = useState('');
  const [error, setError] = useState<string | null>(null);

  const currency = accumulation?.currency ?? 'USD';

  const reset = () => { setRiskId(''); setContractId(''); setGross(''); setNet(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const g = Number(gross);
    const n = Number(net);
    if (!gross || Number.isNaN(g) || g <= 0) { setError('Enter a positive gross exposure.'); return; }
    if (!net || Number.isNaN(n) || n < 0) { setError('Enter a valid net exposure.'); return; }
    try {
      await add.mutateAsync({
        riskId: riskId.trim() || undefined,
        contractId: contractId.trim() || undefined,
        grossExposure: g,
        netExposure: n,
        currency,
      });
      toast.success('Entry added');
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the entry.');
    }
  };

  const entries = detail.data?.entries ?? [];

  return (
    <Modal
      open={!!accumulation}
      onClose={close}
      title={accumulation ? `Add entry - ${titleCase(accumulation.peril)} / ${accumulation.zone}` : 'Add entry'}
      description="Record gross and net exposure (major units). Net drives utilisation against capacity."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={!gross || !net}>
            Add entry
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className={shared.grid2} style={{ display: 'grid', marginBottom: 'var(--space-5)' }}>
        <FormField label="Risk ID" hint="Optional">
          <Input value={riskId} onChange={(e) => setRiskId(e.target.value)} placeholder="e.g. RSK-001" />
        </FormField>
        <FormField label="Contract ID" hint="Optional">
          <Input value={contractId} onChange={(e) => setContractId(e.target.value)} placeholder="e.g. contract id" />
        </FormField>
        <FormField label="Gross exposure" required hint={`Major units of ${currency}.`}>
          <Input type="number" min="0" step="any" value={gross} onChange={(e) => setGross(e.target.value)} required />
        </FormField>
        <FormField label="Net exposure" required hint={`Major units of ${currency}.`}>
          <Input type="number" min="0" step="any" value={net} onChange={(e) => setNet(e.target.value)} required />
        </FormField>
        {error && <p style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>

      {detail.isLoading ? (
        <PageLoader label="Loading entries…" />
      ) : entries.length ? (
        <Table
          columns={[
            { key: 'risk', header: 'Risk', render: (en: AccumulationEntry) => en.risk_id ?? '-' },
            { key: 'contract', header: 'Contract', render: (en: AccumulationEntry) => en.contract_id ?? '-' },
            { key: 'gross', header: 'Gross', align: 'right', render: (en: AccumulationEntry) => <span className={shared.money}>{formatMoney(en.gross_exposure_minor, en.currency || currency)}</span> },
            { key: 'net', header: 'Net', align: 'right', render: (en: AccumulationEntry) => <span className={shared.money}>{formatMoney(en.net_exposure_minor, en.currency || currency)}</span> },
          ]}
          rows={entries}
          rowKey={(en) => en.id}
          empty={<EmptyState title="No entries" />}
          skeletonRows={2}
        />
      ) : (
        <EmptyState title="No entries yet" message="This accumulation has no exposure entries." />
      )}
    </Modal>
  );
}
