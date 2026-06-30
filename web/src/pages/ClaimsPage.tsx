import { Plus, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClaims, useCreateClaim, useTreaties, useCurrencies, useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { formatMoney, formatDate, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { ClaimListItem } from '../lib/types';
import shared from './shared.module.css';

const STATUSES = ['OPEN', 'NOTIFIED', 'RESERVED', 'PAID', 'CLOSED', 'REOPENED'];

export function ClaimsPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useClaims({ status: status || undefined });
  const statusColors = useStatusColors('claim_status');

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
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (c) => c.grossLossMinor, render: (c) => <span className={shared.money}>{formatMoney(c.grossLossMinor, c.currency)}</span> },
    { key: 'outstanding', header: 'Outstanding', align: 'right', sortValue: (c) => c.outstandingMinor, render: (c) => <span className={shared.money}>{formatMoney(c.outstandingMinor, c.currency)}</span> },
    { key: 'paid', header: 'Paid', align: 'right', sortValue: (c) => c.paidMinor, render: (c) => <span className={shared.money}>{formatMoney(c.paidMinor, c.currency)}</span> },
    { key: 'status', header: 'Status', align: 'right', sortValue: (c) => c.status, render: (c) => <StatusPill status={c.status} metaColors={statusColors} /> },
  ];

  return (
    <>
      <PageHeader
        title="Claims"
        description="Loss notifications, reserves and settlements across treaties."
        actions={
          hasPermission('claims:write') ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<Plus size={16} />}>Register claim</Button>
          ) : null
        }
      />

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
          <span className={shared.cellSub}>{data?.claims.length ?? 0} result{(data?.claims.length ?? 0) === 1 ? '' : 's'}</span>
        </div>

        <Table
          columns={columns}
          rows={data?.claims}
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

  const [contractId, setContractId] = useState('');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [grossLoss, setGrossLoss] = useState('');
  const [error, setError] = useState<string | null>(null);

  const treatyList = treaties?.treaties ?? [];
  const currencies = ccy?.currencies ?? [];

  const reset = () => { setContractId(''); setDescription(''); setCurrency('USD'); setGrossLoss(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const gross = Number(grossLoss);
    if (!contractId) { setError('Select a treaty.'); return; }
    if (Number.isNaN(gross) || gross <= 0) { setError('Enter a gross loss amount.'); return; }
    try {
      const res = await create.mutateAsync({
        contractId,
        description: description || undefined,
        currency,
        grossLoss: gross,
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
      title="Register claim"
      description="Notify a loss against a treaty. Gross loss is entered in major currency units."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!contractId || !grossLoss}>Register</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
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
        <TextField label="Description" value={description} onChange={setDescription} placeholder="e.g. Hurricane property damage" />
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Currency" required>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.length ? currencies.map((c) => c.code) : ['USD', 'EUR', 'GBP', 'JPY']).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Gross loss (major units)" required>
            <Input type="number" min="0" step="any" value={grossLoss} onChange={(e) => setGrossLoss(e.target.value)} placeholder="e.g. 250000" />
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
