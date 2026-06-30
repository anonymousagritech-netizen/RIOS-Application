import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/Modal';
import { FormField, Input, Select, Textarea } from '../components/Form';
import { formatMoney, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';

/* ---------------- Types ---------------- */
interface TreatyOption {
  id: string;
  reference: string;
  name: string;
  currency: string;
  status: string;
}
interface PcRun {
  id: string;
  contractId: string;
  period: string | null;
  cededPremiumMinor: number;
  commissionPaidMinor: number;
  incurredLossesMinor: number;
  allowableExpensesPct: number;
  ratePct: number;
  lossBroughtForwardMinor: number;
  profitMinor: number;
  profitCommissionMinor: number;
  lossCarriedForwardMinor: number;
  currency: string;
  createdAt: string;
}
interface PcResult {
  id: string;
  contractId: string;
  currency: string;
  profitMinor: number;
  profitCommissionMinor: number;
  lossCarriedForwardMinor: number;
}
interface PortfolioResult {
  id: string;
  contractId: string;
  direction: 'entry' | 'withdrawal';
  currency: string;
  premiumTransferMinor: number;
  lossTransferMinor: number;
  netTransferMinor: number;
}

/* ---------------- Data hooks (local) ---------------- */
function useTreatyOptions() {
  return useQuery({
    queryKey: ['treaties', 'options'],
    queryFn: () => api<{ treaties: TreatyOption[] }>('/api/treaties'),
  });
}
function usePcRuns(treatyId: string | null) {
  return useQuery({
    queryKey: ['treaties', treatyId, 'profit-commission'],
    queryFn: () => api<{ runs: PcRun[] }>(`/api/treaties/${treatyId}/profit-commission`),
    enabled: !!treatyId,
  });
}

export function TreatyAdjustmentsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('treaty:write');
  const { data, isLoading } = useTreatyOptions();
  const treaties = data?.treaties ?? [];
  const [treatyId, setTreatyId] = useState('');

  const selected = useMemo(() => treaties.find((t) => t.id === treatyId) ?? null, [treaties, treatyId]);

  return (
    <>
      <PageHeader
        title="Treaty adjustments"
        description="Profit commission, portfolio transfers, endorsements and commutation - an adjustments workbench."
        actions={canWrite ? <Badge color="green">treaty:write granted</Badge> : <Badge color="slate">read-only</Badge>}
      />

      <Card>
        <CardHeader title="Select a treaty" subtitle="Adjustments apply in the treaty's own currency." />
        <div style={{ marginTop: 'var(--space-4)', maxWidth: 520 }}>
          <FormField label="Treaty" required>
            <Select value={treatyId} onChange={(e) => setTreatyId(e.target.value)} disabled={isLoading}>
              <option value="">{isLoading ? 'Loading treaties…' : 'Select a treaty…'}</option>
              {treaties.map((t) => (
                <option key={t.id} value={t.id}>{t.reference} · {t.name} ({t.currency})</option>
              ))}
            </Select>
          </FormField>
          {selected && (
            <div className={shared.toolbar} style={{ marginTop: 'var(--space-3)' }}>
              <span className={shared.cellSub}>Currency {selected.currency}</span>
              <div className={shared.spacer} />
              <StatusPill status={selected.status} />
            </div>
          )}
        </div>
      </Card>

      {!selected ? (
        <Card>
          <EmptyState title="No treaty selected" message="Choose a treaty above to run adjustments." icon="▤" />
        </Card>
      ) : (
        <div className={shared.cols} style={{ marginTop: 'var(--space-5)' }}>
          <ProfitCommissionCard treaty={selected} canWrite={canWrite} />
          <PortfolioTransferCard treaty={selected} canWrite={canWrite} />
          <EndorseCard treaty={selected} canWrite={canWrite} />
          <CommuteCard treaty={selected} canWrite={canWrite} />
        </div>
      )}
    </>
  );
}

