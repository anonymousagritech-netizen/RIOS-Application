import { ShieldAlert, Wallet, CircleDollarSign, Undo2, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useClaim, useReserveMovement, useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, Textarea } from '../components/Form';
import { Table, type Column, EmptyState } from '../components/Table';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { ApprovalPanel } from '../components/ApprovalPanel';
import { DefinitionList, ErrorState, PageLoader, SectionLabel } from '../components/Feedback';
import { formatMoney, formatDate, formatDateTime, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { ClaimMovement } from '../lib/types';
import shared from './shared.module.css';
import styles from './ClaimDetailPage.module.css';

type MovementType = 'OPEN' | 'INCREASE' | 'DECREASE' | 'PAYMENT' | 'CLOSE';

// Recovery shape mirrors GET /api/claims/:id/recoveries (see ClaimsRecoveriesPage).
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

function useClaimRecoveries(claimId: string | undefined) {
  return useQuery({
    queryKey: ['claims', claimId, 'recoveries'],
    queryFn: () => api<{ recoveries: RecoveryItem[] }>(`/api/claims/${claimId}/recoveries`),
    enabled: !!claimId,
  });
}

export function ClaimDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data: claim, isLoading, isError } = useClaim(id);
  const recoveries = useClaimRecoveries(id);
  const statusColors = useStatusColors('claim_status');
  const [showMove, setShowMove] = useState(false);
  const [quickMoveType, setQuickMoveType] = useState<MovementType | undefined>(undefined);

  const openMove = (type?: MovementType) => { setQuickMoveType(type); setShowMove(true); };

  if (isLoading) return <PageLoader label="Loading claim…" />;
  if (isError || !claim) {
    return <Card><ErrorState title="Claim not found" action={<Button onClick={() => navigate('/claims')}>Back to claims</Button>} /></Card>;
  }

  const movements = (claim.movements ?? []).slice().reverse();
  const ccy = claim.currency;

  const canReserve = ['NOTIFIED', 'OPEN'].includes(claim.status);
  const canSettle  = ['RESERVED', 'PART_PAID'].includes(claim.status);

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Claims', to: '/claims' }, { label: claim.reference ?? 'Claim' }]}
        title={claim.description ?? 'Claim'}
        description={
          <span>
            <span className={shared.cellRef}>{claim.reference}</span> ·{' '}
            <Link className={styles.treatyLink} to={`/treaties/${claim.contractId}`}>{claim.contractName ?? claim.contractId}</Link>
          </span>
        }
        actions={
          <div className={styles.actions}>
            <StatusPill status={claim.status} metaColors={statusColors} />
            {hasPermission('claims:write') && (
              <>
                {canReserve && (
                  <Button variant="secondary" size="sm" onClick={() => openMove('OPEN')}>Reserve</Button>
                )}
                {canSettle && (
                  <Button variant="secondary" size="sm" onClick={() => openMove('PAYMENT')}>Settle</Button>
                )}
                <Button variant="primary" size="sm" onClick={() => openMove(undefined)}>Add movement / Pay</Button>
              </>
            )}
          </div>
        }
      />

      <div className={shared.kpiRow}>
        <KpiCard label="Gross loss" value={formatMoney(claim.grossLossMinor, ccy)} icon={<ShieldAlert size={20} />} accent="var(--primary)" />
        <KpiCard label="Outstanding" value={formatMoney(claim.outstandingMinor, ccy)} icon={<Wallet size={20} />} accent="var(--accent-violet)" />
        <KpiCard label="Paid" value={formatMoney(claim.paidMinor, ccy)} icon={<CircleDollarSign size={20} />} accent="var(--accent-cyan)" />
        <KpiCard label="Recovered" value={formatMoney(claim.recoveredMinor, ccy)} icon={<Undo2 size={20} />} accent="var(--accent-emerald)" />
      </div>

      <div className={shared.cols}>
        <Card>
          <CardHeader title="Reserve movements" subtitle="Reserve and payment history, newest first." />
          {movements.length === 0 ? (
            <EmptyState title="No movements yet" message="Reserve increases, decreases and payments will appear here as a timeline." icon={<History size={16} />} />
          ) : (
            <ol className={styles.timeline}>
              {movements.map((m) => <MovementRow key={m.id} m={m} currency={ccy} />)}
            </ol>
          )}
        </Card>

        <Card>
          <CardHeader title="Financials" />
          <DefinitionList
            items={[
              { term: 'Gross loss', value: <span className={shared.money}>{formatMoney(claim.grossLossMinor, ccy)}</span> },
              { term: 'Outstanding', value: <span className={shared.money}>{formatMoney(claim.outstandingMinor, ccy)}</span> },
              { term: 'Paid', value: <span className={shared.money}>{formatMoney(claim.paidMinor, ccy)}</span> },
              { term: 'Recovered', value: <span className={shared.money}>{formatMoney(claim.recoveredMinor, ccy)}</span> },
              { term: 'Currency', value: ccy },
            ]}
          />
          <div style={{ marginTop: 'var(--space-5)' }}>
            <SectionLabel>Dates</SectionLabel>
            <DefinitionList
              items={[
                { term: 'Loss date', value: formatDate(claim.lossDate) },
                { term: 'Notified', value: formatDate(claim.notifiedDate) },
              ]}
            />
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <Card padded={false}>
          <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
            <div>
              <SectionLabel>Recoveries</SectionLabel>
              <p className={shared.cellSub}>Reinsurance, salvage and subrogation recovered against this loss.</p>
            </div>
            <div className={shared.spacer} />
            <Link to="/recoveries"><Button size="sm" variant="secondary" icon={<Undo2 size={16} />}>Manage recoveries</Button></Link>
          </div>
          <Table
            columns={recoveryColumns}
            rows={recoveries.data?.recoveries}
            loading={recoveries.isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState title="No recoveries" message="No recoveries have been booked against this claim." icon={<Undo2 size={16} />} />}
          />
        </Card>
      </div>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <ApprovalPanel entityType="claim" entityId={id!} />
      </div>

      <div style={{ marginTop: 'var(--space-5)' }}>
        <DocumentsPanel entityType="claim" entityId={id!} />
      </div>

      <MovementModal
        claimId={id!}
        currency={ccy}
        open={showMove}
        defaultMovementType={quickMoveType}
        onClose={() => { setShowMove(false); setQuickMoveType(undefined); }}
      />
    </>
  );
}

