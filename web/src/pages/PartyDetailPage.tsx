import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FileText, Users, Phone, Mail, MapPin, Pencil, Plus, AlertCircle } from 'lucide-react';
import {
  useParty, useTreaties, useStatusColors, usePartyContacts,
  useAddPartyContact, usePartyClaims, useUpdateParty,
} from '../lib/queries';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Badge, StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { DefinitionList, ErrorState, PageLoader, SectionLabel } from '../components/Feedback';
import { FormField, FormSection, Input, Select, TextField } from '../components/Form';
import { formatDate, titleCase } from '../lib/format';
import { ApiError } from '../lib/api';
import type { TreatyListItem, PartyContact, PartyClaimRow } from '../lib/types';
import shared from './shared.module.css';
import styles from './PartyDetailPage.module.css';

// A treaty in this party's book, tagged with the party's role on it.
type BookRow = TreatyListItem & { partyRole: string };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

const money = (minor: number, ccy = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(minor / 100);

function claimStatusColor(s: string): 'green' | 'amber' | 'red' | 'slate' | 'indigo' {
  const u = s.toUpperCase();
  if (u === 'OPEN' || u === 'NOTIFIED') return 'amber';
  if (u === 'RESERVED' || u === 'ADVISED') return 'indigo';
  if (u === 'PAID' || u === 'SETTLED' || u === 'CLOSED') return 'green';
  if (u === 'DENIED') return 'red';
  return 'slate';
}

const CONTACT_ICONS: Record<string, React.ReactNode> = {
  email: <Mail size={13} />,
  phone: <Phone size={13} />,
  address: <MapPin size={13} />,
  portal_user: <Users size={13} />,
};

const PARTY_STATUSES = ['active', 'inactive', 'prospect', 'archived'];
const CONTACT_KINDS = ['email', 'phone', 'address', 'portal_user'] as const;

export function PartyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('party:write');
  const toast = useToast();

  const { data: party, isLoading, isError } = useParty(id);
  const asCedent = useTreaties({ cedentId: id });
  const asBroker = useTreaties({ brokerId: id });
  const treatyColors = useStatusColors('contract_status');
  const contactsQ = usePartyContacts(id);
  const claimsQ = usePartyClaims(id);

  const [tab, setTab] = useState('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);

  // Merge cedent and broker treaties into one book.
  const book = useMemo<BookRow[]>(() => {
    const byId = new Map<string, BookRow>();
    for (const t of asCedent.data?.treaties ?? []) byId.set(t.id, { ...t, partyRole: 'Cedent' });
    for (const t of asBroker.data?.treaties ?? []) {
      const existing = byId.get(t.id);
      if (existing) existing.partyRole = 'Cedent · Broker';
      else byId.set(t.id, { ...t, partyRole: 'Broker' });
    }
    return [...byId.values()];
  }, [asCedent.data, asBroker.data]);
  const bookLoading = asCedent.isLoading || asBroker.isLoading;

  if (isLoading) return <PageLoader label="Loading party…" />;
  if (isError || !party) {
    return (
      <Card>
        <ErrorState
          title="Party not found"
          action={<Button onClick={() => navigate('/parties')}>Back to parties</Button>}
        />
      </Card>
    );
  }

  const identifiers = party.identifiers ?? [];
  const contacts = contactsQ.data?.contacts ?? [];
  const claims = claimsQ.data?.claims ?? [];

  const isCedentOrBroker = party.roles?.some((r) =>
    ['cedent', 'broker', 'CEDENT', 'BROKER'].includes(r),
  );

  const tabDefs = [
    { id: 'overview', label: 'Overview' },
    { id: 'contacts', label: contacts.length ? `Contacts (${contacts.length})` : 'Contacts' },
    { id: 'roles', label: 'Roles' },
    { id: 'treaties', label: book.length ? `Treaties (${book.length})` : 'Treaties' },
    ...(isCedentOrBroker
      ? [{ id: 'claims', label: claims.length ? `Claims (${claims.length})` : 'Claims' }]
      : []),
  ];

  return (
    <>
      {/* ── Profile header ── */}
      <PageHeader
        crumbs={[{ label: 'Parties', to: '/parties' }, { label: party.legalName }]}
        title={party.legalName}
        description="Counterparty profile, roles, contacts and external identifiers."
        actions={
          canWrite ? (
            <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditOpen(true)}>
              Edit party
            </Button>
          ) : null
        }
      />

      <div className={styles.profile}>
        <span className={styles.avatar} aria-hidden>{initials(party.legalName)}</span>
        <div className={styles.identity}>
          <h2 className={styles.name}>{party.legalName}</h2>
          <div className={styles.meta}>
            <span className={shared.cellRef}>{party.reference ?? '-'}</span>
            <span className={styles.dot} aria-hidden />
            <span>{titleCase(party.kind)}</span>
            {party.country && (
              <>
                <span className={styles.dot} aria-hidden />
                <span>{party.country}</span>
              </>
            )}
          </div>
          {party.roles?.length ? (
            <div className={styles.chips}>
              {party.roles.map((r) => <Badge key={r} color="indigo">{titleCase(r)}</Badge>)}
            </div>
          ) : null}
        </div>
        <div className={styles.statusSlot}>
          <Badge
            color={party.status.toLowerCase() === 'active' ? 'green' : 'slate'}
            variant="outline"
          >
            {titleCase(party.status)}
          </Badge>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <Tabs tabs={tabDefs} active={tab} onChange={setTab} />
      </div>

      {/* ── Overview tab ── */}
      {tab === 'overview' && (
        <div className={styles.cols}>
          <Card>
            <CardHeader title="Overview" subtitle="Core registration details for this counterparty." />
            <DefinitionList
              items={[
                { term: 'Legal name', value: party.legalName },
                { term: 'Short name', value: party.shortName ?? '-' },
                { term: 'Kind', value: titleCase(party.kind) },
                { term: 'Country', value: party.country ?? '-' },
                {
                  term: 'Status',
                  value: (
                    <Badge color={party.status.toLowerCase() === 'active' ? 'green' : 'slate'}>
                      {titleCase(party.status)}
                    </Badge>
                  ),
                },
              ]}
            />
            <div style={{ marginTop: 'var(--space-5)' }}>
              <SectionLabel>Identifiers</SectionLabel>
              {identifiers.length === 0 ? (
                <p className={shared.cellSub}>No external identifiers recorded.</p>
              ) : (
                <DefinitionList
                  items={identifiers.map((idn) => ({
                    term: titleCase(String(idn.scheme ?? 'Identifier')),
                    value: <span className={shared.cellRef}>{String(idn.value ?? '-')}</span>,
                  }))}
                />
              )}
            </div>
          </Card>

          <div>
            <DocumentsPanel entityType="party" entityId={id!} />
          </div>
        </div>
      )}

      {/* ── Contacts tab ── */}
      {tab === 'contacts' && (
        <Card padded>
          <CardHeader
            title="Contacts"
            subtitle="Email, phone, and address records for this counterparty."
            actions={
              canWrite ? (
                <Button
                  size="sm"
                  variant="subtle"
                  icon={<Plus size={14} />}
                  onClick={() => setAddContactOpen(true)}
                >
                  Add contact
                </Button>
              ) : undefined
            }
          />

          {contactsQ.isLoading ? (
            <p className={shared.cellSub} style={{ marginTop: 'var(--space-3)' }}>Loading contacts…</p>
          ) : contacts.length === 0 ? (
            <EmptyState
              title="No contacts"
              message="Add an email, phone number or address for this party."
              icon={<Users size={16} />}
            />
          ) : (
            <ul className={styles.contactList}>
              {contacts.map((c) => (
                <ContactRow key={c.id} contact={c} />
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ── Roles tab ── */}
      {tab === 'roles' && (
        <Card padded>
          <CardHeader title="Roles" subtitle="How this party participates in the market." />
          {party.roles?.length ? (
            <div className={shared.checkGroup} style={{ marginTop: 'var(--space-3)' }}>
              {party.roles.map((r) => (
                <Badge key={r} color="indigo" variant="outline">
                  {titleCase(r)}
                </Badge>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No roles"
              message="No roles have been assigned to this party yet."
              icon={<Users size={16} />}
            />
          )}
        </Card>
      )}

      {/* ── Treaties tab ── */}
      {tab === 'treaties' && (
        <Card padded={false}>
          <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
            <div>
              <SectionLabel>Contracts</SectionLabel>
              <p className={shared.cellSub}>Treaties where this party is the cedent or placing broker.</p>
            </div>
            <div className={shared.spacer} />
            <span className={shared.cellSub}>
              {book.length} contract{book.length === 1 ? '' : 's'}
            </span>
          </div>
          <Table
            columns={bookColumns(treatyColors)}
            rows={book}
            loading={bookLoading}
            rowKey={(t) => t.id}
            onRowClick={(t) => navigate(`/treaties/${t.id}`)}
            empty={
              <EmptyState
                title="No contracts"
                message="This party is not a counterparty on any treaty yet."
                icon={<FileText size={16} />}
              />
            }
          />
        </Card>
      )}

      {/* ── Claims tab ── */}
      {tab === 'claims' && (
        <Card padded={false}>
          <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
            <div>
              <SectionLabel>Claims</SectionLabel>
              <p className={shared.cellSub}>Claims on treaties where this party is cedent or broker.</p>
            </div>
            <div className={shared.spacer} />
            <span className={shared.cellSub}>
              {claims.length} claim{claims.length === 1 ? '' : 's'}
            </span>
          </div>
          <Table
            columns={claimColumns()}
            rows={claimsQ.data ? claims : undefined}
            loading={claimsQ.isLoading}
            rowKey={(c) => c.id}
            onRowClick={(c) => navigate(`/claims/${c.id}`)}
            empty={
              <EmptyState
                title="No claims"
                message="No claims are linked to this party's treaties."
                icon={<AlertCircle size={16} />}
              />
            }
          />
        </Card>
      )}

      {/* ── Modals ── */}
      {canWrite && (
        <EditPartyModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          party={party}
          onDone={() => toast.success('Party updated')}
        />
      )}

      {canWrite && id && (
        <AddContactModal
          open={addContactOpen}
          onClose={() => setAddContactOpen(false)}
          partyId={id}
        />
      )}
    </>
  );
}

/* ── Contact row ── */
function ContactRow({ contact }: { contact: PartyContact }) {
  return (
    <li className={styles.contactItem}>
      <span className={styles.contactIcon}>{CONTACT_ICONS[contact.kind] ?? <Mail size={13} />}</span>
      <div className={styles.contactBody}>
        <span className={styles.contactValue}>{contact.value}</span>
        {contact.label && <span className={shared.cellSub}>{contact.label}</span>}
      </div>
      <div className={styles.contactMeta}>
        <Badge color="slate" variant="outline">{titleCase(contact.kind.replace('_', ' '))}</Badge>
        {contact.isPrimary && <Badge color="green">Primary</Badge>}
      </div>
    </li>
  );
}

/* ── Treaty columns ── */
function bookColumns(statusColors: Record<string, string>): Column<BookRow>[] {
  return [
    {
      key: 'reference',
      header: 'Reference',
      sortValue: (t) => t.reference,
      render: (t) => <span className={shared.cellRef}>{t.reference}</span>,
    },
    {
      key: 'name',
      header: 'Treaty',
      sortValue: (t) => t.name,
      render: (t) => (
        <div>
          <div className={shared.cellMain}>{t.name}</div>
          <div className={shared.cellSub}>
            {[t.contractKind, t.lineOfBusiness].filter(Boolean).map(titleCase).join(' · ') || '—'}
          </div>
        </div>
      ),
    },
    {
      key: 'partyRole',
      header: 'Role',
      sortValue: (t) => t.partyRole,
      render: (t) => <Badge color="indigo" variant="outline">{t.partyRole}</Badge>,
    },
    {
      key: 'period',
      header: 'Period',
      sortValue: (t) => t.periodStart ?? '',
      render: (t) =>
        t.periodStart ? `${formatDate(t.periodStart)} – ${formatDate(t.periodEnd)}` : '—',
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      sortValue: (t) => t.status,
      render: (t) => <StatusPill status={t.status} metaColors={statusColors} />,
    },
  ];
}

/* ── Claims columns ── */
function claimColumns(): Column<PartyClaimRow>[] {
  return [
    {
      key: 'reference',
      header: 'Reference',
      sortValue: (c) => c.reference ?? '',
      render: (c) => <span className={shared.cellRef}>{c.reference ?? '-'}</span>,
    },
    {
      key: 'contract',
      header: 'Treaty',
      sortValue: (c) => c.contractName,
      render: (c) => (
        <div>
          <div className={shared.cellMain}>{c.contractName}</div>
          {c.contractRef && <div className={shared.cellSub}>{c.contractRef}</div>}
        </div>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      render: (c) => <span className={shared.cellSub}>{c.description ?? '-'}</span>,
    },
    {
      key: 'lossDate',
      header: 'Loss date',
      sortValue: (c) => c.lossDate ?? '',
      render: (c) => (c.lossDate ? formatDate(c.lossDate) : '-'),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      align: 'right',
      sortValue: (c) => c.outstandingMinor,
      render: (c) => money(c.outstandingMinor, c.currency),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      sortValue: (c) => c.status,
      render: (c) => <Badge color={claimStatusColor(c.status)}>{titleCase(c.status)}</Badge>,
    },
  ];
}

/* ── Edit party modal ── */
function EditPartyModal({
  open, onClose, party, onDone,
}: {
  open: boolean;
  onClose: () => void;
  party: { id: string; legalName: string; shortName: string | null; country: string | null; status: string };
  onDone: () => void;
}) {
  const toast = useToast();
  const update = useUpdateParty(party.id);

  const [legalName, setLegalName] = useState(party.legalName);
  const [shortName, setShortName] = useState(party.shortName ?? '');
  const [country, setCountry] = useState(party.country ?? '');
  const [status, setStatus] = useState(party.status.toLowerCase());
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLegalName(party.legalName);
    setShortName(party.shortName ?? '');
    setCountry(party.country ?? '');
    setStatus(party.status.toLowerCase());
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({
        legalName: legalName.trim() || undefined,
        shortName: shortName.trim() || null,
        country: country.trim().toUpperCase() || null,
        status,
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save changes.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="md"
      title="Edit party"
      description={party.legalName}
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!legalName.trim()}
            onClick={submit}
          >
            Save changes
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormSection title="Identification">
          <div style={{ gridColumn: '1 / -1' }}>
            <TextField label="Legal name" value={legalName} onChange={setLegalName} required />
          </div>
          <TextField
            label="Short name"
            value={shortName}
            onChange={setShortName}
            placeholder="Display name in lists"
          />
          <FormField label="Country" hint="ISO 3166-1 alpha-2, e.g. GB, US.">
            <Input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="GB"
              maxLength={2}
              style={{ textTransform: 'uppercase' }}
            />
          </FormField>
        </FormSection>

        <FormField label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {PARTY_STATUSES.map((s) => (
              <option key={s} value={s}>{titleCase(s)}</option>
            ))}
          </Select>
        </FormField>

        {error && (
          <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/* ── Add contact modal ── */
function AddContactModal({
  open, onClose, partyId,
}: {
  open: boolean;
  onClose: () => void;
  partyId: string;
}) {
  const toast = useToast();
  const add = useAddPartyContact(partyId);

  const [kind, setKind] = useState<string>('email');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setKind('email'); setValue(''); setLabel(''); setIsPrimary(false); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await add.mutateAsync({
        kind,
        value: value.trim(),
        label: label.trim() || undefined,
        isPrimary,
      });
      toast.success('Contact added');
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add contact.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      size="sm"
      title="Add contact"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={!value.trim()} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {CONTACT_KINDS.map((k) => (
              <option key={k} value={k}>{titleCase(k.replace('_', ' '))}</option>
            ))}
          </Select>
        </FormField>
        <TextField
          label="Value"
          value={value}
          onChange={setValue}
          required
          placeholder="e.g. ops@example.com"
        />
        <TextField label="Label" value={label} onChange={setLabel} placeholder="e.g. Operations" />
        <label
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'center',
            fontSize: 'var(--text-sm)',
            cursor: 'pointer',
          }}
        >
          <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
          Mark as primary
        </label>
        {error && (
          <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
