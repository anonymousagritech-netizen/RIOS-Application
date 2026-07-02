import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useStatusColors, useCurrencies, useCodeLists, useParties } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { KpiCard } from '../components/KpiCard';
import { formatNumber, formatPercent, titleCase } from '../lib/format';
import { DynamicForm, collectVisibleValues, type FormContext } from '../lib/formEngine';
import { LOB_CLASS_GROUPS } from '../lib/lobSchema';
import { FileCheck2, Briefcase, CircleCheckBig, PenLine, Layers } from 'lucide-react';
import shared from './shared.module.css';
import styles from './FacultativePage.module.css';

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
interface FacultativeListResponse { facultative: FacultativeItem[] }

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
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useFacultative({ status: status || undefined });
  const all = useFacultative({});
  const statusColors = useStatusColors('contract_status');

  const stats = useMemo(() => {
    const list = all.data?.facultative ?? [];
    const active = list.filter((r) => ['BOUND', 'ACTIVE'].includes(r.status)).length;
    const draft = list.filter((r) => ['DRAFT', 'QUOTED', 'PLACING'].includes(r.status)).length;
    const lobs = new Set(list.map((r) => r.lineOfBusiness ?? 'other')).size;
    return { total: list.length, active, draft, lobs };
  }, [all.data]);

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
    <div className={styles.page}>
      <PageHeader
        title="Facultative"
        description="Single-risk facultative cessions placed outside of treaty arrangements."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Facultative' }]}
        actions={
          hasPermission('facultative:write') ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New cession</Button>
          ) : null
        }
      />

      <div className={shared.kpiGrid}>
        <KpiCard
          label="Cessions"
          value={formatNumber(stats.total)}
          hint="Facultative placements on book"
          icon={<Briefcase size={20} />}
          accent="var(--primary)"
          loading={all.isLoading}
        />
        <KpiCard
          label="Active / bound"
          value={formatNumber(stats.active)}
          hint="In force or bound"
          icon={<CircleCheckBig size={20} />}
          accent="var(--accent-emerald)"
          loading={all.isLoading}
        />
        <KpiCard
          label="In placement"
          value={formatNumber(stats.draft)}
          hint="Draft, quoted or placing"
          icon={<PenLine size={20} />}
          accent="var(--accent-orange)"
          loading={all.isLoading}
        />
        <KpiCard
          label="Lines of business"
          value={formatNumber(stats.lobs)}
          hint="Distinct LOBs covered"
          icon={<Layers size={20} />}
          accent="var(--accent-violet)"
          loading={all.isLoading}
        />
      </div>

      <Card padded={false}>
        <div className={styles.cardHead}>
          <CardHeader title="Cessions" subtitle="Single-risk facultative placements, filterable by status." />
        </div>
        <div className={`${styles.toolbarPad} ${shared.toolbar}`}>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Status</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All</option>
              {STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
          <span className={shared.cellSub}>{data?.facultative?.length ?? 0} result{(data?.facultative?.length ?? 0) === 1 ? '' : 's'}</span>
        </div>

        <Table
          columns={columns}
          rows={data?.facultative}
          loading={isLoading}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/facultative/${r.id}`)}
          empty={<EmptyState title="No facultative cessions" message="Create a new cession to place a single risk facultatively." icon={<FileCheck2 size={16} />} />}
        />
      </Card>

      <NewCessionModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}

function NewCessionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateFacultative();
  const { data: ccy } = useCurrencies();
  const { data: codeLists } = useCodeLists();
  const { data: partyData } = useParties({});

  // Identification
  const [name, setName] = useState('');
  const [basis, setBasis] = useState('PROPORTIONAL');
  const [facType, setFacType] = useState('FAC_FACULTATIVE');
  const [lineOfBusiness, setLineOfBusiness] = useState('');
  const [currency, setCurrency] = useState('USD');
  // Parties & risk
  const [cedentPartyId, setCedentPartyId] = useState('');
  const [reinsurerPartyId, setReinsurerPartyId] = useState('');
  const [insuredName, setInsuredName] = useState('');
  // Slip dates
  const [validUntil, setValidUntil] = useState('');
  const [inspectedOn, setInspectedOn] = useState('');
  // Sum insured & premium
  const [sumInsured, setSumInsured] = useState('');
  const [premium, setPremium] = useState('');
  const [cededShare, setCededShare] = useState('');
  // Adaptive class-of-business detail values, keyed by field key.
  const [classDetails, setClassDetails] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const currencies = ccy?.currencies ?? [];
  const lobOptions = codeLists?.lists?.line_of_business ?? [];
  const parties = partyData?.parties ?? [];
  const isProportional = basis === 'PROPORTIONAL';
  const partyName = (p: { shortName?: string | null; legalName: string }) => p.shortName || p.legalName;

  // The context the adaptive class-detail form reshapes against. The LOB haystack
  // is code + label so the engine's keyword predicates match either.
  const formCtx = useMemo<FormContext>(() => {
    const label = lobOptions.find((o) => o.code === lineOfBusiness)?.label ?? '';
    return { lob: `${lineOfBusiness} ${label}`, structure: basis };
  }, [lineOfBusiness, lobOptions, basis]);
  const activeClass = useMemo(
    () => LOB_CLASS_GROUPS.find((g) => !g.when || g.when(formCtx))?.id,
    [formCtx],
  );

  const reset = () => {
    setName(''); setBasis('PROPORTIONAL'); setFacType('FAC_FACULTATIVE'); setLineOfBusiness(''); setCurrency('USD');
    setCedentPartyId(''); setReinsurerPartyId(''); setInsuredName('');
    setValidUntil(''); setInspectedOn('');
    setSumInsured(''); setPremium(''); setCededShare(''); setClassDetails({}); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Enter a cession name.'); return; }
    const body: Record<string, unknown> = { name: name.trim(), basis, facType, currency };
    if (lineOfBusiness) body.lineOfBusiness = lineOfBusiness;
    if (cedentPartyId) body.cedentPartyId = cedentPartyId;
    if (reinsurerPartyId) body.reinsurerPartyId = reinsurerPartyId;
    if (insuredName.trim()) body.insuredName = insuredName.trim();
    if (validUntil) body.validUntil = validUntil;
    if (inspectedOn) body.inspectedOn = inspectedOn;
    const si = Number(sumInsured);
    if (sumInsured && !Number.isNaN(si)) body.sumInsured = si;
    const prem = Number(premium);
    if (premium && !Number.isNaN(prem)) body.premium = prem;
    // Ceded share only bites for proportional cessions (server multiplies premium by it).
    if (isProportional) {
      const share = Number(cededShare);
      if (cededShare && !Number.isNaN(share)) body.cededShare = share;
    }
    // Class-specific risk detail: the engine returns only the fields visible for
    // this LOB, so a class the user navigated away from leaves nothing behind.
    const details = collectVisibleValues(LOB_CLASS_GROUPS, formCtx, classDetails);
    if (Object.keys(details).length) {
      if (activeClass) details.classOfBusiness = activeClass;
      body.details = details;
    }
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
      size="lg"
      title="New cession"
      description="Capture the facultative slip: identification, cedent, the underlying risk, sum insured and premium. A supplied premium books the ceded deposit on creation. Amounts are in major currency units."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>Create cession</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Cession name" value={name} onChange={setName} required placeholder="e.g. Acme Refinery Property Fac 2026" />
          </div>
          <FormField label="Basis" required>
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="PROPORTIONAL">Proportional</option>
              <option value="NON_PROPORTIONAL">Non-proportional (excess of loss)</option>
            </Select>
          </FormField>
          <FormField label="Fac type" hint="Obligatory (framework) vs facultative (free on each risk).">
            <Select value={facType} onChange={(e) => setFacType(e.target.value)}>
              <option value="FAC_FACULTATIVE">Fac-facultative</option>
              <option value="FAC_OBLIG">Fac-obligatory</option>
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
        </FormSection>

        <FormSection title="Cedent, reinsurer & risk" description="The reinsured ceding the risk, the reinsurer taking the line, and the underlying insured.">
          <FormField label="Cedent / reinsured">
            <Select value={cedentPartyId} onChange={(e) => setCedentPartyId(e.target.value)}>
              <option value="">Select a party…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
            </Select>
          </FormField>
          <FormField label="Reinsurer">
            <Select value={reinsurerPartyId} onChange={(e) => setReinsurerPartyId(e.target.value)}>
              <option value="">Select a party…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
            </Select>
          </FormField>
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Insured name" value={insuredName} onChange={setInsuredName} placeholder="e.g. Acme Industrial Ltd" />
          </div>
          <FormField label="Quote valid until" hint="Date the offer/quote lapses.">
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </FormField>
          <FormField label="Last inspected" hint="Date of the latest engineering / survey.">
            <Input type="date" value={inspectedOn} onChange={(e) => setInspectedOn(e.target.value)} />
          </FormField>
        </FormSection>

        <DynamicForm
          groups={LOB_CLASS_GROUPS}
          ctx={formCtx}
          values={classDetails}
          onChange={(key, value) => setClassDetails((d) => ({ ...d, [key]: value }))}
        />

        <FormSection title="Sum insured & premium" description={isProportional ? 'The ceded share is applied to the premium when booking the deposit.' : 'For non-proportional cessions the full premium is booked as the ceded deposit.'}>
          <FormField label="Sum insured (major units)" hint={`In ${currency}`}>
            <Input type="number" min="0" step="any" value={sumInsured} onChange={(e) => setSumInsured(e.target.value)} placeholder="e.g. 50000000" />
          </FormField>
          <FormField label="Premium (major units)" hint={`In ${currency}. Books the ceded deposit on creation.`}>
            <Input type="number" min="0" step="any" value={premium} onChange={(e) => setPremium(e.target.value)} placeholder="e.g. 250000" />
          </FormField>
          {isProportional && (
            <div style={{ gridColumn: '1 / -1' }}>
              <FormField label="Ceded share" hint="Fraction between 0 and 1 (e.g. 0.4 = 40%)">
                <Input type="number" min="0" max="1" step="any" value={cededShare} onChange={(e) => setCededShare(e.target.value)} placeholder="e.g. 0.4" />
              </FormField>
            </div>
          )}
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
