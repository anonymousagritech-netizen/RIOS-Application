import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useParties, useCreateParty, useCodeLists, usePreference } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { formatNumber, titleCase } from '../lib/format';
import { DynamicForm, collectVisibleValues, type FormContext } from '../lib/formEngine';
import { PARTY_KYC_GROUPS } from '../lib/partySchema';
import { Users, Building2, UserRound, CheckCircle2, Download } from 'lucide-react';
import { ApiError, downloadFile, qs } from '../lib/api';
import type { PartyListItem } from '../lib/types';
import shared from './shared.module.css';
import styles from './PartiesPage.module.css';

// The server's createPartySchema kind enum (lowercase on the wire).
const KINDS = [
  { code: 'organisation', label: 'Organisation' },
  { code: 'individual', label: 'Individual' },
  { code: 'syndicate', label: 'Syndicate' },
  { code: 'pool', label: 'Pool' },
  { code: 'captive', label: 'Captive' },
];

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

  // Saved filter preference: persists the search query and role filter across sessions.
  const { value: savedFilters, save: saveFilters } = usePreference('filters:parties', { q: '', role: '' });
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const savedApplied = useRef(false);
  useEffect(() => {
    if (!savedApplied.current && savedFilters !== undefined) {
      savedApplied.current = true;
      if (savedFilters.q) setQ(savedFilters.q);
      if (savedFilters.role) setRole(savedFilters.role);
    }
  }, [savedFilters]);

  const updateQ = (v: string) => {
    setQ(v);
    void saveFilters({ q: v, role });
  };
  const updateRole = (v: string) => {
    setRole(v);
    void saveFilters({ q, role: v });
  };

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
            onChange={(e) => updateQ(e.target.value)}
            aria-label="Search parties"
          />
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Role</span>
            <Select value={role} onChange={(e) => updateRole(e.target.value)} aria-label="Filter by role">
              <option value="">All</option>
              {roleOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
          <span className={shared.cellSub}>{data?.parties.length ?? 0} result{(data?.parties.length ?? 0) === 1 ? '' : 's'}</span>
          <Button
            variant="ghost"
            icon={<Download size={15} />}
            onClick={() => downloadFile(`/api/parties/export.csv${qs({ q: q || undefined, role: role || undefined })}`, 'parties.csv')}
            aria-label="Export parties as CSV"
          >
            Export CSV
          </Button>
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
  const [kind, setKind] = useState('organisation');
  const [country, setCountry] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  // Regulatory / market identifiers
  const [lei, setLei] = useState('');
  const [taxId, setTaxId] = useState('');
  const [marketId, setMarketId] = useState('');
  // Adaptive KYC / compliance detail values, keyed by field key.
  const [details, setDetails] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // The context the adaptive KYC form reshapes against: the party kind drives
  // entity-vs-individual fields, the (upper-cased) domicile drives the sanctions
  // group, and the detail values are spread in for cross-field `when` predicates.
  const formCtx = useMemo<FormContext>(
    () => ({ kind, country: country.trim().toUpperCase(), ...details }),
    [kind, country, details],
  );

  const reset = () => {
    setLegalName(''); setShortName(''); setKind('organisation'); setCountry(''); setRoles([]);
    setLei(''); setTaxId(''); setMarketId(''); setDetails({}); setError(null);
  };

  const toggleRole = (code: string) =>
    setRoles((r) => (r.includes(code) ? r.filter((x) => x !== code) : [...r, code]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Country is an ISO 3166-1 alpha-2 code on the wire (server enforces length 2).
    const iso = country.trim().toUpperCase();
    // Adaptive KYC detail: only the fields visible for this kind + domicile persist.
    const collected = collectVisibleValues(PARTY_KYC_GROUPS, formCtx, details);
    try {
      const res = await create.mutateAsync({
        legalName: legalName.trim(),
        shortName: shortName.trim() || undefined,
        identifiers: (lei.trim() || taxId.trim() || marketId.trim())
          ? {
              ...(lei.trim() ? { lei: lei.trim() } : {}),
              ...(taxId.trim() ? { taxId: taxId.trim() } : {}),
              ...(marketId.trim() ? { marketId: marketId.trim() } : {}),
            }
          : undefined,
        kind,
        country: iso || undefined,
        roles,
        details: Object.keys(collected).length ? collected : undefined,
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
      size="lg"
      title="New party"
      description="Register a counterparty: identification, classification, domicile and the roles it can play across contracts."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!legalName.trim()}>Create party</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identification" description="How this counterparty is named in the system.">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Legal name" value={legalName} onChange={setLegalName} required placeholder="e.g. Aurora Reinsurance Ltd" hint="Full registered legal name." />
          </div>
          <TextField label="Short name" value={shortName} onChange={setShortName} placeholder="Aurora Re" hint="Display name in lists and tables." />
          <TextField label="LEI" value={lei} onChange={setLei} placeholder="e.g. 5493001KJTIIGC8Y1R12" hint="Legal Entity Identifier (20 chars)." />
          <TextField label="Tax ID" value={taxId} onChange={setTaxId} placeholder="e.g. VAT / EIN / PAN" hint="Tax identifier in the party's domicile." />
          <TextField label="Market ID" value={marketId} onChange={setMarketId} placeholder="e.g. NAIC 12345 / Lloyd's 2987" hint="NAIC code, Lloyd's syndicate number, or bureau id." />
          <FormField label="Kind" required hint="Legal classification of the counterparty.">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <FormSection title="Domicile">
          <FormField label="Country" hint="ISO 3166-1 alpha-2 code, e.g. GB, US, BM.">
            <Input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="GB"
              maxLength={2}
              autoCapitalize="characters"
              style={{ textTransform: 'uppercase' }}
            />
          </FormField>
        </FormSection>

        <DynamicForm
          groups={PARTY_KYC_GROUPS}
          ctx={formCtx}
          values={details}
          onChange={(key, value) => setDetails((d) => ({ ...d, [key]: value }))}
        />

        <FormSection title="Roles" description="A party can hold several roles at once (e.g. both cedent and reinsurer).">
          <div style={{ gridColumn: '1 / -1' }}>
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
          </div>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
