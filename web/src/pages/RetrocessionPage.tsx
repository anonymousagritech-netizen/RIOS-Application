import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, ArrowLeftRight, ShieldHalf, Layers, Undo2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useStatusColors, useCurrencies, useParties } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Select, TextField } from '../components/Form';
import { KpiCard } from '../components/KpiCard';
import { formatMoney, formatMoneyCompact, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './RetrocessionPage.module.css';

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
interface RetroListResponse { retrocession: RetroItem[] }

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
    { key: 'lineOfBusiness', header: 'LOB', sortValue: (r) => r.lineOfBusiness ?? '', render: (r) => titleCase(r.lineOfBusiness) || '-' },
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
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Retrocession' }]}
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Link to="/recoveries"><Button variant="secondary" icon={<Undo2 size={16} />}>Recoveries</Button></Link>
            {hasPermission('retro:write') ? (
              <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New retrocession</Button>
            ) : null}
          </div>
        }
      />

      <div className={styles.kpiRow}>
        <KpiCard label="Gross liability" value={headline ? formatMoneyCompact(headline.grossMinor, headline.currency) : '-'} hint={headline ? headline.currency : 'No positions'} icon={<Layers size={20} />} accent="var(--primary)" loading={netLoading} />
        <KpiCard label="Ceded out" value={headline ? formatMoneyCompact(headline.cededMinor, headline.currency) : '-'} hint={headline ? headline.currency : 'No positions'} icon={<ArrowLeftRight size={20} />} accent="var(--accent-violet)" loading={netLoading} />
        <KpiCard label="Net retained" value={headline ? formatMoneyCompact(headline.netMinor, headline.currency) : '-'} hint={headline ? headline.currency : 'No positions'} icon={<ShieldHalf size={20} />} accent="var(--accent-emerald)" loading={netLoading} />
      </div>

      <Card padded={false}>
        <div className={styles.cardPad}>
          <CardHeader title="Net position by currency" subtitle="Gross liability, ceded out under retrocession, and net retained." />
        </div>
        <Table
          columns={netColumns}
          rows={net?.positions}
          loading={netLoading}
          rowKey={(p) => p.currency}
          empty={<EmptyState title="No net position" message="Bind retrocession protections to see the gross / ceded / net split." icon={<DollarSign size={16} />} />}
          skeletonRows={3}
        />
      </Card>

      <Card padded={false}>
        <div className={styles.cardPad}>
          <CardHeader title="Outwards retrocession contracts" subtitle={`${data?.retrocession?.length ?? 0} contract${(data?.retrocession?.length ?? 0) === 1 ? '' : 's'}`} />
        </div>
        <Table
          columns={columns}
          rows={data?.retrocession}
          loading={isLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No retrocession contracts" message="Create a new retrocession to protect your net account." icon={<ArrowLeftRight size={16} />} />}
        />
      </Card>

      <NewRetrocessionModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

// XL codes match the server's npType enum (PER_RISK_XL / CAT_XL / AGG_XL / STOP_LOSS).
const NP_TYPES = [
  { code: 'PER_RISK_XL', label: 'Per-risk excess of loss (Risk XL)' },
  { code: 'CAT_XL', label: 'Catastrophe excess of loss (Cat XL)' },
  { code: 'AGG_XL', label: 'Aggregate excess of loss' },
  { code: 'STOP_LOSS', label: 'Stop loss' },
];

function NewRetrocessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateRetrocession();
  const { data: ccy } = useCurrencies();
  const { data: partyData } = useParties({});

  // Identification
  const [name, setName] = useState('');
  const [basis, setBasis] = useState('NON_PROPORTIONAL');
  const [npType, setNpType] = useState('PER_RISK_XL');
  const [currency, setCurrency] = useState('USD');
  // Parties
  const [cedentPartyId, setCedentPartyId] = useState('');
  const [retrocessionairePartyId, setRetrocessionairePartyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const currencies = ccy?.currencies ?? [];
  const parties = partyData?.parties ?? [];
  const isNonProp = basis === 'NON_PROPORTIONAL';
  const partyName = (p: { shortName?: string | null; legalName: string }) => p.shortName || p.legalName;

  const reset = () => {
    setName(''); setBasis('NON_PROPORTIONAL'); setNpType('PER_RISK_XL'); setCurrency('USD');
    setCedentPartyId(''); setRetrocessionairePartyId(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Enter a retrocession name.'); return; }
    const body: Record<string, unknown> = { name: name.trim(), basis, currency };
    if (isNonProp) body.npType = npType;
    if (cedentPartyId) body.cedentPartyId = cedentPartyId;
    if (retrocessionairePartyId) body.retrocessionairePartyId = retrocessionairePartyId;
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
      size="lg"
      title="New retrocession"
      description="Create a draft outwards retrocession protection: identification, structure and the retrocedent / retrocessionaire parties."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>Create retrocession</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification & structure">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Retrocession name" value={name} onChange={setName} required placeholder="e.g. Whole Account Retro XL 2026" />
          </div>
          <FormField label="Basis" required>
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="NON_PROPORTIONAL">Non-proportional (excess of loss)</option>
              <option value="PROPORTIONAL">Proportional</option>
            </Select>
          </FormField>
          {isNonProp && (
            <FormField label="Excess-of-loss type">
              <Select value={npType} onChange={(e) => setNpType(e.target.value)}>
                {NP_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
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
        </FormSection>

        <FormSection title="Parties" description="The retrocedent ceding the outwards line and the retrocessionaire taking it.">
          <FormField label="Retrocedent / cedent">
            <Select value={cedentPartyId} onChange={(e) => setCedentPartyId(e.target.value)}>
              <option value="">Select a party…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
            </Select>
          </FormField>
          <FormField label="Retrocessionaire">
            <Select value={retrocessionairePartyId} onChange={(e) => setRetrocessionairePartyId(e.target.value)}>
              <option value="">Select a party…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
            </Select>
          </FormField>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
