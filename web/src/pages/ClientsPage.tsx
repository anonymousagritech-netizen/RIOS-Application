import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users, Building2, Handshake, Shield, Search, Star, Mail, Phone,
  MapPin, KeyRound, Plus, MessageSquare, FileText, ScrollText, Flame,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Drawer } from '../components/Drawer';
import { FormField, Input, Select } from '../components/Form';
import { titleCase } from '../lib/format';
import styles from './ClientsPage.module.css';

/* ---------------- Money helpers (integer minor units) ---------------- */
const money = (m?: number | null, ccy = 'USD') =>
  m == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(m / 100);

/* ---------------- Types ---------------- */
interface RoleFacet { key: string; n: number }
interface ClientRow {
  id: string; legalName: string; shortName: string | null; kind: string | null;
  country: string | null; status: string | null; roles: string[];
  submissions: number; contracts: number;
}
interface ClientList { clients: ClientRow[]; roles: RoleFacet[] }

interface Contact { id: string; kind: string; value: string; label: string | null; isPrimary: boolean }
interface Communication { id: string; kind: string; direction: string | null; subject: string | null; body: string | null; createdAt: string }
interface ClientSubmission { id: string; reference: string; title: string; stage: string; currency: string; estPremiumMinor: number | null; asRole: string | null }
interface ClientContract { id: string; reference: string; name: string; contractKind: string | null; status: string | null; currency: string; periodStart: string | null }
interface ClientClaim { id: string; reference: string; description: string | null; status: string | null; currency: string; grossLossMinor: number | null }
interface ClientDetail {
  id: string; legalName: string; shortName: string | null; kind: string | null; country: string | null; status: string | null;
  reference: string | null; identifiers: Record<string, unknown> | null; roles: string[];
  contacts: Contact[]; communications: Communication[];
  submissions: ClientSubmission[]; contracts: ClientContract[]; claims: ClientClaim[];
}

/* ---------------- Colour maps ---------------- */
type TokenColor = 'green' | 'blue' | 'amber' | 'violet' | 'slate' | 'red' | 'teal' | 'indigo' | 'orange' | 'rose' | 'gray';
const ROLE_COLOR: Record<string, TokenColor> = {
  cedent: 'blue', broker: 'violet', reinsurer: 'teal', retrocessionaire: 'indigo',
};
const roleColor = (role: string): TokenColor => ROLE_COLOR[role.toLowerCase()] ?? 'slate';
// Generic status colouring — code-list statuses aren't fixed, so fall back gracefully.
const STATUS_COLOR: Record<string, TokenColor> = {
  active: 'green', bound: 'green', approved: 'green', open: 'blue', quoted: 'teal',
  pending: 'amber', prospect: 'amber', draft: 'slate', inactive: 'gray',
  declined: 'red', lapsed: 'gray', closed: 'gray', settled: 'green', reserved: 'amber',
};
const statusColor = (s: string | null | undefined): TokenColor => (s ? STATUS_COLOR[s.toLowerCase()] ?? 'slate' : 'gray');

const CONTACT_KINDS = ['email', 'phone', 'address', 'portal_user'] as const;
const CONTACT_ICON: Record<string, React.ReactNode> = {
  email: <Mail size={13} />, phone: <Phone size={13} />, address: <MapPin size={13} />, portal_user: <KeyRound size={13} />,
};

/* ---------------- Data hooks ---------------- */
function useClients(role: string, q: string) {
  const query = new URLSearchParams();
  if (role) query.set('role', role);
  if (q.trim()) query.set('q', q.trim());
  const suffix = query.toString();
  return useQuery({
    queryKey: ['clients', role, q],
    queryFn: () => api<ClientList>(`/api/clients${suffix ? `?${suffix}` : ''}`),
  });
}
function useClient(id: string | null) {
  return useQuery({
    queryKey: ['client', id],
    queryFn: () => api<ClientDetail>(`/api/clients/${id}`),
    enabled: !!id,
  });
}

