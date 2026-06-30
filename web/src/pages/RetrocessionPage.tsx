import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useStatusColors, useCurrencies } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Select, TextField } from '../components/Form';
import { KpiCard } from '../components/KpiCard';
import { formatMoney, formatMoneyCompact, titleCase } from '../lib/format';
import shared from './shared.module.css';

interface RetroItem {
  id: string;
  reference: string;
  name: string;
  contractKind: string;
  basis: string;
  npType?: string | null;
  lineOfBusiness: string | null;
  currency: string;
  status: string;
  retrocessionaireName?: string | null;
}
interface RetroListResponse { treaties: RetroItem[] }

interface NetPosition { currency: string; grossMinor: number; cededMinor: number; netMinor: number }
interface NetPositionResponse { positions: NetPosition[] }

function useRetrocession() {
  return useQuery({
    queryKey: ['retrocession'],
    queryFn: () => api<RetroListResponse>('/api/retrocession'),
  });
}

function useNetPosition() {
  return useQuery({
    queryKey: ['retrocession', 'net-position'],
    queryFn: () => api<NetPositionResponse>('/api/retrocession/net-position'),
  });
}

function useCreateRetrocession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string; reference: string }>('/api/retrocession', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['retrocession'] });
    },
  });
}

export function RetrocessionPage() {
  const { hasPermission } = useAuth();
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useRetrocession();
  const { data: net, isLoading: netLoading } = useNetPosition();
  const statusColors = useStatusColors('contract_status');

  const positions = net?.positions ?? [];

  const columns: Column<RetroItem>[] = useMemo(() => [
    { key: 'reference', header: 'Reference', sortValue: (r) => r.reference ?? '', render: (r) => <span className={shared.cellRef}>{r.reference}</span> },
    {
      key: 'name',
      header: 'Retrocession',
      sortValue: (r) => r.name,
      render: (r) => (
        <div>
          <div className={shared.cellMain}>{r.name}</div>
          <div className={shared.cellSub}>{r.retrocessionaireName ?? 'Retrocessionaire t.b.c.'}</div>
        </div>
      ),
    },
    {
      key: 'basis',
      header: 'Basis',
      sortValue: (r) => r.basis,
      render: (r) => <span>{titleCase(r.basis)}{r.npType ? ` · ${r.npType}` : ''}</span>,
    },
    { key: 'lineOfBusiness', header: 'LOB', sortValue: (r) => r.lineOfBusiness ?? '', render: (r) => titleCase(r.lineOfBusiness) || '—' },
    { key: 'currency', header: 'CCY', sortValue: (r) => r.currency, render: (r) => r.currency },
    { key: 'status', header: 'Status', align: 'right', sortValue: (r) => r.status, render: (r) => <StatusPill status={r.status} metaColors={statusColors} /> },
  ], [statusColors]);

  const netColumns: Column<NetPosition>[] = [
    { key: 'currency', header: 'CCY', sortValue: (p) => p.currency, render: (p) => <span className={shared.cellRef}>{p.currency}</span> },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (p) => p.grossMinor, render: (p) => <span className={shared.money}>{formatMoney(p.grossMinor, p.currency)}</span> },
    { key: 'ceded', header: 'Ceded', align: 'right', sortValue: (p) => p.cededMinor, render: (p) => <span className={shared.money}>{formatMoney(p.cededMinor, p.currency)}</span> },
    { key: 'net', header: 'Net retained', align: 'right', sortValue: (p) => p.netMinor, render: (p) => <span className={shared.money}>{formatMoney(p.netMinor, p.currency)}</span> },
  ];

  const headline = positions[0];

  return (
    <>
      <PageHeader
        title="Retrocession"
        description="Outwards retrocession protections and the resulting gross / ceded / net position."
        actions={
          hasPermission('retro:write') ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New retrocession</Button>
          ) : null
        }
      />

      <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
        <KpiCard label="Gross liability" value={headline ? formatMoneyCompact(headline.grossMinor, headline.currency) : '—'} hint={headline ? headline.currency : 'No positions'} loading={netLoading} />
        <KpiCard label="Ceded out" value={headline ? formatMoneyCompact(headline.cededMinor, headline.currency) : '—'} hint={headline ? headline.currency : 'No positions'} loading={netLoading} />
        <KpiCard label="Net retained" value={headline ? formatMoneyCompact(headline.netMinor, headline.currency) : '—'} hint={headline ? headline.currency : 'No positions'} loading={netLoading} />
      </div>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader title="Net position by currency" subtitle="Gross liability, ceded out under retrocession, and net retained." />
        </div>
        <Table
          columns={netColumns}
          rows={net?.positions}
          loading={netLoading}
          rowKey={(p) => p.currency}
          empty={<EmptyState title="No net position" message="Bind retrocession protections to see the gross / ceded / net split." icon="$" />}
          skeletonRows={3}
        />
      </Card>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader title="Outwards retrocession contracts" subtitle={`${data?.treaties.length ?? 0} contract${(data?.treaties.length ?? 0) === 1 ? '' : 's'}`} />
        </div>
        <Table
          columns={columns}
          rows={data?.treaties}
          loading={isLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No retrocession contracts" message="Create a new retrocession to protect your net account." icon="▤" />}
        />
      </Card>

      <NewRetrocessionModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewRetrocessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateRetrocession();
  const { data: ccy } = useCurrencies();

  const [name, setName] = useState('');
  const [basis, setBasis] = useState('NON_PROPORTIONAL');
  const [npType, setNpType] = useState('XL');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const currencies = ccy?.currencies ?? [];
  const isNonProp = basis === 'NON_PROPORTIONAL';

  const reset = () => { setName(''); setBasis('NON_PROPORTIONAL'); setNpType('XL'); setCurrency('USD'); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Enter a retrocession name.'); return; }
    const body: Record<string, unknown> = { name: name.trim(), basis, currency };
    if (isNonProp) body.npType = npType;
    try {
      const res = await create.mutateAsync(body);
      toast.success(`Retrocession ${res.reference} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the retrocession.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New retrocession"
      description="Create a draft outwards retrocession protection."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>Create retrocession</Button>
        </>
      }
    >
      <form onSubmit={submit} className={shared.grid2} style={{ display: 'grid' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Retrocession name" value={name} onChange={setName} required placeholder="e.g. Whole Account Retro XL 2026" />
        </div>
        <FormField label="Basis" required>
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="NON_PROPORTIONAL">Non-proportional</option>
            <option value="PROPORTIONAL">Proportional</option>
          </Select>
        </FormField>
        {isNonProp && (
          <FormField label="NP type">
            <Select value={npType} onChange={(e) => setNpType(e.target.value)}>
              <option value="XL">Excess of loss</option>
              <option value="STOP_LOSS">Stop loss</option>
              <option value="CATXL">Cat XL</option>
            </Select>
          </FormField>
        )}
        <FormField label="Currency" required>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </FormField>
        {error && <p style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
