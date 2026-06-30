/**
 * Security & resilience (brief §14, §15, §19): SOC feed, KMS keys + crypto demo,
 * backup/DR catalog, localization bundles, and SAML SP metadata. Read-focused
 * with the privileged actions gated by permission.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Select, Input } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatDateTime, formatNumber, titleCase } from '../lib/format';
import { Shield, Activity, KeyRound, DatabaseBackup, Languages, Building2, Info } from 'lucide-react';
import shared from './shared.module.css';
import styles from './SecurityOpsPage.module.css';

const SOC_ACCENTS = ['var(--primary)', 'var(--accent-violet)', 'var(--accent-cyan)', 'var(--accent-orange)'];

export function SecurityOpsPage() {
  const [tab, setTab] = useState('soc');
  return (
    <>
      <PageHeader
        title="Security & resilience"
        description="Security monitoring, key management, backups, localization and SAML."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Security & resilience' }]}
      />
      <Card padded={false}>
        <Tabs
          tabs={[{ id: 'soc', label: 'Security feed' }, { id: 'kms', label: 'Key management' }, { id: 'backup', label: 'Backup & DR' }, { id: 'i18n', label: 'Localization' }, { id: 'saml', label: 'SAML' }]}
          active={tab}
          onChange={setTab}
        />
        <div className={styles.tabBody}>
          {tab === 'soc' && <Soc />}
          {tab === 'kms' && <Kms />}
          {tab === 'backup' && <Backup />}
          {tab === 'i18n' && <I18n />}
          {tab === 'saml' && <Saml />}
        </div>
      </Card>
    </>
  );
}

interface SocEvent { id: string; occurredAt: string; actor?: string | null; action: string; entityType: string }
function Soc() {
  const q = useQuery({ queryKey: ['soc-events'], queryFn: () => api<{ events: SocEvent[]; byAction: { action: string; n: number }[] }>('/api/soc/events') });
  if (q.isLoading) return <PageLoader label="Loading security feed…" />;
  return (
    <div className={styles.section}>
      <div className={styles.kpiRow}>
        {(q.data?.byAction ?? []).slice(0, 4).map((a, i) => (
          <KpiCard key={a.action} label={titleCase(a.action.replace(/_/g, ' '))} value={formatNumber(a.n)} accent={SOC_ACCENTS[i % SOC_ACCENTS.length]} icon={<Shield size={20} />} />
        ))}
      </div>
      <Card padded={false}>
        <CardHeader title="Security feed" subtitle="Recent security-relevant activity from the audit trail." />
        <Table
          columns={[
            { key: 'ts', header: 'When', render: (e: SocEvent) => formatDateTime(e.occurredAt) },
            { key: 'actor', header: 'Actor', render: (e: SocEvent) => e.actor ?? '-' },
            { key: 'action', header: 'Action', render: (e: SocEvent) => <Badge color="slate">{e.action}</Badge> },
            { key: 'entity', header: 'Entity', align: 'right', render: (e: SocEvent) => <span className={shared.cellRef}>{e.entityType}</span> },
          ]}
          rows={q.data?.events}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No events" message="No security-relevant activity recorded." icon={<Activity size={16} />} />}
        />
      </Card>
    </div>
  );
}

interface KmsKey { id: string; alias: string; version: number; algorithm: string; status: string; createdAt: string }
function Kms() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const admin = hasPermission('admin:manage');
  const q = useQuery({ queryKey: ['kms-keys'], queryFn: () => api<{ keys: KmsKey[] }>('/api/kms/keys'), enabled: admin });
  const [alias, setAlias] = useState('app-pii');
  const [plain, setPlain] = useState('account-12345');
  const [cipher, setCipher] = useState('');
  const [round, setRound] = useState('');

  const create = useMutation({ mutationFn: () => api('/api/kms/keys', { body: { alias } }), onSuccess: () => { toast.success('Key created'); qc.invalidateQueries({ queryKey: ['kms-keys'] }); }, onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Failed') });
  const enc = useMutation({ mutationFn: () => api<{ ciphertext: string }>('/api/kms/encrypt', { body: { alias, data: plain } }), onSuccess: (r) => setCipher(r.ciphertext), onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Failed') });
  const dec = useMutation({ mutationFn: () => api<{ plaintext: string }>('/api/kms/decrypt', { body: { alias, data: cipher } }), onSuccess: (r) => setRound(r.plaintext), onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Failed') });

  if (!admin) return <EmptyState title="Restricted" message="Key management requires the admin:manage permission." />;
  if (q.isLoading) return <PageLoader label="Loading keys…" />;

  return (
    <div className={styles.sectionWide}>
      <Card padded={false}>
        <CardHeader title="Data keys" subtitle="Envelope-encryption keys managed by the KMS, with version and status." />
        <Table
          columns={[
            { key: 'alias', header: 'Alias', render: (k: KmsKey) => <span className={shared.cellMain}>{k.alias}</span> },
            { key: 'v', header: 'Version', align: 'right', render: (k: KmsKey) => `v${k.version}` },
            { key: 'algo', header: 'Algorithm', render: (k: KmsKey) => <span className={shared.cellRef}>{k.algorithm}</span> },
            { key: 'status', header: 'Status', align: 'right', render: (k: KmsKey) => <Badge color={k.status === 'active' ? 'green' : 'gray'}>{titleCase(k.status)}</Badge> },
          ]}
          rows={q.data?.keys}
          rowKey={(k) => k.id}
          empty={<EmptyState title="No keys" message="No KMS keys yet." icon={<KeyRound size={16} />} />}
        />
      </Card>
      <Card>
        <CardHeader title="Envelope crypto demo" subtitle="Encrypt then decrypt with an alias's data key (AES-256-GCM)." />
        <div className={styles.cryptoForm}>
          <div className={styles.rowEnd}>
            <div className={styles.grow}><FormField label="Alias"><Input value={alias} onChange={(e) => setAlias(e.target.value)} /></FormField></div>
            <Button variant="ghost" onClick={() => create.mutate()} loading={create.isPending}>Create key</Button>
          </div>
          <FormField label="Plaintext"><Input value={plain} onChange={(e) => setPlain(e.target.value)} /></FormField>
          <div className={styles.btnRow}>
            <Button variant="primary" onClick={() => enc.mutate()} loading={enc.isPending}>Encrypt</Button>
            <Button variant="ghost" onClick={() => dec.mutate()} loading={dec.isPending} disabled={!cipher}>Decrypt</Button>
          </div>
          {cipher && <p className={`${shared.cellSub} ${styles.cipherText}`}>cipher: {cipher}</p>}
          {round && <p className={shared.cellSub}>decrypted: <strong>{round}</strong></p>}
        </div>
      </Card>
    </div>
  );
}

interface BackupRun { id: string; kind: string; status: string; location?: string | null; sizeBytes?: number | null; note?: string | null; startedAt: string }
function Backup() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = hasPermission('ops:write');
  const q = useQuery({ queryKey: ['backup-runs'], queryFn: () => api<{ runs: BackupRun[] }>('/api/backup/runs') });
  const run = useMutation({ mutationFn: (kind: string) => api('/api/backup/runs', { body: { kind } }), onSuccess: () => { toast.success('Backup recorded'); qc.invalidateQueries({ queryKey: ['backup-runs'] }); }, onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Failed') });
  if (q.isLoading) return <PageLoader label="Loading backups…" />;
  return (
    <div className={styles.section}>
      <Card padded={false}>
        <CardHeader
          title="Backup & DR runs"
          subtitle="Snapshot and disaster-recovery history for the tenant database."
          actions={canWrite ? <Button variant="primary" onClick={() => run.mutate('snapshot')} loading={run.isPending}>Take snapshot</Button> : undefined}
        />
        <Table
          columns={[
            { key: 'kind', header: 'Kind', render: (r: BackupRun) => <Badge color="slate">{titleCase(r.kind)}</Badge> },
            { key: 'status', header: 'Status', render: (r: BackupRun) => <Badge color={r.status === 'completed' ? 'green' : r.status === 'failed' ? 'red' : 'amber'}>{titleCase(r.status)}</Badge> },
            { key: 'loc', header: 'Location', render: (r: BackupRun) => <span className={shared.cellRef}>{r.location ?? '-'}</span> },
            { key: 'size', header: 'Size', align: 'right', render: (r: BackupRun) => r.sizeBytes ? `${(r.sizeBytes / 1048576).toFixed(0)} MB` : '-' },
            { key: 'when', header: 'Started', align: 'right', render: (r: BackupRun) => formatDateTime(r.startedAt) },
          ]}
          rows={q.data?.runs}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No backups" message="No backup runs recorded." icon={<DatabaseBackup size={16} />} />}
        />
      </Card>
    </div>
  );
}

interface Locale { locale: string; messages: number; direction: string }
function I18n() {
  const locales = useQuery({ queryKey: ['i18n-locales'], queryFn: () => api<{ locales: Locale[] }>('/api/i18n/locales') });
  const [locale, setLocale] = useState('fr-FR');
  const bundle = useQuery({ queryKey: ['i18n-bundle', locale], queryFn: () => api<{ direction: string; bundle: Record<string, string> }>(`/api/i18n/bundle${qs({ locale })}`) });
  if (locales.isLoading) return <PageLoader label="Loading locales…" />;
  return (
    <div className={styles.section}>
      <div className={styles.localeToolbar}>
        <div className={styles.localeField}>
          <FormField label="Locale">
            <Select value={locale} onChange={(e) => setLocale(e.target.value)}>
              {locales.data?.locales.map((l) => <option key={l.locale} value={l.locale}>{l.locale} ({l.direction})</option>)}
            </Select>
          </FormField>
        </div>
        {bundle.data && <Badge color={bundle.data.direction === 'rtl' ? 'violet' : 'slate'}>{bundle.data.direction.toUpperCase()}</Badge>}
      </div>
      <Card padded={false}>
        <CardHeader title="Message bundle" subtitle="Localized UI strings served for the selected locale." />
        <Table
          columns={[
            { key: 'k', header: 'Key', render: (e: [string, string]) => <span className={shared.cellRef}>{e[0]}</span> },
            { key: 'v', header: 'Message', render: (e: [string, string]) => <span dir={bundle.data?.direction}>{e[1]}</span> },
          ]}
          rows={Object.entries(bundle.data?.bundle ?? {})}
          rowKey={(e) => e[0]}
          empty={<EmptyState title="No messages" message="No messages for this locale." icon={<Languages size={16} />} />}
        />
      </Card>
    </div>
  );
}

interface SamlProvider { id: string; key: string; name: string; issuer?: string | null; enabled: boolean }
function Saml() {
  const { hasPermission } = useAuth();
  const admin = hasPermission('admin:manage');
  const providers = useQuery({ queryKey: ['saml-providers'], queryFn: () => api<{ providers: SamlProvider[] }>('/api/auth/saml/providers'), enabled: admin });
  return (
    <div className={styles.section}>
      <p className={styles.intro}>
        <Info size={16} aria-hidden />
        <span>Register RIOS with your IdP using the SP metadata at <span className={shared.cellRef}>/api/auth/saml/metadata</span>. Provider config is managed via SSO settings.</span>
      </p>
      {admin && (
        <Card padded={false}>
          <CardHeader title="Identity providers" subtitle="SAML identity providers configured for single sign-on." />
          <Table
            columns={[
              { key: 'name', header: 'Provider', render: (p: SamlProvider) => <span className={shared.cellMain}>{p.name}</span> },
              { key: 'issuer', header: 'Issuer', render: (p: SamlProvider) => <span className={shared.cellRef}>{p.issuer ?? '-'}</span> },
              { key: 'enabled', header: 'Status', align: 'right', render: (p: SamlProvider) => <Badge color={p.enabled ? 'green' : 'gray'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge> },
            ]}
            rows={providers.data?.providers}
            rowKey={(p) => p.id}
            empty={<EmptyState title="No SAML providers" message="No SAML identity providers configured." icon={<Building2 size={16} />} />}
          />
        </Card>
      )}
    </div>
  );
}