export function ClientsPage() {
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const list = useClients(role, q);
  const data = list.data;

  const roleCount = (key: string) => data?.roles.find((r) => r.key === key)?.n ?? 0;

  const columns: Column<ClientRow>[] = [
    {
      key: 'name', header: 'Name', sortValue: (r) => r.legalName,
      render: (r) => (
        <div>
          <div className={styles.cellMain}>{r.legalName}</div>
          <div className={styles.cellSub}>
            {[r.shortName, r.country].filter(Boolean).join(' · ') || (r.kind ? titleCase(r.kind) : '—')}
          </div>
        </div>
      ),
    },
    {
      key: 'roles', header: 'Roles',
      render: (r) => r.roles.length
        ? <div className={styles.roleRow}>{r.roles.map((role) => <Badge key={role} color={roleColor(role)}>{titleCase(role)}</Badge>)}</div>
        : <span className={styles.cellSub}>—</span>,
    },
    { key: 'submissions', header: 'Submissions', align: 'right', sortValue: (r) => r.submissions, render: (r) => <span className={styles.num}>{r.submissions}</span> },
    { key: 'contracts', header: 'Contracts', align: 'right', sortValue: (r) => r.contracts, render: (r) => <span className={styles.num}>{r.contracts}</span> },
    { key: 'status', header: 'Status', align: 'right', render: (r) => r.status ? <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> : <span className={styles.cellSub}>—</span> },
  ];

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every counterparty in one place — cedents, brokers, reinsurers — with roles, contacts and their footprint across the book."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Clients' }]}
      />

      <div className={styles.kpis}>
        <KpiCard label="Clients" value={String(data?.clients.length ?? 0)} hint="Counterparties on file" icon={<Users size={20} />} accent="var(--primary)" loading={list.isLoading} />
        <KpiCard label="Cedents" value={String(roleCount('cedent'))} hint="Reinsureds" icon={<Building2 size={20} />} accent="var(--accent-cyan)" loading={list.isLoading} />
        <KpiCard label="Brokers" value={String(roleCount('broker'))} hint="Intermediaries" icon={<Handshake size={20} />} accent="var(--accent-violet)" loading={list.isLoading} />
        <KpiCard label="Reinsurers" value={String(roleCount('reinsurer'))} hint="Capacity providers" icon={<Shield size={20} />} accent="var(--accent-emerald)" loading={list.isLoading} />
      </div>

      <Card padded={false}>
        <CardHeader title="Directory" subtitle="Search and filter every counterparty by role" />
        <div className={styles.searchRow}>
          <div className={styles.searchWrap}>
            <Search size={15} className={styles.searchIcon} aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name…" className={styles.searchInput} />
          </div>
        </div>
        <div className={styles.filterBar}>
          <button
            className={`${styles.filterChip} ${role === '' ? styles.filterActive : ''}`}
            onClick={() => setRole('')}
          >
            All
            {data ? <span className={styles.filterCount}>{data.clients.length}</span> : null}
          </button>
          {(data?.roles ?? []).map((r) => (
            <button
              key={r.key}
              className={`${styles.filterChip} ${role === r.key ? styles.filterActive : ''}`}
              onClick={() => setRole(r.key)}
            >
              {titleCase(r.key)}
              <span className={styles.filterCount}>{r.n}</span>
            </button>
          ))}
        </div>
        <div className={styles.tableWrap}>
          <Table
            columns={columns}
            rows={data?.clients}
            loading={list.isLoading}
            rowKey={(r) => r.id}
            onRowClick={(r) => setDetailId(r.id)}
            empty={<EmptyState icon={<Users size={18} />} title="No clients" message="No counterparties match this search or role filter." />}
            skeletonRows={6}
          />
        </div>
      </Card>

      <ClientDrawer id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

/* ---------------- Client 360 drawer ---------------- */
function ClientDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: c, isLoading } = useClient(id);
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('party:write');

  const identifiers = c?.identifiers && typeof c.identifiers === 'object'
    ? Object.entries(c.identifiers).filter(([, v]) => v != null && v !== '')
    : [];

  return (
    <Drawer
      open={!!id} onClose={onClose} width={620}
      title={c ? <span className={styles.drawerTitle}><Building2 size={16} /> {c.legalName}</span> : 'Client'}
      subtitle={c ? [c.shortName, c.kind ? titleCase(c.kind) : null, c.country].filter(Boolean).join(' · ') || undefined : undefined}
    >
      {isLoading || !c ? <p className={styles.cellSub}>Loading…</p> : (
        <div className={styles.drawer}>
          {/* Header facts */}
          <Card padded>
            <div className={styles.facts}>
              <Fact label="Kind" value={c.kind ? titleCase(c.kind) : '—'} />
              <Fact label="Country" value={c.country ?? '—'} />
              <Fact label="Reference" value={c.reference ?? '—'} />
              <Fact label="Status" value={c.status ? <Badge color={statusColor(c.status)}>{titleCase(c.status)}</Badge> : '—'} />
            </div>
            {c.roles.length > 0 && (
              <div className={styles.roleRow} style={{ marginTop: 'var(--space-3)' }}>
                {c.roles.map((r) => <Badge key={r} color={roleColor(r)}>{titleCase(r)}</Badge>)}
              </div>
            )}
            {identifiers.length > 0 && (
              <div className={styles.idList}>
                {identifiers.map(([k, v]) => (
                  <span key={k} className={styles.idChip}>
                    <span className={styles.idKey}>{titleCase(k)}</span>
                    <span className={styles.idValue}>{String(v)}</span>
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* Contacts */}
          <ContactsCard clientId={c.id} contacts={c.contacts} canWrite={canWrite} />

          {/* Footprint — submissions */}
          <Card padded>
            <CardHeader title={<span className={styles.drawerTitle}><ScrollText size={15} /> Submissions</span>} subtitle="Underwriting pipeline involving this party" />
            {c.submissions.length === 0 ? (
              <p className={styles.cellSub}>No submissions on record.</p>
            ) : (
              <div className={styles.tableWrap}>
                <Table
                  columns={[
                    {
                      key: 'title', header: 'Submission',
                      render: (s: ClientSubmission) => (
                        <div>
                          <div className={styles.cellMain}>{s.title}</div>
                          <div className={styles.cellRef}>{s.reference}</div>
                        </div>
                      ),
                    },
                    { key: 'asRole', header: 'Role', render: (s: ClientSubmission) => s.asRole ? <Badge color={roleColor(s.asRole)}>{titleCase(s.asRole)}</Badge> : <span className={styles.cellSub}>—</span> },
                    { key: 'stage', header: 'Stage', render: (s: ClientSubmission) => <Badge color={statusColor(s.stage)}>{titleCase(s.stage)}</Badge> },
                    { key: 'premium', header: 'Premium', align: 'right', render: (s: ClientSubmission) => <span className={styles.num}>{money(s.estPremiumMinor, s.currency)}</span> },
                  ]}
                  rows={c.submissions}
                  rowKey={(s) => s.id}
                  onRowClick={(s) => navigate(`/underwriting?submission=${s.id}`)}
                  skeletonRows={2}
                />
              </div>
            )}
          </Card>

          {/* Footprint — contracts */}
          <Card padded>
            <CardHeader title={<span className={styles.drawerTitle}><FileText size={15} /> Contracts</span>} subtitle="Treaties & facultative placements" />
            {c.contracts.length === 0 ? (
              <p className={styles.cellSub}>No contracts on record.</p>
            ) : (
              <div className={styles.tableWrap}>
                <Table
                  columns={[
                    {
                      key: 'name', header: 'Contract',
                      render: (r: ClientContract) => (
                        <div>
                          <div className={styles.cellMain}>{r.name}</div>
                          <div className={styles.cellRef}>{r.reference}</div>
                        </div>
                      ),
                    },
                    { key: 'kind', header: 'Kind', render: (r: ClientContract) => <span className={styles.cellSub}>{r.contractKind ? titleCase(r.contractKind) : '—'}</span> },
                    { key: 'status', header: 'Status', render: (r: ClientContract) => r.status ? <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> : <span className={styles.cellSub}>—</span> },
                    { key: 'period', header: 'Period', align: 'right', render: (r: ClientContract) => <span className={styles.cellSub}>{r.periodStart ? new Date(r.periodStart).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</span> },
                  ]}
                  rows={c.contracts}
                  rowKey={(r) => r.id}
                  skeletonRows={2}
                />
              </div>
            )}
          </Card>

          {/* Footprint — claims */}
          <Card padded>
            <CardHeader title={<span className={styles.drawerTitle}><Flame size={15} /> Claims</span>} subtitle="Losses touching this party" />
            {c.claims.length === 0 ? (
              <p className={styles.cellSub}>No claims on record.</p>
            ) : (
              <div className={styles.tableWrap}>
                <Table
                  columns={[
                    {
                      key: 'desc', header: 'Claim',
                      render: (r: ClientClaim) => (
                        <div>
                          <div className={styles.cellMain}>{r.description ?? r.reference}</div>
                          <div className={styles.cellRef}>{r.reference}</div>
                        </div>
                      ),
                    },
                    { key: 'status', header: 'Status', render: (r: ClientClaim) => r.status ? <Badge color={statusColor(r.status)}>{titleCase(r.status)}</Badge> : <span className={styles.cellSub}>—</span> },
                    { key: 'gross', header: 'Gross loss', align: 'right', render: (r: ClientClaim) => <span className={styles.num}>{money(r.grossLossMinor, r.currency)}</span> },
                  ]}
                  rows={c.claims}
                  rowKey={(r) => r.id}
                  skeletonRows={2}
                />
              </div>
            )}
          </Card>

          {/* Communications */}
          <Card padded>
            <CardHeader title={<span className={styles.drawerTitle}><MessageSquare size={15} /> Communications</span>} subtitle="Recent correspondence" />
            {c.communications.length === 0 ? (
              <p className={styles.cellSub}>No communications logged.</p>
            ) : (
              <ul className={styles.commList}>
                {c.communications.map((m) => (
                  <li key={m.id} className={styles.commItem}>
                    <span className={styles.commKind} data-dir={m.direction ?? undefined}>{titleCase(m.kind)}</span>
                    <span className={styles.commSubject}>{m.subject || m.body || '—'}</span>
                    <span className={styles.commTime}>{new Date(m.createdAt).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </Drawer>
  );
}

/* ---------------- Contacts card with inline add form ---------------- */
function ContactsCard({ clientId, contacts, canWrite }: { clientId: string; contacts: Contact[]; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<string>('email');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');

  const add = useMutation({
    mutationFn: (body: { kind: string; value: string; label?: string }) =>
      api(`/api/clients/${clientId}/contacts`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      toast.success('Contact added');
      setValue(''); setLabel('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not add the contact'),
  });

  const submit = () => {
    if (!value.trim()) return;
    add.mutate({ kind, value: value.trim(), label: label.trim() || undefined });
  };

  return (
    <Card padded>
      <CardHeader title={<span className={styles.drawerTitle}><Mail size={15} /> Contacts</span>} subtitle="Emails, phones, addresses & portal users" />
      {contacts.length === 0 ? (
        <p className={styles.cellSub}>No contacts captured yet.</p>
      ) : (
        <ul className={styles.contactList}>
          {contacts.map((ct) => (
            <li key={ct.id} className={styles.contactItem}>
              <span className={styles.contactIcon} aria-hidden>{CONTACT_ICON[ct.kind] ?? <Mail size={13} />}</span>
              <div className={styles.contactMain}>
                <span className={styles.contactValue}>{ct.value}</span>
                {ct.label && <span className={styles.cellSub}>{ct.label}</span>}
              </div>
              {ct.isPrimary && <span className={styles.contactPrimary} title="Primary"><Star size={13} /></span>}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className={styles.addRow}>
          <FormField label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {CONTACT_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
            </Select>
          </FormField>
          <FormField label="Value">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. jane@cedent.com" />
          </FormField>
          <FormField label="Label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional" />
          </FormField>
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={!value.trim()} loading={add.isPending} onClick={submit}>Add</Button>
        </div>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue}>{value}</span>
    </div>
  );
}