const recoveryColumns: Column<RecoveryItem>[] = [
  { key: 'type', header: 'Type', sortValue: (r) => r.recoveryType, render: (r) => <Badge color="blue">{titleCase(r.recoveryType)}</Badge> },
  { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountMinor, render: (r) => <span className={shared.money}>{formatMoney(r.amountMinor, r.currency)}</span> },
  { key: 'status', header: 'Status', render: (r) => <span className={shared.cellSub}>{r.status ? titleCase(r.status) : '-'}</span> },
  { key: 'collected', header: 'Collected', render: (r) => formatDate(r.collectedDate) },
  { key: 'created', header: 'Booked', sortValue: (r) => r.createdAt ?? '', render: (r) => formatDate(r.createdAt) },
];

function MovementRow({ m, currency }: { m: ClaimMovement; currency: string }) {
  const color =
    m.movementType === 'PAYMENT' ? 'teal'
      : m.movementType === 'CLOSE' ? 'slate'
        : m.movementType === 'DECREASE' ? 'amber'
          : m.movementType === 'OPEN' ? 'blue' : 'indigo';
  return (
    <li className={styles.item}>
      <span className={styles.bullet} aria-hidden />
      <div className={styles.itemBody}>
        <div className={styles.itemHead}>
          <Badge color={color}>{titleCase(m.movementType)}</Badge>
          <span className={shared.cellSub}>{formatDateTime(m.createdAt)}</span>
        </div>
        <div className={styles.deltas}>
          {m.outstandingDeltaMinor != null && m.outstandingDeltaMinor !== 0 && (
            <span>Outstanding <strong className={shared.money}>{signed(m.outstandingDeltaMinor, currency)}</strong></span>
          )}
          {m.paidDeltaMinor != null && m.paidDeltaMinor !== 0 && (
            <span>Paid <strong className={shared.money}>{signed(m.paidDeltaMinor, currency)}</strong></span>
          )}
        </div>
        {m.reason && <p className={styles.reason}>{m.reason}</p>}
      </div>
    </li>
  );
}

function signed(minor: number, currency: string): string {
  const s = formatMoney(Math.abs(minor), currency);
  return minor < 0 ? `−${s}` : `+${s}`;
}

function MovementModal({ claimId, currency, open, defaultMovementType, onClose }: {
  claimId: string; currency: string; open: boolean; defaultMovementType?: MovementType; onClose: () => void;
}) {
  const toast = useToast();
  const move = useReserveMovement(claimId);
  const [movementType, setMovementType] = useState<MovementType>(defaultMovementType ?? 'INCREASE');
  const [outstandingDelta, setOutstandingDelta] = useState('');
  const [paidDelta, setPaidDelta] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // When the modal opens with a quick-action type (e.g. Reserve → OPEN, Settle → PAYMENT),
  // pre-select that type so the user lands on the right movement without extra clicks.
  useEffect(() => {
    if (open && defaultMovementType) setMovementType(defaultMovementType);
  }, [open, defaultMovementType]);

  const reset = () => { setMovementType(defaultMovementType ?? 'INCREASE'); setOutstandingDelta(''); setPaidDelta(''); setReason(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const od = Number(outstandingDelta || 0);
    const pd = Number(paidDelta || 0);
    if (Number.isNaN(od) || Number.isNaN(pd)) { setError('Enter numeric amounts.'); return; }
    try {
      await move.mutateAsync({
        movementType,
        outstandingDelta: od,
        paidDelta: pd,
        reason: reason || undefined,
      });
      toast.success('Reserve movement recorded');
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the movement.');
    }
  };

  const isPayment = movementType === 'PAYMENT';

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Reserve movement"
      description="Amounts are in major currency units. Use negative values to reduce."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={move.isPending}>Record movement</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Movement type" required>
          <Select value={movementType} onChange={(e) => setMovementType(e.target.value as MovementType)}>
            <option value="OPEN">Open reserve</option>
            <option value="INCREASE">Increase reserve</option>
            <option value="DECREASE">Decrease reserve</option>
            <option value="PAYMENT">Payment</option>
            <option value="CLOSE">Close</option>
          </Select>
        </FormField>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label={`Outstanding delta (${currency})`} hint="Change to the outstanding reserve">
            <Input type="number" step="any" value={outstandingDelta} onChange={(e) => setOutstandingDelta(e.target.value)} placeholder="0" />
          </FormField>
          <FormField label={`Paid delta (${currency})`} hint={isPayment ? 'Amount paid this movement' : 'Usually 0 unless paying'}>
            <Input type="number" step="any" value={paidDelta} onChange={(e) => setPaidDelta(e.target.value)} placeholder="0" />
          </FormField>
        </div>
        <FormField label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional note explaining the movement" />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
