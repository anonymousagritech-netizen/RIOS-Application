import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Modal } from '../components/Modal';
import { FormField, Input, Select } from '../components/Form';
import { KpiCard } from '../components/KpiCard';
import { DefinitionList } from '../components/Feedback';
import { formatMoney, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';
import styles from './workspace.module.css';

/* ---------------- Types (shapes confirmed from server/src/modules/claimsAdvanced.ts) ---------------- */
interface ClaimPickItem {
  id: string;
  reference: string | null;
  description: string | null;
  contractId: string;
  currency: string;
  status: string;
  grossLossMinor: number;
  outstandingMinor: number;
  paidMinor: number;
  recoveredMinor: number;
}
interface ClaimsResponse { claims: ClaimPickItem[]; }

interface NetPosition {
  claimId: string;
  currency: string;
  grossLossMinor: number;
  paidMinor: number;
  recoveredMinor: number;
  netMinor: number;
}

interface RecoveryItem {
  id: string;
  claimId: string;
  recoveryContractId: string | null;
  recoveryType: string;
  amountMinor: number;
  currency: string;
  status: string | null;
  collectedDate: string | null;
  createdAt: string | null;
}
interface RecoveriesResponse { recoveries: RecoveryItem[]; }

interface CashCallResult {
  id: string;
  claimId: string;
  contractId: string;
  amountMinor: number;
  currency: string;
  status: string;
}

interface ReinstatementCharge {
  amountReinstatedMinor: number;
  rate: number;
  timeFraction: number;
  premiumMinor: number;
}
interface ReinstatementResult {
  claimId: string;
  layerId: string;
  currency: string;
  charges: ReinstatementCharge[];
  totalReinstatementPremiumMinor: number;
  limitReinstatedMinor: number;
}

interface LayerItem {
  id: string;
  name: string | null;
  layerNo?: number;
  currency?: string;
}
interface TreatyResponse {
  id: string;
  currency?: string;
  layers?: LayerItem[];
}

const RECOVERY_TYPES = ['REINSURANCE', 'SALVAGE', 'SUBROGATION'] as const;
type RecoveryType = (typeof RECOVERY_TYPES)[number];

const TABS = [
  { id: 'recoveries', label: 'Recoveries' },
  { id: 'cashcalls', label: 'Cash calls' },
  { id: 'reinstatement', label: 'Reinstatement' },
];

/* ---------------- Data hooks ---------------- */
function useRecoveryClaims() {
  return useQuery({
    queryKey: ['claims', 'recoveries', 'list'],
    queryFn: () => api<ClaimsResponse>(`/api/claims${qs({})}`),
  });
}
function useNetPosition(claimId: string | undefined) {
  return useQuery({
    queryKey: ['claims', claimId, 'net-position'],
    queryFn: () => api<NetPosition>(`/api/claims/${claimId}/net-position`),
    enabled: !!claimId,
  });
}
function useRecoveries(claimId: string | undefined) {
  return useQuery({
    queryKey: ['claims', claimId, 'recoveries'],
    queryFn: () => api<RecoveriesResponse>(`/api/claims/${claimId}/recoveries`),
    enabled: !!claimId,
  });
}
function useTreaty(contractId: string | undefined) {
  return useQuery({
    queryKey: ['treaties', contractId, 'layers'],
    queryFn: () => api<TreatyResponse>(`/api/treaties/${contractId}`),
    enabled: !!contractId,
  });
}
function useAddRecovery(claimId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { recoveryType: RecoveryType; amount: number; recoveryContractId?: string }) =>
      api<RecoveryItem>(`/api/claims/${claimId}/recovery`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['claims', claimId] });
      qc.invalidateQueries({ queryKey: ['claims', 'recoveries', 'list'] });
    },
  });
}
function useRaiseCashCall(claimId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { amount: number }) =>
      api<CashCallResult>(`/api/claims/${claimId}/cash-call`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['claims', claimId, 'cash-calls'] }),
  });
}
function usePayCashCall(claimId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) =>
      api<{ id: string; status: string }>(`/api/claims/${claimId}/cash-call/${callId}/pay`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['claims', claimId, 'cash-calls'] }),
  });
}
function useRunReinstatement(claimId: string | undefined) {
  return useMutation({
    mutationFn: (body: { layerId: string; annualPremium: number; recoveries: number[]; timeFractions?: number[] }) =>
      api<ReinstatementResult>(`/api/claims/${claimId}/reinstatement`, { body }),
  });
}