/* ---------------- Profit commission ---------------- */
function ProfitCommissionCard({ treaty, canWrite }: { treaty: TreatyOption; canWrite: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = usePcRuns(treaty.id);

  const [cededPremium, setCededPremium] = useState('');
  const [commissionPaid, setCommissionPaid] = useState('');
  const [incurredLosses, setIncurredLosses] = useState('');
  const [allowableExpensesPct, setAllowableExpensesPct] = useState('');
  const [ratePct, setRatePct] = useState('');
  const [result, setResult] = useState<PcResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (body: {
      cededPremium: number; commissionPaid: number; incurredLosses: number;
      allowableExpensesPct: number; ratePct: number;
    }) => api<PcResult>(`/api/treaties/${treaty.id}/profit-commission`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['treaties', treaty.id, 'profit-commission'] }),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const ceded = Number(cededPremium);
    const comm = Number(commissionPaid);
    const losses = Number(incurredLosses);
    const allow = Number(allowableExpensesPct);
    const rate = Number(ratePct);
    if ([ceded, comm, losses, allow, rate].some((n) => Number.isNaN(n))) {
      setError('Enter numeric values for every field.');
      return;
    }
    try {
      const res = await run.mutateAsync({
        cededPremium: ceded, commissionPaid: comm, incurredLosses: losses,
        allowableExpensesPct: allow, ratePct: rate,
      });
      setResult(res);
      toast.success('Profit commission calculated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run profit commission.');
    }
  };

  const columns: Column<PcRun>[] = [
    { key: 'period', header: 'Period', sortValue: (r) => r.period ?? '', render: (r) => r.period ?? '-' },
    { key: 'profit', header: 'Profit', align: 'right', sortValue: (r) => r.profitMinor, render: (r) => <span className={shared.money}>{formatMoney(r.profitMinor, r.currency)}</span> },
    { key: 'pc', header: 'Profit comm.', align: 'right', sortValue: (r) => r.profitCommissionMinor, render: (r) => <span className={shared.money}>{formatMoney(r.profitCommissionMinor, r.currency)}</span> },
    { key: 'date', header: 'Run', sortValue: (r) => r.createdAt, render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <Card>
      <CardHeader title="Profit commission" subtitle={`Amounts in major units of ${treaty.currency}.`} />
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Ceded premium">
            <Input type="number" step="any" value={cededPremium} onChange={(e) => setCededPremium(e.target.value)} placeholder="e.g. 1000000" disabled={!canWrite} />
          </FormField>
          <FormField label="Commission paid">
            <Input type="number" step="any" value={commissionPaid} onChange={(e) => setCommissionPaid(e.target.value)} placeholder="e.g. 250000" disabled={!canWrite} />
          </FormField>
          <FormField label="Incurred losses">
            <Input type="number" step="any" value={incurredLosses} onChange={(e) => setIncurredLosses(e.target.value)} placeholder="e.g. 400000" disabled={!canWrite} />
          </FormField>
          <FormField label="Allowable expenses %">
            <Input type="number" step="any" value={allowableExpensesPct} onChange={(e) => setAllowableExpensesPct(e.target.value)} placeholder="e.g. 5" disabled={!canWrite} />
          </FormField>
          <FormField label="Rate %">
            <Input type="number" step="any" value={ratePct} onChange={(e) => setRatePct(e.target.value)} placeholder="e.g. 20" disabled={!canWrite} />
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
        <div>
          <Button type="submit" variant="primary" size="sm" loading={run.isPending} disabled={!canWrite}>Run</Button>
        </div>
      </form>

      {result && (
        <div className={shared.toolbar} style={{ marginTop: 'var(--space-3)' }}>
          <span className={shared.cellSub}>Profit {formatMoney(result.profitMinor, result.currency)}</span>
          <div className={shared.spacer} />
          <span className={shared.cellMain}>{formatMoney(result.profitCommissionMinor, result.currency)}</span>
        </div>
      )}

      <div style={{ marginTop: 'var(--space-4)' }}>
        <Table
          columns={columns}
          rows={data?.runs}
          loading={isLoading}
          rowKey={(r) => r.id}
          skeletonRows={3}
          empty={<EmptyState title="No prior runs" message="No profit commission has been run for this treaty." icon="$" />}
        />
      </div>
    </Card>
  );
}

