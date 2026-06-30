import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useParties, useCreateParty, useCodeLists } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, TextField } from '../components/Form';
import { formatNumber, titleCase } from '../lib/format';
import { Users, Building2, UserRound, CheckCircle2 } from 'lucide-react';
import { ApiError } from '../lib/api';
import type { PartyListItem } from '../lib/types';
import shared from './shared.module.css';
import styles from './PartiesPage.module.css';

const KINDS = ['ORGANISATION', 'INDIVIDUAL'];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export function PartiesPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data: codeLists } = useCodeLists();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [showNew, setShowNew] = useState(false);

  const { data, isLoading } = useParties({ q: q || undefined, role: role || undefined });
  const roleOptions = codeLists?.lists?.party_role ?? [];

  const stats = useMemo(() => {
    const list = data?.parties ?? [];
    return {
      total: list.length,
      organisations: list.filter((p) => p.kind === 'ORGANISATION').length,
      individuals: list.filter((p) => p.kind === 'INDIVIDUAL').length,
      active: list.filter((p) => p.status === 'ACTIVE').length,
    };
  }, [data]);

  const columns: Column<PartyListItem>[] = [
    { key: 'reference', header: 'Reference', sortValue: (p) => p.reference ?? '', render: (p) => <span className={shared.cellRef}>{p.reference ?? '-'}</span> },
    {
      key: 'legalName',
      header: 'Party',
      sortValue: (p) => p.legalName,
      render: (p) => (
        <div className={styles.partyCell}>
          <span className={styles.avatar} aria-hidden>{initials(p.legalName)}</span>
          <div>
            <div className={shared.cellMain}>{p.legalName}</div>
            {p.shortName && <div className={shared.cellSub}>{p.shortName}</div>}
          </div>
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', sortValue: (p) => p.kind, render: (p) => titleCase(p.kind) },
    { key: 'country', header: 'Country', sortValue: (p) => p.country ?? '', render: (p) => p.country ?? '-' },
    {
      key: 'roles',
      header: 'Roles',
      render: (p) => (
        <div className={shared.checkGroup}>
          {Array.isArray(p.roles) && p.roles.length ? p.roles.map((r) => <Badge key={r} color="indigo">{titleCase(r)}</Badge>) : <span className={shared.cellSub}>-</span>}
        </div>
      ),
    },
    { key: 'status', header: 'Status', align: 'right', render: (p) => <Badge color={p.status === 'ACTIVE' ? 'green' : 'slate'}>{titleCase(p.status)}</Badge> },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Parties' }]}
        title="Parties"
        description="Cedents, reinsurers, brokers and other counterparties across the tenant."
        actions={
          hasPermission('party:write') ? (
            <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New party</Button>
          ) : null
        }
      />

      <div className={styles.kpiGrid}>
        <KpiCard label="Total parties" value={formatNumber(stats.total)} loading={isLoading} icon={<Users size={20} />} accent="var(--primary)" />
        <KpiCard label="Organisations" value={formatNumber(stats.organisations)} loading={isLoading} icon={<Building2 size={20} />} accent="var(--accent-violet)" />
        <KpiCard label="Individuals" value={formatNumber(stats.individuals)} loading={isLoading} icon={<UserRound size={20} />} accent="var(--accent-cyan)" />
        <KpiCard label="Active" value={formatNumber(stats.active)} loading={isLoading} icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" />
      </div>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
          <Input
            className={shared.searchInput}
            placeholder="Search by name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search parties"
          />
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Role</span>
            <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role">
              <option value="">All</option>
              {roleOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
          <span className={shared.cellSub}>{data?.parties.length ?? 0} result{(data?.parties.length ?? 0) === 1 ? '' : 's'}</span>
        </div>

        <Table
          columns={columns}
          rows={data?.parties}
          loading={isLoading}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/parties/${p.id}`)}
          empty={<EmptyState title="No parties found" message="Adjust your search or add a new party." icon={<Users size={16} />} />}
        />
      </Card>

      <NewPartyModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewPartyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const create = useCreateParty();
  const { data: codeLists } = useCodeLists();
  const roleOptions = codeLists?.lists?.party_role ?? [];

  const [legalName, setLegalName] = useState('');
  const [shortName, setShortName] = useState('');
  const [kind, setKind] = useState('ORGANISATION');
  const [country, setCountry] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLegalName(''); setShortName(''); setKind('ORGANISATION'); setCountry(''); setRoles([]); setError(null);
  };

  const toggleRole = (code: string) =>
    setRoles((r) => (r.includes(code) ? r.filter((x) => x !== code) : [...r, code]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await create.mutateAsync({
        legalName,
        shortName: shortName || undefined,
        kind,
        country: country || undefined,
        roles,
      });
      toast.success(`Party ${res.reference} created`);
      reset();
      onClose();
      navigate(`/parties/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the party.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New party"
      description="Register a counterparty and assign its roles."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!legalName.trim()}>Create party</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <TextField label="Legal name" value={legalName} onChange={setLegalName} required placeholder="e.g. Aurora Reinsurance Ltd" />
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Short name" value={shortName} onChange={setShortName} placeholder="Aurora Re" />
          <FormField label="Kind" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
            </Select>
          </FormField>
        </div>
        <TextField label="Country" value={country} onChange={setCountry} placeholder="ISO code, e.g. GB" />
        <FormField label="Roles">
          <div className={shared.checkGroup}>
            {roleOptions.length === 0 && <span className={shared.cellSub}>No roles configured.</span>}
            {roleOptions.map((o) => {
              const active = roles.includes(o.code);
              return (
                <label key={o.code} className={`${shared.check} ${active ? shared.checkActive : ''}`}>
                  <input type="checkbox" checked={active} onChange={() => toggleRole(o.code)} />
                  {o.label}
                </label>
              );
            })}
          </div>
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
