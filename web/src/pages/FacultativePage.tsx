import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useStatusColors, useCurrencies } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { formatPercent, titleCase } from '../lib/format';
import { FileCheck2 } from 'lucide-react';
import shared from './shared.module.css';

interface FacultativeItem {
  id: string;
  reference: string;
  name: string;
  contractKind: string;
  basis: string;
  lineOfBusiness: string | null;
  currency: string;
  status: string;
  cededShare?: number | null;
  insuredName?: string | null;
  cedentName?: string | null;
}
interface FacultativeListResponse { treaties: FacultativeItem[] }

const STATUSES = ['DRAFT', 'QUOTED', 'PLACING', 'BOUND', 'ACTIVE', 'EXPIRING', 'RUNOFF', 'COMMUTED', 'CANCELLED'];

function useFacultative(params: { status?: string }) {
  return useQuery({
    queryKey: ['facultative', params],
    queryFn: () => api<FacultativeListResponse>(`/api/facultative${qs(params)}`),
  });
}

function useCreateFacultative() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string; reference: string }>('/api/facultative', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['facultative'] }),
  });
}

export function FacultativePage() {
  const { hasPermission } = useAuth();
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useFacultative({ status: status || undefined });
  const statusColors = useStatusColors('contract_status');

  const columns: Column<FacultativeItem>[] = useMemo(() => [
    { key: 'reference', header: 'Reference', sortValue: (r) => r.reference ?? '', render: (r) => <span className={shared.cellRef}>{r.reference}</span> },
    {
      key: 'name',
      header: 'Cession',
      sortValue: (r) => r.name,
      render: (r) => (
        <div>
          <div className={shared.cellMain}>{r.name}</div>
          <div className={shared.cellSub}>{r.insuredName ?? r.cedentName ?? 'Insured t.b.c.'}</div>
        </div>
      ),
    },
    { key: 'basis', header: 'Basis', sortValue: (r) => r.basis, render: (r) => titleCase(r.basis) },
    { key: 'lineOfBusiness', header: 'LOB', sortValue: (r) => r.lineOfBusiness ?? '', render: (r) => titleCase(r.lineOfBusiness) || '-' },
    { key: 'currency', header: 'CCY', sortValue: (r) => r.currency, render: (r) => r.currency },
    { key: 'cededShare', header: 'Ceded', align: 'right', sortValue: (r) => r.cededShare ?? 0, render: (r) => (r.cededShare != null ? formatPercent(r.cededShare) : '-') },
    { key: 'status', header: 'Status', align: 'right', sortValue: (r) => r.status, render: (r) => <StatusPill status={r.status} metaColors={statusColors} /> },
  ], [statusColors]);

  return (
    <>
      <PageHeader
        title="Facultative"
        description="Single-risk facultative cessions placed outside of treaty arrangements."
        actions={
          hasPermission('facultative:write') ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New cession</Button>
          ) : null
        }
      />

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Status</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
          <span className={shared.cellSub}>{data?.treaties.length ?? 0} result{(data?.treaties.length ?? 0) === 1 ? '' : 's'}</span>
        </div>

        <Table
          columns={columns}
          rows={data?.treaties}
          loading={isLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No facultative cessions" message="Create a new cession to place a single risk facultatively." icon={<FileCheck2 size={16} />} />}
        />
      </Card>

      <NewCessionModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewCessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateFacultative();
  const { data: ccy } = useCurrencies();

  const [name, setName] = useState('');
  const [basis, setBasis] = useState('PROPORTIONAL');
  const [currency, setCurrency] = useState('USD');
  const [insuredName, setInsuredName] = useState('');
  const [sumInsured, setSumInsured] = useState('');
  const [premium, setPremium] = useState('');
  const [cededShare, setCededShare] = useState('');
  const [error, setError] = useState<string | null>(null);

  const currencies = ccy?.currencies ?? [];

  const reset = () => {
    setName(''); setBasis('PROPORTIONAL'); setCurrency('USD'); setInsuredName('');
    setSumInsured(''); setPremium(''); setCededShare(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Enter a cession name.'); return; }
    const body: Record<string, unknown> = { name: name.trim(), basis, currency };
    if (insuredName.trim()) body.insuredName = insuredName.trim();
    const si = Number(sumInsured);
    if (sumInsured && !Number.isNaN(si)) body.sumInsured = si;
    const prem = Number(premium);
    if (premium && !Number.isNaN(prem)) body.premium = prem;
    const share = Number(cededShare);
    if (cededShare && !Number.isNaN(share)) body.cededShare = share;
    try {
      const res = await create.mutateAsync(body);
      toast.success(`Cession ${res.reference} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the cession.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New cession"
      description="Create a facultative cession. Amounts are entered in major currency units; ceded share is a fraction (e.g. 0.4)."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>Create cession</Button>
        </>
      }
    >
      <form onSubmit={submit} className={shared.grid2} style={{ display: 'grid' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Cession name" value={name} onChange={setName} required placeholder="e.g. Acme Refinery Property Fac 2026" />
        </div>
        <FormField label="Basis" required>
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="PROPORTIONAL">Proportional</option>
            <option value="NON_PROPORTIONAL">Non-proportional</option>
          </Select>
        </FormField>
        <FormField label="Currency" required>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </FormField>
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Insured name" value={insuredName} onChange={setInsuredName} placeholder="e.g. Acme Industrial Ltd" />
        </div>
        <FormField label="Sum insured (major units)" hint={`In ${currency}`}>
          <Input type="number" min="0" step="any" value={sumInsured} onChange={(e) => setSumInsured(e.target.value)} placeholder="e.g. 50000000" />
        </FormField>
        <FormField label="Premium (major units)" hint={`In ${currency}`}>
          <Input type="number" min="0" step="any" value={premium} onChange={(e) => setPremium(e.target.value)} placeholder="e.g. 250000" />
        </FormField>
        <div style={{ gridColumn: '1 / -1' }}>
          <FormField label="Ceded share" hint="Fraction between 0 and 1 (e.g. 0.4 = 40%)">
            <Input type="number" min="0" max="1" step="any" value={cededShare} onChange={(e) => setCededShare(e.target.value)} placeholder="e.g. 0.4" />
          </FormField>
        </div>
        {error && <p style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
