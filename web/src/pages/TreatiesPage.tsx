import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTreaties, useCreateTreaty, useCodeLists, useCurrencies, useStatusColors } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { formatDate, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { TreatyListItem } from '../lib/types';
import shared from './shared.module.css';

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
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>
              New treaty
            </Button>
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
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Kind</span>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
              <option value="">All</option>
              {KINDS.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
          <span className={shared.cellSub}>{data?.treaties.length ?? 0} result{(data?.treaties.length ?? 0) === 1 ? '' : 's'}</span>
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
              icon="▤"
            />
          }
        />
      </Card>

      <NewTreatyModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewTreatyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateTreaty();
  const { data: codeLists } = useCodeLists();
  const { data: ccy } = useCurrencies();

  const [name, setName] = useState('');
  const [basis, setBasis] = useState('PROPORTIONAL');
  const [npType, setNpType] = useState('');
  const [proportionalType, setProportionalType] = useState('QUOTA_SHARE');
  const [lineOfBusiness, setLineOfBusiness] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [deposit, setDeposit] = useState('');
  const [error, setError] = useState<string | null>(null);

  const lobOptions = codeLists?.lists?.line_of_business ?? [];
  const currencies = ccy?.currencies ?? [];
  const isProportional = basis === 'PROPORTIONAL';

  const reset = () => {
    setName(''); setBasis('PROPORTIONAL'); setNpType(''); setProportionalType('QUOTA_SHARE');
    setLineOfBusiness(''); setCurrency('USD'); setDeposit(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body: Record<string, unknown> = {
      name,
      contractKind: 'TREATY',
      basis,
      currency,
      lineOfBusiness: lineOfBusiness || undefined,
    };
    if (isProportional) body.proportionalType = proportionalType;
    else body.npType = npType || 'XL';
    const depositNum = Number(deposit);
    if (deposit && !Number.isNaN(depositNum)) {
      body.terms = { depositPremium: depositNum, currency };
    }
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

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New treaty"
      description="Create a draft treaty. You can structure layers and bind it later."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!name.trim()}>
            Create treaty
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className={shared.grid2} style={{ display: 'grid' }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Treaty name" value={name} onChange={setName} required placeholder="e.g. North Atlantic Property QS 2026" />
        </div>
        <FormField label="Basis" required>
          <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="PROPORTIONAL">Proportional</option>
            <option value="NON_PROPORTIONAL">Non-proportional</option>
          </Select>
        </FormField>
        {isProportional ? (
          <FormField label="Proportional type">
            <Select value={proportionalType} onChange={(e) => setProportionalType(e.target.value)}>
              <option value="QUOTA_SHARE">Quota share</option>
              <option value="SURPLUS">Surplus</option>
            </Select>
          </FormField>
        ) : (
          <FormField label="NP type">
            <Select value={npType} onChange={(e) => setNpType(e.target.value)}>
              <option value="XL">Excess of loss</option>
              <option value="STOP_LOSS">Stop loss</option>
              <option value="CATXL">Cat XL</option>
            </Select>
          </FormField>
        )}
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
        <div style={{ gridColumn: '1 / -1' }}>
          <FormField label="Deposit premium (optional)" hint={`Major units of ${currency}. Booked on binding.`}>
            <Input
              type="number"
              min="0"
              step="any"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              placeholder="e.g. 1500000"
            />
          </FormField>
        </div>
        {error && <p style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
