import { Plus, ShieldAlert, FolderOpen, Coins, Wallet, CircleDollarSign } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useClaims, useCreateClaim, useTreaties, useCurrencies, useStatusColors, useCodeLists } from '../lib/queries';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { DynamicForm, collectVisibleValues, type FormContext } from '../lib/formEngine';
import { LOB_CLASS_GROUPS } from '../lib/lobSchema';
import { CLAIM_FNOL_GROUPS } from '../lib/claimSchema';
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
import { formatMoney, formatDate, titleCase } from '../lib/format';
import { t } from '../lib/i18n';
import { ApiError } from '../lib/api';
import type { ClaimListItem } from '../lib/types';
import shared from './shared.module.css';

const STATUSES = ['OPEN', 'NOTIFIED', 'RESERVED', 'PAID', 'CLOSED', 'REOPENED'];

export function ClaimsPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  // Status filter is URL-backed so dashboard/analytics drill-throughs can deep-link
  // (e.g. /claims?status=OPEN); the dropdown keeps the query param in sync.
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const setStatus = (v: string) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v) next.set('status', v); else next.delete('status');
    return next;
  }, { replace: true });
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useClaims({ status: status || undefined });
  const statusColors = useStatusColors('claim_status');

  const claims = data?.claims ?? [];
  const kpis = useMemo(() => {
    const ccy = claims[0]?.currency ?? 'USD';
    const open = claims.filter((c) => c.status !== 'CLOSED').length;
    const gross = claims.reduce((sum, c) => sum + (c.grossLossMinor ?? 0), 0);
    const outstanding = claims.reduce((sum, c) => sum + (c.outstandingMinor ?? 0), 0);
    const paid = claims.reduce((sum, c) => sum + (c.paidMinor ?? 0), 0);
    return { ccy, open, gross, outstanding, paid };
  }, [claims]);

  const columns: Column<ClaimListItem>[] = [
    { key: 'reference', header: 'Reference', sortValue: (c) => c.reference ?? '', render: (c) => <span className={shared.cellRef}>{c.reference ?? '-'}</span> },
    {
      key: 'description',
      header: 'Claim',
      sortValue: (c) => c.description ?? '',
      render: (c) => (
        <div>
          <div className={shared.cellMain}>{c.description ?? 'Untitled claim'}</div>
          <div className={shared.cellSub}>{c.contractName ?? c.contractId}</div>
        </div>
      ),
    },
    { key: 'lossDate', header: 'Loss date', sortValue: (c) => c.lossDate ?? '', render: (c) => formatDate(c.lossDate) },
    { key: 'gross', header: 'Gross Loss', align: 'right', sortValue: (c) => c.grossLossMinor, render: (c) => <span className={shared.money}>{formatMoney(c.grossLossMinor, c.currency)}</span> },
    { key: 'outstanding', header: t('outstandingReserve'), align: 'right', sortValue: (c) => c.outstandingMinor, render: (c) => <span className={shared.money}>{formatMoney(c.outstandingMinor, c.currency)}</span> },
    { key: 'paid', header: 'Paid Loss', align: 'right', sortValue: (c) => c.paidMinor, render: (c) => <span className={shared.money}>{formatMoney(c.paidMinor, c.currency)}</span> },
    { key: 'status', header: 'Status', align: 'right', sortValue: (c) => c.status, render: (c) => <StatusPill status={c.status} metaColors={statusColors} /> },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Claims' }]}
        title="Claims"
        description="Loss notifications, reserves and settlements across treaties."
        actions={
          hasPermission('claims:write') ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<Plus size={16} />}>Register claim</Button>
          ) : null
        }
      />

      <div className={shared.kpiRow}>
        <KpiCard label="Open claims" value={kpis.open} loading={isLoading} icon={<FolderOpen size={20} />} accent="var(--primary)" />
        <KpiCard label="Gross Loss" value={formatMoney(kpis.gross, kpis.ccy)} loading={isLoading} icon={<Coins size={20} />} accent="var(--accent-violet)" />
        <KpiCard label={t('outstandingReserve')} value={formatMoney(kpis.outstanding, kpis.ccy)} loading={isLoading} icon={<Wallet size={20} />} accent="var(--accent-cyan)" />
        <KpiCard label="Paid Loss" value={formatMoney(kpis.paid, kpis.ccy)} loading={isLoading} icon={<CircleDollarSign size={20} />} accent="var(--accent-emerald)" />
      </div>

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
          <span className={shared.cellSub}>{claims.length} result{claims.length === 1 ? '' : 's'}</span>
        </div>

        <Table
          columns={columns}
          rows={claims}
          loading={isLoading}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate(`/claims/${c.id}`)}
          empty={<EmptyState title="No claims" message="No claims match the current filter." icon={<ShieldAlert size={16} />} />}
        />
      </Card>

      <RegisterClaimModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function RegisterClaimModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateClaim();
  const { data: treaties } = useTreaties({});
  const { data: ccy } = useCurrencies();
  const { data: codeLists } = useCodeLists();

  const [contractId, setContractId] = useState('');
  const [description, setDescription] = useState('');
  const [lossDate, setLossDate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [grossLoss, setGrossLoss] = useState('');
  const [catEventId, setCatEventId] = useState('');
  // Adaptive FNOL + class-of-business detail values, keyed by field key.
  const [details, setDetails] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Catastrophe events for occurrence coding (event-level aggregation).
  const { data: catEvents } = useQuery({
    queryKey: ['cat-events'],
    queryFn: () => api<{ events: { id: string; eventCode: string; name: string; peril: string | null }[] }>('/api/claims/cat-events'),
    enabled: open,
  });

  const treatyList = treaties?.treaties ?? [];
  const currencies = ccy?.currencies ?? [];
  const lobOptions = codeLists?.lists?.line_of_business ?? [];

  // The context the adaptive claim form reshapes against. The LOB is derived from
  // the selected treaty's line of business (code + label so the engine's keyword
  // predicates match either), and the FNOL detail values are spread in so
  // cross-field `when` predicates (catastrophe name, litigation follow-ups) fire.
  const formCtx = useMemo<FormContext>(() => {
    const treaty = treatyList.find((t) => t.id === contractId);
    const code = treaty?.lineOfBusiness ?? '';
    const label = lobOptions.find((o) => o.code === code)?.label ?? '';
    return { lob: `${code} ${label}`, ...details };
  }, [contractId, treatyList, lobOptions, details]);
  const claimGroups = useMemo(() => [...LOB_CLASS_GROUPS, ...CLAIM_FNOL_GROUPS], []);

  const reset = () => { setContractId(''); setDescription(''); setLossDate(''); setCurrency('USD'); setGrossLoss(''); setCatEventId(''); setDetails({}); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const gross = Number(grossLoss);
    if (!contractId) { setError('Select a treaty.'); return; }
    if (Number.isNaN(gross) || gross <= 0) { setError('Enter a gross loss (initial case reserve).'); return; }
    // Adaptive detail: the engine returns only the fields currently visible for
    // this treaty's class + the answered FNOL branches, so nothing stale persists.
    const collected = collectVisibleValues(claimGroups, formCtx, details);
    try {
      const res = await create.mutateAsync({
        contractId,
        description: description || undefined,
        lossDate: lossDate || undefined,
        currency,
        grossLoss: gross,
        catEventId: catEventId || undefined,
        details: Object.keys(collected).length ? collected : undefined,
      });
      toast.success(`Claim ${res.reference} registered`);
      reset();
      onClose();
      navigate(`/claims/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not register the claim.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="lg"
      title="Register claim"
      description="Notify a loss against a treaty (FNOL): identification, loss details and the gross reserve. Amounts are in major currency units."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!contractId || !grossLoss}>Register</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Claim identification" description="The treaty the loss is notified against and a short narrative.">
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField label="Treaty" required>
              <Select value={contractId} onChange={(e) => {
                const id = e.target.value;
                setContractId(id);
                const t = treatyList.find((x) => x.id === id);
                if (t) setCurrency(t.currency);
              }}>
                <option value="">Select a treaty…</option>
                {treatyList.map((t) => (
                  <option key={t.id} value={t.id}>{t.reference} - {t.name}</option>
                ))}
              </Select>
            </FormField>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Description" value={description} onChange={setDescription} placeholder="e.g. Hurricane property damage" hint="Cause / peril and a short description of the loss." />
          </div>
        </FormSection>

        <FormSection title="Loss details">
          <TextField label="Date of loss" type="date" value={lossDate} onChange={setLossDate} hint="When the loss occurred (the notified date is set to today)." />
          <FormField label="Catastrophe event">
            <Select value={catEventId} onChange={(e) => setCatEventId(e.target.value)}>
              <option value="">Not event-related / attritional</option>
              {(catEvents?.events ?? []).map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.eventCode} — {ev.name}{ev.peril ? ` (${ev.peril})` : ''}</option>
              ))}
            </Select>
          </FormField>
        </FormSection>

        <DynamicForm
          groups={claimGroups}
          ctx={formCtx}
          values={details}
          onChange={(key, value) => setDetails((d) => ({ ...d, [key]: value }))}
        />

        <FormSection title="Financials" description="The initial gross reserve opens the case reserve on registration.">
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </FormField>
          <FormField label={`Gross loss / initial case reserve (major units of ${currency})`} required>
            <Input type="number" min="0" step="any" value={grossLoss} onChange={(e) => setGrossLoss(e.target.value)} placeholder="e.g. 250000" />
          </FormField>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