/* ---------------- Page ---------------- */
export function ClaimsRecoveriesPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('claims:write');
  const canRead = hasPermission('claims:read');

  const { data, isLoading } = useRecoveryClaims();
  const claims = data?.claims ?? [];

  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState('recoveries');

  const selected = claims.find((c) => c.id === selectedId);

  return (
    <>
      <PageHeader
        title="Claims recoveries"
        description="Recoveries, cash calls and reinstatement premium against the net retained position."
        actions={
          canWrite
            ? <Badge color="green">claims:write granted</Badge>
            : canRead
              ? <Badge color="slate">read-only</Badge>
              : <Badge color="slate">no access</Badge>
        }
      />

      <Card>
        <CardHeader title="Claim" subtitle="Pick a claim to view and act on its recoveries." />
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Claim" required>
            <Select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={isLoading}
              aria-label="Select a claim"
            >
              <option value="">{isLoading ? 'Loading claims…' : 'Select a claim…'}</option>
              {claims.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.reference ?? c.id)} - {c.description ?? 'Untitled claim'}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </Card>

      {selected && (
        <>
          <NetPositionKpis claimId={selected.id} fallbackCurrency={selected.currency} />

          <Card padded={false}>
            <div className={styles.tabBar}><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
            {tab === 'recoveries' && <RecoveriesTab claim={selected} canWrite={canWrite} />}
            {tab === 'cashcalls' && <CashCallsTab claim={selected} canWrite={canWrite} />}
            {tab === 'reinstatement' && <ReinstatementTab claim={selected} canWrite={canWrite} />}
          </Card>
        </>
      )}
    </>
  );
}

/* ---------------- Net position KPIs ---------------- */
function NetPositionKpis({ claimId, fallbackCurrency }: { claimId: string; fallbackCurrency: string }) {
  const { data, isLoading } = useNetPosition(claimId);
  const ccy = data?.currency ?? fallbackCurrency;
  return (
    <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
      <KpiCard label="Gross loss" value={formatMoney(data?.grossLossMinor, ccy)} loading={isLoading} icon="◬" />
      <KpiCard label="Paid" value={formatMoney(data?.paidMinor, ccy)} loading={isLoading} icon="→" accent="var(--c-amber)" />
      <KpiCard label="Recovered" value={formatMoney(data?.recoveredMinor, ccy)} loading={isLoading} icon="←" accent="var(--c-green)" />
      <KpiCard label="Net retained" value={formatMoney(data?.netMinor, ccy)} loading={isLoading} icon="Σ" />
    </div>
  );
}

