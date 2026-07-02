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

// The outward programme structure the slip captures. QS/Surplus are proportional;
// XL is non-proportional. The engine's allocation methods mirror these.
const STRUCTURES = [
  { code: 'QUOTA_SHARE', label: 'Quota share' },
  { code: 'SURPLUS', label: 'Surplus' },
  { code: 'XL', label: 'Excess of loss (XL)' },
];

const num = (v: string) => (v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

function NewRetrocessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateRetrocession();
  const { data: ccy } = useCurrencies();
  const { data: partyData } = useParties({});

  // Identification
  const [name, setName] = useState('');
  const [structure, setStructure] = useState('QUOTA_SHARE');
  const [npType, setNpType] = useState('PER_RISK_XL');
  const [currency, setCurrency] = useState('USD');
  // Period
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  // Structure terms
  const [cessionPct, setCessionPct] = useState('');       // QS
  const [retention, setRetention] = useState('');          // Surplus (major units)
  const [maxLines, setMaxLines] = useState('');            // Surplus (lines)
  const [attachment, setAttachment] = useState('');        // XL (major units)
  const [limit, setLimit] = useState('');                  // XL (major units)
  // Premium & commission
  const [premium, setPremium] = useState('');
  const [commissionPct, setCommissionPct] = useState('');
  // Parties
  const [cedentPartyId, setCedentPartyId] = useState('');
  const [retrocessionairePartyId, setRetrocessionairePartyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const currencies = ccy?.currencies ?? [];
  const parties = partyData?.parties ?? [];
  const isXl = structure === 'XL';
  const isSurplus = structure === 'SURPLUS';
  const isQs = structure === 'QUOTA_SHARE';
  const partyName = (p: { shortName?: string | null; legalName: string }) => p.shortName || p.legalName;

  const reset = () => {
    setName(''); setStructure('QUOTA_SHARE'); setNpType('PER_RISK_XL'); setCurrency('USD');
    setPeriodStart(''); setPeriodEnd('');
    setCessionPct(''); setRetention(''); setMaxLines(''); setAttachment(''); setLimit('');
    setPremium(''); setCommissionPct('');
    setCedentPartyId(''); setRetrocessionairePartyId(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Enter a retrocession name.'); return; }

    // Structure → basis + proportionalType/npType (mirrors the treaty slip).
    const basis = isXl ? 'NON_PROPORTIONAL' : 'PROPORTIONAL';

    // Typed slip terms (major units / percentages) → the contract's term bag.
    const terms: Record<string, unknown> = {};
    if (isQs && num(cessionPct) !== undefined) terms.cessionPct = num(cessionPct);
    if (isSurplus) {
      if (num(retention) !== undefined) terms.retentionLines = num(retention);
      if (num(maxLines) !== undefined) terms.maxLines = num(maxLines);
    }
    if (isXl) {
      if (num(attachment) !== undefined) terms.attachment = num(attachment);
      if (num(limit) !== undefined) terms.limit = num(limit);
    }
    if (num(premium) !== undefined) terms.premium = num(premium);
    if (num(commissionPct) !== undefined) terms.commissionPct = num(commissionPct);

    const body: Record<string, unknown> = { name: name.trim(), basis, currency };
    if (isXl) body.npType = npType;
    else body.proportionalType = structure;
    if (periodStart) body.periodStart = periodStart;
    if (periodEnd) body.periodEnd = periodEnd;
    if (Object.keys(terms).length) body.terms = terms;
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
      description="Capture the outward slip: identification, period, structure, premium & commission, and the retrocedent / retrocessionaire parties."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>Create retrocession</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Retrocession name" value={name} onChange={setName} required placeholder="e.g. Whole Account Retro XL 2026" />
          </div>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Period">
          <TextField label="Inception date" type="date" value={periodStart} onChange={setPeriodStart} />
          <TextField label="Expiry date" type="date" value={periodEnd} onChange={setPeriodEnd} />
        </FormSection>

        <FormSection title="Structure" description="The cession method the outward programme applies; it drives the allocation engine.">
          <FormField label="Structure" required>
            <Select value={structure} onChange={(e) => setStructure(e.target.value)}>
              {STRUCTURES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </Select>
          </FormField>
          {isXl && (
            <FormField label="Excess-of-loss type">
              <Select value={npType} onChange={(e) => setNpType(e.target.value)}>
                {NP_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </Select>
            </FormField>
          )}
          {isQs && (
            <TextField label="Cession %" type="number" value={cessionPct} onChange={setCessionPct} placeholder="e.g. 30" hint="Ceded share of each event" />
          )}
          {isSurplus && (
            <>
              <TextField label="Retention (line, major units)" type="number" value={retention} onChange={setRetention} placeholder="e.g. 10000" hint="Retained line above which the surplus cedes" />
              <TextField label="Max cession (lines)" type="number" value={maxLines} onChange={setMaxLines} placeholder="e.g. 9" hint="Number of surplus lines of capacity" />
            </>
          )}
          {isXl && (
            <>
              <TextField label="Attachment / retention (major units)" type="number" value={attachment} onChange={setAttachment} placeholder="e.g. 10000" hint="Losses below this are retained" />
              <TextField label="Limit / cover (major units)" type="number" value={limit} onChange={setLimit} placeholder="e.g. 40000" hint="Layer limit above attachment" />
            </>
          )}
        </FormSection>

        <FormSection title="Premium & commission">
          <TextField label={`Premium (major units of ${currency})`} type="number" value={premium} onChange={setPremium} placeholder="e.g. 12000" />
          <TextField label="Commission %" type="number" value={commissionPct} onChange={setCommissionPct} placeholder="e.g. 15" />
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
