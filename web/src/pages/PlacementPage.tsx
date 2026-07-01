import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useTreaties, useParties, useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { KpiCard } from '../components/KpiCard';
import { formatPercent, formatNumber } from '../lib/format';
import { PenLine, FileSignature, Percent, TrendingUp, AlertTriangle } from 'lucide-react';
import shared from './shared.module.css';
import styles from './PlacementPage.module.css';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SlipItem {
  id: string;
  reference: string;
  umr: string | null;
  status: string;
  orderPct: number | null;
  totalWritten: number;
  totalSigned: number;
  isOversubscribed: boolean;
}
interface SlipsResponse { slips: SlipItem[] }

interface MarketLine {
  id: string;
  partyId: string;
  partyName: string;
  layerId: string | null;
  writtenLine: number;
  signedLine: number | null;
  status: string;
}
interface SlipDetail extends SlipItem { marketLines: MarketLine[] }

function useSlips(contractId: string | undefined) {
  return useQuery({
    queryKey: ['placement', 'slips', contractId],
    queryFn: () => api<SlipsResponse>(`/api/placement/slips${qs({ contractId })}`),
    enabled: !!contractId,
  });
}

function useSlip(slipId: string | undefined) {
  return useQuery({
    queryKey: ['placement', 'slip', slipId],
    queryFn: () => api<SlipDetail>(`/api/placement/slips/${slipId}`),
    enabled: !!slipId,
  });
}

function useCreateSlip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { contractId: string; umr?: string; orderPct?: number }) =>
      api<{ id: string; reference: string }>('/api/placement/slips', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['placement', 'slips'] }),
  });
}

function useAddLine(slipId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { partyId: string; layerId?: string; writtenLine: number }) =>
      api(`/api/placement/slips/${slipId}/lines`, { body }),
    // The backend also computes signed_line and status server-side on sign-down,
    // so market lines only carry party, optional layer, and the written line.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['placement', 'slip', slipId] });
      qc.invalidateQueries({ queryKey: ['placement', 'slips'] });
    },
  });
}

function useSignDown(slipId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(`/api/placement/slips/${slipId}/sign-down`, { body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['placement', 'slip', slipId] });
      qc.invalidateQueries({ queryKey: ['placement', 'slips'] });
    },
  });
}

export function PlacementPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('placement:write');

  const { data: treaties } = useTreaties({});
  const [contractId, setContractId] = useState('');
  const [selectedSlip, setSelectedSlip] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const { data: slipsData, isLoading } = useSlips(contractId || undefined);
  const statusColors = useStatusColors('contract_status');

  const treatyList = treaties?.treaties ?? [];
  const slips = slipsData?.slips ?? [];
  const fullyPlaced = slips.filter((s) => s.totalSigned >= 1).length;
  const oversubscribed = slips.filter((s) => s.isOversubscribed).length;
  const avgWritten = slips.length ? slips.reduce((acc, s) => acc + s.totalWritten, 0) / slips.length : 0;

  const columns: Column<SlipItem>[] = useMemo(() => [
    { key: 'reference', header: 'Reference', sortValue: (s) => s.reference ?? '', render: (s) => <span className={shared.cellRef}>{s.reference}</span> },
    { key: 'umr', header: 'UMR', sortValue: (s) => s.umr ?? '', render: (s) => s.umr ?? '-' },
    { key: 'order', header: 'Order', align: 'right', sortValue: (s) => s.orderPct ?? 0, render: (s) => (s.orderPct != null ? formatPercent(s.orderPct) : '-') },
    { key: 'written', header: 'Written', align: 'right', sortValue: (s) => s.totalWritten, render: (s) => formatPercent(s.totalWritten) },
    { key: 'signed', header: 'Signed', align: 'right', sortValue: (s) => s.totalSigned, render: (s) => formatPercent(s.totalSigned) },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      sortValue: (s) => s.status,
      render: (s) => (
        <span className={styles.inlineMeta}>
          {s.isOversubscribed && <Badge color="amber">Oversubscribed</Badge>}
          <StatusPill status={s.status} metaColors={statusColors} />
        </span>
      ),
    },
  ], [statusColors]);

  return (
    <>
      <PageHeader
        title="Placement"
        description="Broker slips, market lines and sign-down for treaty placements."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Placement' }]}
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setShowNew(true)} disabled={!contractId} icon={<span aria-hidden>+</span>}>New slip</Button>
          ) : null
        }
      />

      <div className={styles.page}>
        {contractId && (
          <div className={styles.kpis}>
            <KpiCard label="Slips" value={formatNumber(slips.length)} hint="On this contract" icon={<FileSignature size={20} />} accent="var(--primary)" loading={isLoading} />
            <KpiCard label="Average written" value={formatPercent(avgWritten)} hint="Mean placed line" icon={<Percent size={20} />} accent="var(--accent-violet)" loading={isLoading} />
            <KpiCard label="Fully placed" value={formatNumber(fullyPlaced)} hint="Signed at 100% or more" icon={<TrendingUp size={20} />} accent="var(--accent-emerald)" loading={isLoading} />
            <KpiCard label="Oversubscribed" value={formatNumber(oversubscribed)} hint="Need sign-down" icon={<AlertTriangle size={20} />} accent="var(--accent-orange)" loading={isLoading} />
          </div>
        )}

        <Card padded={false}>
          <div className={`${styles.toolbarPad} ${shared.toolbar}`}>
            <div className={shared.filter}>
              <span className={shared.filterLabel}>Contract</span>
              <Select
                value={contractId}
                onChange={(e) => { setContractId(e.target.value); setSelectedSlip(null); }}
                aria-label="Select a contract"
              >
                <option value="">Select a contract…</option>
                {treatyList.map((t) => <option key={t.id} value={t.id}>{t.reference} - {t.name}</option>)}
              </Select>
            </div>
            <div className={shared.spacer} />
            <span className={shared.cellSub}>{slips.length} slip{slips.length === 1 ? '' : 's'}</span>
          </div>

          <Table
            columns={columns}
            rows={contractId ? slipsData?.slips : []}
            loading={!!contractId && isLoading}
            rowKey={(s) => s.id}
            onRowClick={(s) => setSelectedSlip(s.id)}
            empty={
              <EmptyState
                title={contractId ? 'No slips' : 'Pick a contract'}
                message={contractId ? 'Create a new slip to start placing this contract in the market.' : 'Choose a contract above to view its placement slips.'}
                icon={<PenLine size={28} />}
              />
            }
          />
        </Card>

        {selectedSlip && (
          <SlipDetailCard slipId={selectedSlip} canWrite={canWrite} statusColors={statusColors} />
        )}
      </div>

      <NewSlipModal open={showNew} onClose={() => setShowNew(false)} contractId={contractId} />
    </>
  );
}