/* ---------------- Recoveries tab ---------------- */
function RecoveriesTab({ claim, canWrite }: { claim: ClaimPickItem; canWrite: boolean }) {
  const { data, isLoading } = useRecoveries(claim.id);
  const [showAdd, setShowAdd] = useState(false);
  const recoveries = data?.recoveries ?? [];

  const columns: Column<RecoveryItem>[] = [
    { key: 'type', header: 'Type', sortValue: (r) => r.recoveryType, render: (r) => <Badge color="blue">{titleCase(r.recoveryType)}</Badge> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountMinor, render: (r) => <span className={shared.money}>{formatMoney(r.amountMinor, r.currency)}</span> },
    { key: 'status', header: 'Status', render: (r) => <span className={shared.cellSub}>{r.status ? titleCase(r.status) : '-'}</span> },
    { key: 'collected', header: 'Collected', render: (r) => formatDate(r.collectedDate) },
    { key: 'created', header: 'Booked', sortValue: (r) => r.createdAt ?? '', render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader
          title="Recoveries"
          subtitle="Reinsurance, salvage and subrogation recoveries booked against the claim."
          actions={canWrite ? <Button size="sm" variant="primary" onClick={() => setShowAdd(true)} icon={<span aria-hidden>+</span>}>Add recovery</Button> : undefined}
        />
      </div>
      <Table
        columns={columns}
        rows={recoveries}
        loading={isLoading}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No recoveries" message="No recoveries have been booked against this claim." icon="←" />}
      />
      <AddRecoveryModal claim={claim} open={showAdd} onClose={() => setShowAdd(false)} />
    </>
  );
}

function AddRecoveryModal({ claim, open, onClose }: { claim: ClaimPickItem; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const add = useAddRecovery(claim.id);
  const { data: treaty } = useTreaty(claim.contractId);
  const [recoveryType, setRecoveryType] = useState<RecoveryType>('REINSURANCE');
  const [amount, setAmount] = useState('');
  const [recoveryContractId, setRecoveryContractId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setRecoveryType('REINSURANCE'); setAmount(''); setRecoveryContractId(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const amt = Number(amount);
    if (Number.isNaN(amt) || amt <= 0) { setError('Enter a recovery amount.'); return; }
    try {
      await add.mutateAsync({
        recoveryType,
        amount: amt,
        recoveryContractId: recoveryContractId || undefined,
      });
      toast.success('Recovery booked');
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not book the recovery.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add recovery"
      description={`Book a recovery against ${claim.reference ?? 'the claim'}. Amount is in major units of ${claim.currency}.`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={add.isPending} disabled={!amount}>Book recovery</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Recovery type" required>
          <Select value={recoveryType} onChange={(e) => setRecoveryType(e.target.value as RecoveryType)}>
            {RECOVERY_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </Select>
        </FormField>
        <FormField label={`Amount (major units of ${claim.currency})`} required>
          <Input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50000" />
        </FormField>
        <FormField label="Recovery contract" hint="Optional - the inuring contract the recovery flows from.">
          <Select value={recoveryContractId} onChange={(e) => setRecoveryContractId(e.target.value)}>
            <option value="">None</option>
            {(treaty?.id ? [{ id: treaty.id, name: 'This claim’s treaty' }] : []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Select>
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Cash calls tab ---------------- */
function CashCallsTab({ claim, canWrite }: { claim: ClaimPickItem; canWrite: boolean }) {
  const toast = useToast();
  const raise = useRaiseCashCall(claim.id);
  const pay = usePayCashCall(claim.id);
  // The backend has no list endpoint for cash calls, so we track ones raised this session.
  const [calls, setCalls] = useState<CashCallResult[]>([]);
  const [showRaise, setShowRaise] = useState(false);

  const onPay = async (call: CashCallResult) => {
    try {
      const res = await pay.mutateAsync(call.id);
      setCalls((cs) => cs.map((c) => (c.id === call.id ? { ...c, status: res.status } : c)));
      toast.success('Cash call marked paid');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not pay the cash call.');
    }
  };

  const columns: Column<CashCallResult>[] = [
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (c) => c.amountMinor, render: (c) => <span className={shared.money}>{formatMoney(c.amountMinor, c.currency)}</span> },
    { key: 'status', header: 'Status', render: (c) => <Badge color={c.status === 'paid' ? 'green' : 'amber'}>{titleCase(c.status)}</Badge> },
    {
      key: 'action', header: '', align: 'right',
      render: (c) => (canWrite && c.status !== 'paid'
        ? <Button size="sm" variant="secondary" onClick={() => onPay(c)} loading={pay.isPending}>Mark paid</Button>
        : null),
    },
  ];

  return (
    <>
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader
          title="Cash calls"
          subtitle="Advances requested against the loss. Calls raised in this session appear below."
          actions={canWrite ? <Button size="sm" variant="primary" onClick={() => setShowRaise(true)} icon={<span aria-hidden>+</span>}>Raise cash call</Button> : undefined}
        />
      </div>
      <Table
        columns={columns}
        rows={calls}
        rowKey={(c) => c.id}
        empty={<EmptyState title="No cash calls" message="No cash calls have been raised in this session." icon="◇" />}
      />
      <RaiseCashCallModal
        claim={claim}
        open={showRaise}
        onClose={() => setShowRaise(false)}
        pending={raise.isPending}
        onRaise={async (amount) => {
          const res = await raise.mutateAsync({ amount });
          setCalls((cs) => [res, ...cs]);
          toast.success('Cash call raised');
        }}
      />
    </>
  );
}

function RaiseCashCallModal({ claim, open, onClose, onRaise, pending }: {
  claim: ClaimPickItem; open: boolean; onClose: () => void;
  onRaise: (amount: number) => Promise<void>; pending: boolean;
}) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setAmount(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const amt = Number(amount);
    if (Number.isNaN(amt) || amt <= 0) { setError('Enter a cash call amount.'); return; }
    try {
      await onRaise(amt);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not raise the cash call.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Raise cash call"
      description={`Request an advance against ${claim.reference ?? 'the claim'}. Amount is in major units of ${claim.currency}.`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!amount}>Raise call</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label={`Amount (major units of ${claim.currency})`} required>
          <Input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 100000" />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Reinstatement tab ---------------- */
function ReinstatementTab({ claim, canWrite }: { claim: ClaimPickItem; canWrite: boolean }) {
  const { data: treaty, isLoading: layersLoading } = useTreaty(claim.contractId);
  const run = useRunReinstatement(claim.id);
  const toast = useToast();

  const layers = treaty?.layers ?? [];

  const [layerId, setLayerId] = useState('');
  const [annualPremium, setAnnualPremium] = useState('');
  const [recoveries, setRecoveries] = useState('');
  const [timeFractions, setTimeFractions] = useState('');
  const [result, setResult] = useState<ReinstatementResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parseList = (s: string): number[] =>
    s.split(',').map((x) => x.trim()).filter((x) => x !== '').map((x) => Number(x));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!layerId) { setError('Select a layer.'); return; }
    const ap = Number(annualPremium);
    if (Number.isNaN(ap) || ap <= 0) { setError('Enter the annual premium.'); return; }
    const recs = parseList(recoveries);
    if (recs.some((n) => Number.isNaN(n))) { setError('Recoveries must be a comma-separated list of numbers.'); return; }
    const tf = parseList(timeFractions);
    if (tf.some((n) => Number.isNaN(n))) { setError('Time fractions must be a comma-separated list of numbers.'); return; }
    try {
      const res = await run.mutateAsync({
        layerId,
        annualPremium: ap,
        recoveries: recs,
        timeFractions: tf.length ? tf : undefined,
      });
      setResult(res);
      toast.success('Reinstatement premium calculated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not calculate the reinstatement premium.');
    }
  };

  const ccy = result?.currency ?? claim.currency;

  const chargeColumns: Column<ReinstatementCharge & { idx: number }>[] = [
    { key: 'idx', header: '#', render: (c) => c.idx + 1 },
    { key: 'reinstated', header: 'Reinstated', align: 'right', render: (c) => <span className={shared.money}>{formatMoney(c.amountReinstatedMinor, ccy)}</span> },
    { key: 'rate', header: 'Rate', align: 'right', render: (c) => `${(c.rate * 100).toFixed(2).replace(/\.?0+$/, '')}%` },
    { key: 'time', header: 'Time fraction', align: 'right', render: (c) => c.timeFraction },
    { key: 'premium', header: 'Premium', align: 'right', render: (c) => <span className={shared.money}>{formatMoney(c.premiumMinor, ccy)}</span> },
  ];

  return (
    <div className={styles.tabBody}>
      <div className={styles.stack}>
        <Card>
          <CardHeader title="Reinstatement premium" subtitle="Reinstate a layer after losses. Premiums and recoveries are in major units." />
          {canWrite ? (
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              <div className={shared.grid2} style={{ display: 'grid' }}>
                <FormField label="Layer" required>
                  <Select value={layerId} onChange={(e) => setLayerId(e.target.value)} disabled={layersLoading}>
                    <option value="">{layersLoading ? 'Loading layers…' : 'Select a layer…'}</option>
                    {layers.map((l) => (
                      <option key={l.id} value={l.id}>{l.name ?? `Layer ${l.layerNo ?? ''}`.trim()}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField label={`Annual premium (major units of ${claim.currency})`} required>
                  <Input type="number" min="0" step="any" value={annualPremium} onChange={(e) => setAnnualPremium(e.target.value)} placeholder="e.g. 1000000" />
                </FormField>
                <FormField label="Recoveries" hint="Comma-separated, major units. e.g. 500000, 250000">
                  <Input value={recoveries} onChange={(e) => setRecoveries(e.target.value)} placeholder="500000, 250000" />
                </FormField>
                <FormField label="Time fractions" hint="Optional, comma-separated. e.g. 0.5, 1">
                  <Input value={timeFractions} onChange={(e) => setTimeFractions(e.target.value)} placeholder="0.5, 1" />
                </FormField>
              </div>
              {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
              <div>
                <Button variant="primary" onClick={submit} loading={run.isPending} disabled={!layerId}>Calculate</Button>
              </div>
            </form>
          ) : (
            <p className={shared.cellSub}>You need the claims:write permission to calculate reinstatement premium.</p>
          )}

          {result && (
            <div style={{ marginTop: 'var(--space-5)' }}>
              <CardHeader title="Reinstatement charges" />
              <Table
                columns={chargeColumns}
                rows={(result.charges ?? []).map((c, idx) => ({ ...c, idx }))}
                rowKey={(c) => String(c.idx)}
                empty={<EmptyState title="No charges" message="No reinstatement charges were generated." icon="§" />}
              />
              <div style={{ marginTop: 'var(--space-4)' }}>
                <DefinitionList
                  items={[
                    { term: 'Limit reinstated', value: <span className={shared.money}>{formatMoney(result.limitReinstatedMinor, ccy)}</span> },
                    { term: 'Total reinstatement premium', value: <span className={shared.money}>{formatMoney(result.totalReinstatementPremiumMinor, ccy)}</span> },
                  ]}
                />
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