/* ---------------- Portfolio transfer ---------------- */
function PortfolioTransferCard({ treaty, canWrite }: { treaty: TreatyOption; canWrite: boolean }) {
  const toast = useToast();
  const [direction, setDirection] = useState<'entry' | 'withdrawal'>('entry');
  const [unearnedPremium, setUnearnedPremium] = useState('');
  const [outstandingLosses, setOutstandingLosses] = useState('');
  const [premiumPct, setPremiumPct] = useState('');
  const [lossPct, setLossPct] = useState('');
  const [result, setResult] = useState<PortfolioResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (body: {
      direction: 'entry' | 'withdrawal'; unearnedPremium: number; outstandingLosses: number;
      premiumPct: number; lossPct: number;
    }) => api<PortfolioResult>(`/api/treaties/${treaty.id}/portfolio-transfer`, { body }),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const up = Number(unearnedPremium);
    const ol = Number(outstandingLosses);
    const pp = Number(premiumPct);
    const lp = Number(lossPct);
    if ([up, ol, pp, lp].some((n) => Number.isNaN(n))) {
      setError('Enter numeric values for every field.');
      return;
    }
    try {
      const res = await run.mutateAsync({ direction, unearnedPremium: up, outstandingLosses: ol, premiumPct: pp, lossPct: lp });
      setResult(res);
      toast.success(`Portfolio ${direction} calculated`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run portfolio transfer.');
    }
  };

  return (
    <Card>
      <CardHeader title="Portfolio transfer" subtitle={`Entry or withdrawal in major units of ${treaty.currency}.`} />
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <FormField label="Direction" required>
          <Select value={direction} onChange={(e) => setDirection(e.target.value as 'entry' | 'withdrawal')} disabled={!canWrite}>
            <option value="entry">Entry</option>
            <option value="withdrawal">Withdrawal</option>
          </Select>
        </FormField>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Unearned premium">
            <Input type="number" step="any" value={unearnedPremium} onChange={(e) => setUnearnedPremium(e.target.value)} placeholder="e.g. 800000" disabled={!canWrite} />
          </FormField>
          <FormField label="Outstanding losses">
            <Input type="number" step="any" value={outstandingLosses} onChange={(e) => setOutstandingLosses(e.target.value)} placeholder="e.g. 300000" disabled={!canWrite} />
          </FormField>
          <FormField label="Premium %">
            <Input type="number" step="any" value={premiumPct} onChange={(e) => setPremiumPct(e.target.value)} placeholder="e.g. 90" disabled={!canWrite} />
          </FormField>
          <FormField label="Loss %">
            <Input type="number" step="any" value={lossPct} onChange={(e) => setLossPct(e.target.value)} placeholder="e.g. 100" disabled={!canWrite} />
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
        <div>
          <Button type="submit" variant="primary" size="sm" loading={run.isPending} disabled={!canWrite}>Run</Button>
        </div>
      </form>

      {result && (
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div className={shared.toolbar}>
            <span className={shared.cellSub}>Premium transfer</span>
            <div className={shared.spacer} />
            <span className={shared.money}>{formatMoney(result.premiumTransferMinor, result.currency)}</span>
          </div>
          <div className={shared.toolbar}>
            <span className={shared.cellSub}>Loss transfer</span>
            <div className={shared.spacer} />
            <span className={shared.money}>{formatMoney(result.lossTransferMinor, result.currency)}</span>
          </div>
          <div className={shared.toolbar}>
            <span className={shared.cellMain}>Net transfer</span>
            <div className={shared.spacer} />
            <span className={shared.money}>{formatMoney(result.netTransferMinor, result.currency)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- Endorse ---------------- */
function EndorseCard({ treaty, canWrite }: { treaty: TreatyOption; canWrite: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [effectiveDate, setEffectiveDate] = useState('');
  const [description, setDescription] = useState('');
  const [changesText, setChangesText] = useState('{\n  "terms": {}\n}');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (body: { effectiveDate?: string; description: string; changes: Record<string, unknown> }) =>
      api<{ id: string; endorsementNo: number; termSetVersion: number | null }>(`/api/treaties/${treaty.id}/endorse`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['treaties'] }),
  });

  const parseChanges = (): Record<string, unknown> | null => {
    if (!changesText.trim()) return {};
    try {
      const parsed = JSON.parse(changesText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return null;
    } catch {
      return null;
    }
  };

  const openConfirm = () => {
    setError(null);
    if (!description.trim()) { setError('A description is required.'); return; }
    if (parseChanges() === null) { setError('Changes must be a valid JSON object.'); return; }
    setConfirm(true);
  };

  const runEndorse = async () => {
    const changes = parseChanges();
    if (changes === null) { setError('Changes must be a valid JSON object.'); setConfirm(false); return; }
    try {
      const res = await run.mutateAsync({ effectiveDate: effectiveDate || undefined, description, changes });
      toast.success(`Endorsement #${res.endorsementNo} recorded`);
      setConfirm(false);
      setDescription(''); setEffectiveDate(''); setChangesText('{\n  "terms": {}\n}');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the endorsement.');
      setConfirm(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Endorse" subtitle="Record a versioned amendment to the treaty." />
      <form onSubmit={(e) => { e.preventDefault(); openConfirm(); }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <FormField label="Effective date">
          <Input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} disabled={!canWrite} />
        </FormField>
        <FormField label="Description" required>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Increase line size to 25%" disabled={!canWrite} />
        </FormField>
        <FormField label="Changes (JSON)" hint='A JSON object. terms.* are merged into a new term set, e.g. {"terms": {"cession": 0.3}}'>
          <Textarea value={changesText} onChange={(e) => setChangesText(e.target.value)} rows={5} disabled={!canWrite} spellCheck={false} />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={!canWrite}>Endorse</Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={runEndorse}
        loading={run.isPending}
        title="Record endorsement?"
        confirmLabel="Endorse"
        message={`This creates a versioned endorsement on ${treaty.reference}. If it changes terms, a new term set version is created.`}
      />
    </Card>
  );
}

/* ---------------- Commute ---------------- */
function CommuteCard({ treaty, canWrite }: { treaty: TreatyOption; canWrite: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [settlementAmount, setSettlementAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (body: { settlementAmount: number; reason?: string }) =>
      api<{ status: string; settlementAmountMinor: number; endorsementNo: number }>(`/api/treaties/${treaty.id}/commute`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['treaties'] }),
  });

  const openConfirm = () => {
    setError(null);
    const amount = Number(settlementAmount);
    if (settlementAmount === '' || Number.isNaN(amount) || amount < 0) {
      setError('Enter a non-negative settlement amount in major units.');
      return;
    }
    setConfirm(true);
  };

  const runCommute = async () => {
    const amount = Number(settlementAmount);
    try {
      await run.mutateAsync({ settlementAmount: amount, reason: reason || undefined });
      toast.success('Treaty commuted');
      setConfirm(false);
      setSettlementAmount(''); setReason('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not commute the treaty.');
      setConfirm(false);
    }
  };

  const alreadyCommuted = treaty.status?.toUpperCase() === 'COMMUTED';

  return (
    <Card>
      <CardHeader title="Commute" subtitle="Settle and close the treaty. This is irreversible." />
      <form onSubmit={(e) => { e.preventDefault(); openConfirm(); }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
        <FormField label="Settlement amount" required hint={`Major units of ${treaty.currency}.`}>
          <Input type="number" min="0" step="any" value={settlementAmount} onChange={(e) => setSettlementAmount(e.target.value)} placeholder="e.g. 500000" disabled={!canWrite || alreadyCommuted} />
        </FormField>
        <FormField label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional note" disabled={!canWrite || alreadyCommuted} />
        </FormField>
        {alreadyCommuted && <p className={shared.cellSub}>This treaty is already commuted.</p>}
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
        <div>
          <Button type="submit" variant="danger" size="sm" disabled={!canWrite || alreadyCommuted}>Commute treaty</Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={runCommute}
        loading={run.isPending}
        destructive
        title="Commute treaty?"
        confirmLabel="Commute"
        message={`This settles and closes ${treaty.reference}. The treaty status becomes COMMUTED and cannot be undone.`}
      />
    </Card>
  );
}
