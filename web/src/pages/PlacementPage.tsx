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
import { FormField, Input, Select, TextField } from '../components/Form';
import { formatPercent } from '../lib/format';
import shared from './shared.module.css';

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
        <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
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
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setShowNew(true)} disabled={!contractId} icon={<span aria-hidden>+</span>}>New slip</Button>
          ) : null
        }
      />

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
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
          <span className={shared.cellSub}>{slipsData?.slips.length ?? 0} slip{(slipsData?.slips.length ?? 0) === 1 ? '' : 's'}</span>
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
              icon="▤"
            />
          }
        />
      </Card>

      {selectedSlip && (
        <SlipDetailCard slipId={selectedSlip} canWrite={canWrite} statusColors={statusColors} />
      )}

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
    try {
      await addLine.mutateAsync({ partyId, writtenLine: wl });
      toast.success('Market line added');
      setPartyId(''); setWrittenLine('');
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
      <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
        <CardHeader
          title={slip ? `Slip ${slip.reference}` : 'Slip'}
          subtitle={
            slip
              ? <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
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
        <form onSubmit={submitLine} style={{ padding: 'var(--space-4) var(--space-5)', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 'var(--space-3)', alignItems: 'end' }}>
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
          {lineError && <p style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 'var(--text-sm)', margin: 0 }} role="alert">{lineError}</p>}
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

  const [umr, setUmr] = useState('');
  const [orderPct, setOrderPct] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setUmr(''); setOrderPct(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!contractId) { setError('Select a contract first.'); return; }
    const body: { contractId: string; umr?: string; orderPct?: number } = { contractId };
    if (umr.trim()) body.umr = umr.trim();
    const order = Number(orderPct);
    if (orderPct && !Number.isNaN(order)) body.orderPct = order;
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
      title="New slip"
      description="Open a broker slip for the selected contract. Order is a fraction (e.g. 1.0 = 100%)."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!contractId}>Create slip</Button>
        </>
      }
    >
      <form onSubmit={submit} className={shared.grid2} style={{ display: 'grid' }}>
        <TextField label="UMR" value={umr} onChange={setUmr} placeholder="e.g. B1234ABCDEF" />
        <FormField label="Order" hint="Fraction 0..1 (e.g. 1.0)">
          <Input type="number" min="0" step="any" value={orderPct} onChange={(e) => setOrderPct(e.target.value)} placeholder="e.g. 1.0" />
        </FormField>
        {error && <p style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
