import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTreaties, useCreateTreaty, useCodeLists, useCurrencies, useStatusColors, useParties } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { formatDate, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { TreatyListItem } from '../lib/types';
import { Plus, FileText, Layers, CheckCircle2, Activity, FileSignature } from 'lucide-react';
import shared from './shared.module.css';
import styles from './TreatiesPage.module.css';

const STATUSES = ['DRAFT', 'QUOTED', 'PLACING', 'BOUND', 'ACTIVE', 'EXPIRING', 'RUNOFF', 'COMMUTED', 'CANCELLED'];
const KINDS = ['TREATY', 'FACULTATIVE'];

export function TreatiesPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useTreaties({ status: status || undefined, kind: kind || undefined });
  const statusColors = useStatusColors('contract_status');

  const rows = data?.treaties ?? [];
  const kpis = useMemo(() => {
    const isOneOf = (s: string, set: string[]) => set.includes((s ?? '').toUpperCase());
    return {
      total: rows.length,
      bound: rows.filter((t) => isOneOf(t.status, ['BOUND', 'ACTIVE'])).length,
      inFlight: rows.filter((t) => isOneOf(t.status, ['DRAFT', 'QUOTED', 'PLACING'])).length,
      runoff: rows.filter((t) => isOneOf(t.status, ['EXPIRING', 'RUNOFF', 'COMMUTED', 'CANCELLED'])).length,
    };
  }, [rows]);

  const columns: Column<TreatyListItem>[] = useMemo(() => [
    {
      key: 'reference',
      header: 'Reference',
      sortValue: (r) => r.reference ?? '',
      render: (r) => <span className={shared.cellRef}>{r.reference}</span>,
    },
    {
      key: 'name',
      header: 'Treaty',
      sortValue: (r) => r.name,
      render: (r) => (
        <div>
          <div className={shared.cellMain}>{r.name}</div>
          <div className={shared.cellSub}>{r.cedentName ?? 'Cedent t.b.c.'}</div>
        </div>
      ),
    },
    {
      key: 'basis',
      header: 'Basis',
      sortValue: (r) => r.basis,
      render: (r) => (
        <span>
          {titleCase(r.basis)}
          {r.npType ? ` · ${r.npType}` : ''}
          {r.proportionalType ? ` · ${titleCase(r.proportionalType)}` : ''}
        </span>
      ),
    },
    { key: 'lineOfBusiness', header: 'LOB', sortValue: (r) => r.lineOfBusiness ?? '', render: (r) => titleCase(r.lineOfBusiness) || '-' },
    { key: 'currency', header: 'CCY', sortValue: (r) => r.currency, render: (r) => r.currency },
    { key: 'period', header: 'Inception', sortValue: (r) => r.periodStart ?? '', render: (r) => formatDate(r.periodStart) },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      sortValue: (r) => r.status,
      render: (r) => <StatusPill status={r.status} metaColors={statusColors} />,
    },
  ], [statusColors]);

  return (
    <>
      <PageHeader
        title="Treaties"
        description="Inwards and outwards reinsurance contracts across the portfolio."
        actions={
          hasPermission('treaty:write') ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<Plus size={16} />}>
              New treaty
            </Button>
          ) : null
        }
      />

      <div className={styles.kpiRow}>
        <KpiCard label="Total treaties" value={kpis.total} icon={<Layers size={18} />} accent="var(--primary)" loading={isLoading} hint="Across the portfolio" />
        <KpiCard label="Bound & active" value={kpis.bound} icon={<CheckCircle2 size={18} />} accent="var(--accent-emerald)" loading={isLoading} hint="On risk" />
        <KpiCard label="In placement" value={kpis.inFlight} icon={<FileSignature size={18} />} accent="var(--accent-violet)" loading={isLoading} hint="Draft, quoted or placing" />
        <KpiCard label="Run-off & closed" value={kpis.runoff} icon={<Activity size={18} />} accent="var(--accent-orange)" loading={isLoading} hint="Expiring or settled" />
      </div>

      <Card padded={false} className={styles.tableCard}>
        <div className={styles.toolbar}>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Status</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Kind</span>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
              <option value="">All</option>
              {KINDS.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
          <span className={styles.resultCount}>{rows.length} result{rows.length === 1 ? '' : 's'}</span>
        </div>

        <Table
          columns={columns}
          rows={data?.treaties}
          loading={isLoading}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/treaties/${r.id}`)}
          empty={
            <EmptyState
              title="No treaties match"
              message="Adjust the filters or create a new treaty to get started."
              icon={<FileText size={16} />}
            />
          }
        />
      </Card>

      <NewTreatyModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

// Every reinsurance structure the form can create, grouped by basis. The XL
// codes match the server's npType enum (PER_RISK_XL / CAT_XL / AGG_XL / STOP_LOSS).
const PROPORTIONAL_TYPES = [
  { code: 'QUOTA_SHARE', label: 'Quota share' },
  { code: 'SURPLUS', label: 'Surplus' },
];
const NP_TYPES = [
  { code: 'PER_RISK_XL', label: 'Per-risk excess of loss (Risk XL)' },
  { code: 'CAT_XL', label: 'Catastrophe excess of loss (Cat XL)' },
  { code: 'AGG_XL', label: 'Aggregate excess of loss' },
  { code: 'STOP_LOSS', label: 'Stop loss' },
];

const num = (v: string) => (v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

function NewTreatyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateTreaty();
  const { data: codeLists } = useCodeLists();
  const { data: ccy } = useCurrencies();
  const { data: partyData } = useParties({});

  // Identification
  const [name, setName] = useState('');
  const [contractKind, setContractKind] = useState('TREATY');
  const [direction, setDirection] = useState('INWARDS');
  const [lineOfBusiness, setLineOfBusiness] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [uwYear, setUwYear] = useState(String(new Date().getFullYear()));
  // Parties
  const [cedentPartyId, setCedentPartyId] = useState('');
  const [brokerPartyId, setBrokerPartyId] = useState('');
  // Period & territory
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [territory, setTerritory] = useState('');
  // Structure
  const [basis, setBasis] = useState('PROPORTIONAL');
  const [proportionalType, setProportionalType] = useState('QUOTA_SHARE');
  const [npType, setNpType] = useState('PER_RISK_XL');
  // Proportional terms
  const [cessionPct, setCessionPct] = useState('');
  const [maxCession, setMaxCession] = useState('');
  const [retentionLines, setRetentionLines] = useState('');
  // Non-proportional terms
  const [attachment, setAttachment] = useState('');
  const [limit, setLimit] = useState('');
  const [layers, setLayers] = useState('1');
  const [aggDeductible, setAggDeductible] = useState('');
  const [reinstatements, setReinstatements] = useState('');
  const [rateOnLine, setRateOnLine] = useState('');
  // Commission & brokerage
  const [cedingCommissionPct, setCedingCommissionPct] = useState('');
  const [profitCommissionPct, setProfitCommissionPct] = useState('');
  const [overridePct, setOverridePct] = useState('');
  const [brokeragePct, setBrokeragePct] = useState('');
  // Premium
  const [epi, setEpi] = useState('');
  const [mdp, setMdp] = useState('');
  const [deposit, setDeposit] = useState('');
  const [error, setError] = useState<string | null>(null);

  const lobOptions = codeLists?.lists?.line_of_business ?? [];
  const currencies = ccy?.currencies ?? [];
  const parties = partyData?.parties ?? [];
  const isProportional = basis === 'PROPORTIONAL';
  const isSurplus = isProportional && proportionalType === 'SURPLUS';
  const isAggregate = !isProportional && (npType === 'AGG_XL' || npType === 'STOP_LOSS');

  const reset = () => {
    setName(''); setContractKind('TREATY'); setDirection('INWARDS'); setLineOfBusiness('');
    setCurrency('USD'); setUwYear(String(new Date().getFullYear())); setCedentPartyId(''); setBrokerPartyId('');
    setPeriodStart(''); setPeriodEnd(''); setTerritory('');
    setBasis('PROPORTIONAL'); setProportionalType('QUOTA_SHARE'); setNpType('PER_RISK_XL');
    setCessionPct(''); setMaxCession(''); setRetentionLines('');
    setAttachment(''); setLimit(''); setLayers('1'); setAggDeductible(''); setReinstatements(''); setRateOnLine('');
    setCedingCommissionPct(''); setProfitCommissionPct(''); setOverridePct(''); setBrokeragePct('');
    setEpi(''); setMdp(''); setDeposit(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Structural fields → columns; commercial terms → the contract's term set.
    const terms: Record<string, unknown> = { currency };
    if (num(uwYear) !== undefined) terms.underwritingYear = num(uwYear);
    if (territory.trim()) terms.territory = territory.trim();
    if (isProportional) {
      if (num(cessionPct) !== undefined) terms.cessionPct = num(cessionPct);
      if (isSurplus) {
        if (num(retentionLines) !== undefined) terms.retentionLines = num(retentionLines);
        if (num(maxCession) !== undefined) terms.maxCession = num(maxCession);
      }
      if (num(cedingCommissionPct) !== undefined) terms.cedingCommissionPct = num(cedingCommissionPct);
      if (num(profitCommissionPct) !== undefined) terms.profitCommissionPct = num(profitCommissionPct);
      if (num(overridePct) !== undefined) terms.overridePct = num(overridePct);
    } else {
      if (num(attachment) !== undefined) terms.attachment = num(attachment);
      if (num(limit) !== undefined) terms.limit = num(limit);
      if (num(layers) !== undefined) terms.layers = num(layers);
      if (isAggregate && num(aggDeductible) !== undefined) terms.aggregateDeductible = num(aggDeductible);
      if (reinstatements.trim()) terms.reinstatements = reinstatements.trim();
      if (num(rateOnLine) !== undefined) terms.rateOnLine = num(rateOnLine);
    }
    if (num(brokeragePct) !== undefined) terms.brokeragePct = num(brokeragePct);
    if (num(epi) !== undefined) terms.estimatedPremiumIncome = num(epi);
    if (num(mdp) !== undefined) terms.minimumAndDepositPremium = num(mdp);
    if (num(deposit) !== undefined) terms.depositPremium = num(deposit);

    const body: Record<string, unknown> = {
      name,
      contractKind,
      basis,
      direction,
      currency,
      lineOfBusiness: lineOfBusiness || undefined,
      cedentPartyId: cedentPartyId || undefined,
      brokerPartyId: brokerPartyId || undefined,
      periodStart: periodStart || undefined,
      periodEnd: periodEnd || undefined,
      terms,
    };
    if (isProportional) body.proportionalType = proportionalType;
    else body.npType = npType;

    try {
      const res = await create.mutateAsync(body);
      toast.success(`Treaty ${res.reference} created`);
      reset();
      onClose();
      navigate(`/treaties/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the treaty.');
    }
  };

  const partyName = (p: { shortName: string | null; legalName: string }) => p.shortName || p.legalName;

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="lg"
      title="New treaty"
      description="Capture the full slip: identification, parties, period, structure, commission and premium. You can bind it later."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>
            Create treaty
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Treaty name" value={name} onChange={setName} required placeholder="e.g. North Atlantic Property QS 2026" />
          </div>
          <FormField label="Contract kind" required>
            <Select value={contractKind} onChange={(e) => setContractKind(e.target.value)}>
              <option value="TREATY">Treaty</option>
              <option value="FACULTATIVE">Facultative</option>
              <option value="RETROCESSION">Retrocession</option>
            </Select>
          </FormField>
          <FormField label="Direction" required>
            <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="INWARDS">Inwards (assumed)</option>
              <option value="OUTWARDS">Outwards (ceded)</option>
            </Select>
          </FormField>
          <FormField label="Line of business">
            <Select value={lineOfBusiness} onChange={(e) => setLineOfBusiness(e.target.value)}>
              <option value="">Unspecified</option>
              {lobOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </Select>
          </FormField>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </FormField>
          <TextField label="Underwriting year" type="number" value={uwYear} onChange={setUwYear} placeholder="2026" />
        </FormSection>

        <FormSection title="Parties">
          <FormField label="Cedent / reinsured">
            <Select value={cedentPartyId} onChange={(e) => setCedentPartyId(e.target.value)}>
              <option value="">Select a party…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
            </Select>
          </FormField>
          <FormField label="Broker / intermediary">
            <Select value={brokerPartyId} onChange={(e) => setBrokerPartyId(e.target.value)}>
              <option value="">Direct / none</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Period & territory">
          <TextField label="Inception date" type="date" value={periodStart} onChange={setPeriodStart} />
          <TextField label="Expiry date" type="date" value={periodEnd} onChange={setPeriodEnd} />
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Territory / geographic scope" value={territory} onChange={setTerritory} placeholder="e.g. Worldwide excl. USA & Canada" />
          </div>
        </FormSection>

        <FormSection title="Structure">
          <FormField label="Basis" required>
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="PROPORTIONAL">Proportional</option>
              <option value="NON_PROPORTIONAL">Non-proportional (excess of loss)</option>
            </Select>
          </FormField>
          {isProportional ? (
            <FormField label="Proportional type" required>
              <Select value={proportionalType} onChange={(e) => setProportionalType(e.target.value)}>
                {PROPORTIONAL_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </Select>
            </FormField>
          ) : (
            <FormField label="Excess-of-loss type" required>
              <Select value={npType} onChange={(e) => setNpType(e.target.value)}>
                {NP_TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </Select>
            </FormField>
          )}

          {isProportional ? (
            <>
              <TextField label="Cession %" type="number" value={cessionPct} onChange={setCessionPct} placeholder={proportionalType === 'QUOTA_SHARE' ? 'e.g. 40' : 'e.g. 90'} hint="Ceded share of each risk" />
              {isSurplus && <>
                <TextField label="Retention (line, major units)" type="number" value={retentionLines} onChange={setRetentionLines} placeholder="e.g. 1000000" />
                <TextField label="Max cession (lines)" type="number" value={maxCession} onChange={setMaxCession} placeholder="e.g. 9" hint="Number of surplus lines" />
              </>}
            </>
          ) : (
            <>
              <TextField label="Retention / attachment (major units)" type="number" value={attachment} onChange={setAttachment} placeholder="e.g. 1000000" hint="Cedant's retention per loss" />
              <TextField label="Limit / cover (major units)" type="number" value={limit} onChange={setLimit} placeholder="e.g. 4000000" hint="Layer limit above attachment" />
              <TextField label="Number of layers" type="number" value={layers} onChange={setLayers} placeholder="1" />
              {isAggregate && <TextField label="Aggregate deductible (major units)" type="number" value={aggDeductible} onChange={setAggDeductible} placeholder="e.g. 2000000" />}
              <TextField label="Reinstatements" value={reinstatements} onChange={setReinstatements} placeholder="e.g. 1 at 100%, 1 at 50%" />
              <TextField label="Rate on line %" type="number" value={rateOnLine} onChange={setRateOnLine} placeholder="e.g. 12.5" />
            </>
          )}
        </FormSection>

        <FormSection title="Commission & brokerage" description={isProportional ? undefined : 'Commissions apply to proportional treaties; brokerage applies to all.'}>
          {isProportional && <>
            <TextField label="Ceding commission %" type="number" value={cedingCommissionPct} onChange={setCedingCommissionPct} placeholder="e.g. 27.5" />
            <TextField label="Profit commission %" type="number" value={profitCommissionPct} onChange={setProfitCommissionPct} placeholder="e.g. 20" />
            <TextField label="Overrider %" type="number" value={overridePct} onChange={setOverridePct} placeholder="e.g. 5" />
          </>}
          <TextField label="Brokerage %" type="number" value={brokeragePct} onChange={setBrokeragePct} placeholder="e.g. 10" />
        </FormSection>

        <FormSection title="Premium">
          <TextField label="Estimated premium income (EPI)" type="number" value={epi} onChange={setEpi} placeholder="e.g. 5000000" hint={`Major units of ${currency}`} />
          <TextField label="Minimum & deposit premium (MDP)" type="number" value={mdp} onChange={setMdp} placeholder="e.g. 1200000" />
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Deposit premium (booked on binding)" type="number" value={deposit} onChange={setDeposit} placeholder="e.g. 1500000" hint={`Major units of ${currency}. Booked when the treaty is bound.`} />
          </div>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
