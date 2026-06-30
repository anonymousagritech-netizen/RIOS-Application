/**
 * Data retention & legal hold (brief §14). Lists retention policies and legal
 * holds, lets an authorised user place/release holds, and evaluates a record's
 * disposition (a hold always overrides the policy). Authoring is gated on
 * retention:write.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { FormField, Select, Input } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatNumber, formatDate, titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Policy { id: string; entityType: string; retentionDays: number; action: string; active: boolean; note?: string | null }
interface Hold { id: string; name: string; reason?: string | null; entityType?: string | null; entityId?: string | null; active: boolean; placedAt?: string | null; releasedAt?: string | null }
interface Verdict { ageDays: number; retentionDays: number; onHold: boolean; eligible: boolean; reason: string }

const REASON_COLOR: Record<string, 'green' | 'amber' | 'red'> = { eligible: 'green', within_retention: 'amber', legal_hold: 'red' };

export function RetentionPage() {
  const [tab, setTab] = useState('policies');
  return (
    <>
      <PageHeader title="Retention & legal hold" description="How long records are kept, and which are frozen under legal hold — a hold always overrides a policy." />
      <Card>
        <Tabs tabs={[{ id: 'policies', label: 'Policies' }, { id: 'holds', label: 'Legal holds' }, { id: 'evaluate', label: 'Evaluate' }]} active={tab} onChange={setTab} />
        <div style={{ padding: 'var(--space-5)' }}>
          {tab === 'policies' && <Policies />}
          {tab === 'holds' && <Holds />}
          {tab === 'evaluate' && <Evaluate />}
        </div>
      </Card>
    </>
  );
}

function Policies() {
  const q = useQuery({ queryKey: ['retention-policies'], queryFn: () => api<{ policies: Policy[] }>('/api/retention/policies') });
  if (q.isLoading) return <PageLoader label="Loading policies…" />;
  const years = (d: number) => `${formatNumber(d)} d (${(d / 365).toFixed(1)} yr)`;
  const cols: Column<Policy>[] = [
    { key: 'entity', header: 'Entity type', render: (p) => <span className={shared.cellMain}>{titleCase(p.entityType)}</span> },
    { key: 'retention', header: 'Retention', align: 'right', render: (p) => years(p.retentionDays) },
    { key: 'action', header: 'On expiry', render: (p) => <Badge color={p.action === 'purge' ? 'red' : 'slate'}>{titleCase(p.action)}</Badge> },
    { key: 'active', header: 'Active', render: (p) => <Badge color={p.active ? 'green' : 'gray'}>{p.active ? 'Active' : 'Inactive'}</Badge> },
    { key: 'note', header: 'Note', render: (p) => <span className={shared.cellSub}>{p.note ?? '—'}</span> },
  ];
  return <Table columns={cols} rows={q.data?.policies} rowKey={(p) => p.id} empty={<EmptyState title="No policies" message="No retention policies defined." />} />;
}

function Holds() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canWrite = hasPermission('retention:write');
  const q = useQuery({ queryKey: ['retention-holds'], queryFn: () => api<{ holds: Hold[] }>('/api/retention/holds') });
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('');

  const place = useMutation({
    mutationFn: () => api('/api/retention/holds', { body: { name: name.trim(), entityType: entityType || null } }),
    onSuccess: () => { toast.success('Legal hold placed'); setName(''); setEntityType(''); qc.invalidateQueries({ queryKey: ['retention-holds'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not place hold'),
  });
  const release = useMutation({
    mutationFn: (id: string) => api(`/api/retention/holds/${id}/release`, { body: {} }),
    onSuccess: () => { toast.success('Hold released'); qc.invalidateQueries({ queryKey: ['retention-holds'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not release hold'),
  });

  if (q.isLoading) return <PageLoader label="Loading holds…" />;
  const cols: Column<Hold>[] = [
    { key: 'name', header: 'Hold', render: (h) => <span className={shared.cellMain}>{h.name}</span> },
    { key: 'scope', header: 'Scope', render: (h) => h.entityType ? titleCase(h.entityType) : 'Global' },
    { key: 'reason', header: 'Reason', render: (h) => <span className={shared.cellSub}>{h.reason ?? '—'}</span> },
    { key: 'placed', header: 'Placed', render: (h) => formatDate(h.placedAt) },
    { key: 'status', header: 'Status', render: (h) => <Badge color={h.active ? 'red' : 'gray'}>{h.active ? 'Active' : 'Released'}</Badge> },
    {
      key: 'act', header: '', align: 'right',
      render: (h) => h.active && canWrite ? <Button variant="ghost" onClick={() => release.mutate(h.id)} loading={release.isPending}>Release</Button> : null,
    },
  ];
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <Table columns={cols} rows={q.data?.holds} rowKey={(h) => h.id} empty={<EmptyState title="No holds" message="No legal holds in place." />} />
      {canWrite && (
        <Card>
          <CardHeader title="Place a legal hold" subtitle="Freeze disposal of records under litigation or investigation." />
          <div style={{ padding: 'var(--space-5)', display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 240 }}><FormField label="Hold name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Windstorm litigation" /></FormField></div>
            <div style={{ minWidth: 180 }}>
              <FormField label="Scope">
                <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
                  <option value="">Global (all types)</option>
                  <option value="claim">Claim</option>
                  <option value="statement">Statement</option>
                  <option value="contract">Contract</option>
                  <option value="party">Party</option>
                </Select>
              </FormField>
            </div>
            <Button variant="primary" onClick={() => place.mutate()} loading={place.isPending} disabled={name.trim().length < 2}>Place hold</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Evaluate() {
  const [entityType, setEntityType] = useState('claim');
  const [recordedAt, setRecordedAt] = useState('2014-01-01');
  const [result, setResult] = useState<{ hasPolicy: boolean; action?: string; verdict: Verdict | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ hasPolicy: boolean; action?: string; verdict: Verdict | null }>(
        '/api/retention/evaluate', { body: { entityType, recordedAt: new Date(recordedAt).toISOString() } },
      );
      setResult(r);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 560 }}>
      <p className={shared.cellSub}>Check whether a record may be disposed of, given its age, the entity policy and any active legal hold.</p>
      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 180 }}>
          <FormField label="Entity type">
            <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="claim">Claim</option>
              <option value="statement">Statement</option>
              <option value="notification">Notification</option>
              <option value="audit_log">Audit log</option>
            </Select>
          </FormField>
        </div>
        <div style={{ minWidth: 180 }}><FormField label="Record date"><Input type="date" value={recordedAt} onChange={(e) => setRecordedAt(e.target.value)} /></FormField></div>
        <Button variant="primary" onClick={run} loading={busy}>Evaluate</Button>
      </div>
      {result && (result.hasPolicy && result.verdict ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <div>
            <Badge color={result.verdict.eligible ? 'green' : REASON_COLOR[result.verdict.reason] ?? 'slate'}>
              {result.verdict.eligible ? `Eligible to ${result.action}` : titleCase(result.verdict.reason.replace('_', ' '))}
            </Badge>
          </div>
          <p className={shared.cellSub}>Age {formatNumber(result.verdict.ageDays)} days vs retention {formatNumber(result.verdict.retentionDays)} days{result.verdict.onHold ? ' · under legal hold' : ''}.</p>
        </div>
      ) : (
        <EmptyState title="No policy" message={`No active retention policy for “${entityType}”.`} />
      ))}
    </div>
  );
}