function SlipDetailCard({ slipId, canWrite, statusColors }: { slipId: string; canWrite: boolean; statusColors: Record<string, string> }) {
  const { data: slip, isLoading } = useSlip(slipId);
  const { data: parties } = useParties({});
  const toast = useToast();
  const signDown = useSignDown(slipId);
  const addLine = useAddLine(slipId);

  const [confirmSign, setConfirmSign] = useState(false);
  const [partyId, setPartyId] = useState('');
  const [layerId, setLayerId] = useState('');
  const [writtenLine, setWrittenLine] = useState('');
  const [lineError, setLineError] = useState<string | null>(null);

  const partyList = parties?.parties ?? [];

  const lineColumns: Column<MarketLine>[] = [
    { key: 'party', header: 'Market', sortValue: (l) => l.partyName, render: (l) => <span className={shared.cellMain}>{l.partyName}</span> },
    { key: 'written', header: 'Written', align: 'right', sortValue: (l) => l.writtenLine, render: (l) => formatPercent(l.writtenLine) },
    { key: 'signed', header: 'Signed', align: 'right', sortValue: (l) => l.signedLine ?? 0, render: (l) => (l.signedLine != null ? formatPercent(l.signedLine) : '-') },
    { key: 'status', header: 'Status', align: 'right', sortValue: (l) => l.status, render: (l) => <StatusPill status={l.status} metaColors={statusColors} /> },
  ];

  const submitLine = async (e: React.FormEvent) => {
    e.preventDefault();
    setLineError(null);
    if (!partyId) { setLineError('Select a market.'); return; }
    const wl = Number(writtenLine);
    if (Number.isNaN(wl) || wl <= 0) { setLineError('Enter a written line as a fraction (e.g. 0.1).'); return; }
    const trimmedLayer = layerId.trim();
    if (trimmedLayer && !UUID_RE.test(trimmedLayer)) { setLineError('Layer ID must be a valid UUID, or leave it blank.'); return; }
    try {
      await addLine.mutateAsync({ partyId, layerId: trimmedLayer || undefined, writtenLine: wl });
      toast.success('Market line added');
      setPartyId(''); setLayerId(''); setWrittenLine('');
    } catch (err) {
      setLineError(err instanceof ApiError ? err.message : 'Could not add the line.');
    }
  };

  const doSignDown = async () => {
    try {
      await signDown.mutateAsync();
      toast.success('Slip signed down and participations created');
      setConfirmSign(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not sign down the slip.');
    }
  };

  return (
    <Card padded={false}>
      <div className={styles.detailHead}>
        <CardHeader
          title={slip ? `Slip ${slip.reference}` : 'Slip'}
          subtitle={
            slip
              ? <span className={styles.inlineMeta}>
                  Written {formatPercent(slip.totalWritten)} · Signed {formatPercent(slip.totalSigned)}
                  {slip.isOversubscribed && <Badge color="amber">Oversubscribed</Badge>}
                </span>
              : 'Loading…'
          }
          actions={
            canWrite ? (
              <Button variant="secondary" onClick={() => setConfirmSign(true)} loading={signDown.isPending} disabled={!slip || !slip.marketLines.length}>
                Sign down
              </Button>
            ) : null
          }
        />
      </div>

      <Table
        columns={lineColumns}
        rows={slip?.marketLines}
        loading={isLoading}
        rowKey={(l) => l.id}
        empty={<EmptyState title="No market lines" message="Add the first market line to build the order." />}
        skeletonRows={3}
      />

      {canWrite && (
        <form onSubmit={submitLine} className={styles.addLineForm}>
          <FormField label="Market">
            <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">Select a market…</option>
              {partyList.map((p) => <option key={p.id} value={p.id}>{p.shortName ?? p.legalName}</option>)}
            </Select>
          </FormField>
          <FormField label="Written line" hint="Fraction 0..1">
            <Input type="number" min="0" max="1" step="any" value={writtenLine} onChange={(e) => setWrittenLine(e.target.value)} placeholder="e.g. 0.1" />
          </FormField>
          <Button variant="primary" onClick={submitLine} loading={addLine.isPending} disabled={!partyId || !writtenLine}>Add line</Button>
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField label="Layer" hint="Optional layer ID (UUID) for multi-layer XL programmes. Leave blank for a single layer.">
              <Input value={layerId} onChange={(e) => setLayerId(e.target.value)} placeholder="e.g. 3f1c…-…-…" />
            </FormField>
          </div>
          {lineError && <p className={styles.formError} role="alert">{lineError}</p>}
        </form>
      )}

      <ConfirmDialog
        open={confirmSign}
        onClose={() => setConfirmSign(false)}
        onConfirm={doSignDown}
        title="Sign down this slip"
        message="Signing down computes each market's signed line from its written line and creates the corresponding participations on the contract. This finalises the placement order and cannot be undone automatically."
        confirmLabel="Sign down"
        loading={signDown.isPending}
      />
    </Card>
  );
}

function NewSlipModal({ open, onClose, contractId }: { open: boolean; onClose: () => void; contractId: string }) {
  const toast = useToast();
  const create = useCreateSlip();
  const { data: treaties } = useTreaties({});
  const contract = treaties?.treaties.find((t) => t.id === contractId);

  const [umr, setUmr] = useState('');
  const [orderPct, setOrderPct] = useState('1.0');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setUmr(''); setOrderPct('1.0'); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!contractId) { setError('Select a contract first.'); return; }
    // Schema accepts contractId, umr and orderPct (a positive fraction, default 1.0).
    const body: { contractId: string; umr?: string; orderPct?: number } = { contractId };
    if (umr.trim()) body.umr = umr.trim();
    if (orderPct.trim()) {
      const order = Number(orderPct);
      if (Number.isNaN(order) || order <= 0) { setError('Order must be a positive fraction (e.g. 1.0).'); return; }
      body.orderPct = order;
    }
    try {
      const res = await create.mutateAsync(body);
      toast.success(`Slip ${res.reference} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the slip.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="lg"
      title="New slip"
      description="Open a broker slip against the selected contract, ready to capture market lines and sign down."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!contractId}>Create slip</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Contract">
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField label="Placing" hint="Slips inherit their currency and structure from this contract.">
              <Input value={contract ? `${contract.reference} — ${contract.name}` : 'No contract selected'} readOnly disabled />
            </FormField>
          </div>
        </FormSection>

        <FormSection title="Slip terms" description="Order is the share being marketed as a fraction (1.0 = 100%). Written lines may oversubscribe it and are reconciled on sign-down.">
          <TextField label="UMR" value={umr} onChange={setUmr} placeholder="e.g. B1234ABCDEF" hint="Unique Market Reference for the London market slip." />
          <FormField label="Order" hint="Fraction 0..1 (e.g. 1.0 = 100%)">
            <Input type="number" min="0" step="any" value={orderPct} onChange={(e) => setOrderPct(e.target.value)} placeholder="e.g. 1.0" />
          </FormField>
        </FormSection>

        {error && <p className={styles.modalError} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
