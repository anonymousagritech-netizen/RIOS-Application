/**
 * Bureau / ACORD connector (brief §7, §28 - London-market connectivity). Builds
 * ACORD EBOT (technical accounting) messages from statements of account and ECOT
 * (claim movement) messages from claims, drives them through the loopback
 * connector (BUILT -> SENT -> ACKNOWLEDGED with an inbound echo), and lets you
 * inspect the canonical envelope. The transport is the labelled integration seam
 * for a real DXC / Lloyd's-Velonetic gateway. Building/sending needs
 * accounting:post.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { FormField, Select } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatMoney, formatDate } from '../lib/format';
import { Radio, Send, Inbox, CheckCircle2 } from 'lucide-react';

interface BureauMessage {
  id: string; direction: 'OUTBOUND' | 'INBOUND'; messageType: 'EBOT' | 'ECOT';
  uti: string; umr?: string | null; status: string; externalRef?: string | null;
  connector: string; statementId?: string | null; claimId?: string | null;
  errors?: string | null; createdAt: string;
}
interface StatementSource { id: string; reference?: string | null; currency: string; balanceMinor: number; status: string }
interface ClaimSource { id: string; reference?: string | null; currency: string; paidMinor: number; outstandingMinor: number; status: string }

import type { TokenColor } from '../lib/status';

const STATUS_COLOR: Record<string, TokenColor> = {
  BUILT: 'blue', SENT: 'amber', ACKNOWLEDGED: 'green', RECEIVED: 'green', REJECTED: 'red',
};

export function BureauPage() {
  const { hasPermission } = useAuth();
  const qc = useQueryClient();
  const canPost = hasPermission('accounting:post');
  const [envelope, setEnvelope] = useState<unknown | null>(null);
  const [statementId, setStatementId] = useState('');
  const [claimId, setClaimId] = useState('');

  const messagesQ = useQuery({
    queryKey: ['bureau', 'messages'],
    queryFn: () => api<{ messages: BureauMessage[]; connector: string }>('/api/bureau/messages'),
  });
  const sourcesQ = useQuery({
    queryKey: ['bureau', 'sources'],
    queryFn: () => api<{ statements: StatementSource[]; claims: ClaimSource[] }>('/api/bureau/sources'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['bureau'] });

  const buildEbot = useMutation({
    mutationFn: () => api('/api/bureau/ebot', { method: 'POST', body: { statementId } }),
    onSuccess: (r: any) => { setEnvelope(r.envelope); invalidate(); },
  });
  const buildEcot = useMutation({
    mutationFn: () => api('/api/bureau/ecot', { method: 'POST', body: { claimId } }),
    onSuccess: (r: any) => { setEnvelope(r.envelope); invalidate(); },
  });
  const sendMsg = useMutation({
    mutationFn: (id: string) => api(`/api/bureau/${id}/send`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const poll = useMutation({
    mutationFn: () => api('/api/bureau/poll', { method: 'POST' }),
    onSuccess: invalidate,
  });
  const viewMsg = useMutation({
    mutationFn: (id: string) => api<{ payload: unknown }>(`/api/bureau/messages/${id}`),
    onSuccess: (r) => setEnvelope(r.payload),
  });

  if (messagesQ.isLoading) return <PageLoader />;
  const messages = messagesQ.data?.messages ?? [];
  const acknowledged = messages.filter((m) => m.status === 'ACKNOWLEDGED').length;
  const inbound = messages.filter((m) => m.direction === 'INBOUND').length;
  const statements = sourcesQ.data?.statements ?? [];
  const claims = sourcesQ.data?.claims ?? [];

  const columns: Column<BureauMessage>[] = [
    { key: 'messageType', header: 'Type', render: (m) => <Badge color="gray">{m.messageType}</Badge> },
    { key: 'direction', header: 'Direction', render: (m) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {m.direction === 'OUTBOUND' ? <Send size={13} /> : <Inbox size={13} />}{m.direction}
      </span>
    ) },
    { key: 'uti', header: 'UTI', render: (m) => m.uti },
    { key: 'umr', header: 'UMR', render: (m) => m.umr ?? '—' },
    { key: 'status', header: 'Status', render: (m) => <Badge color={STATUS_COLOR[m.status] ?? 'gray'}>{m.status}</Badge> },
    { key: 'externalRef', header: 'Bureau ref', render: (m) => m.externalRef ?? '—' },
    { key: 'createdAt', header: 'Created', render: (m) => formatDate(m.createdAt) },
    { key: 'actions', header: '', render: (m) => (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        <Button size="sm" variant="ghost" onClick={() => viewMsg.mutate(m.id)}>View</Button>
        {canPost && m.direction === 'OUTBOUND' && m.status === 'BUILT' && (
          <Button size="sm" variant="secondary" onClick={() => sendMsg.mutate(m.id)} disabled={sendMsg.isPending}>Send</Button>
        )}
      </span>
    ) },
  ];

  return (
    <>
      <PageHeader
        title="Bureau / ACORD"
        description="EBOT technical-accounting and ECOT claim messages exchanged with the London-market bureau network."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Bureau / ACORD' }]}
        actions={canPost ? (
          <Button onClick={() => poll.mutate()} disabled={poll.isPending} icon={<Inbox size={15} />}>
            Poll bureau
          </Button>
        ) : undefined}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        <KpiCard label="Messages" value={String(messages.length)} icon={<Radio size={18} />} />
        <KpiCard label="Acknowledged" value={String(acknowledged)} icon={<CheckCircle2 size={18} />} />
        <KpiCard label="Inbound echoes" value={String(inbound)} icon={<Inbox size={18} />} />
        <KpiCard label="Connector" value={messagesQ.data?.connector ?? 'LOOPBACK'} icon={<Send size={18} />} />
      </div>

      {canPost && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
          <Card>
            <CardHeader title="Build EBOT" subtitle="Technical accounting from a statement of account" />
            <FormField label="Statement">
              <Select value={statementId} onChange={(e) => setStatementId(e.target.value)}>
                <option value="">Select a statement…</option>
                {statements.map((s) => (
                  <option key={s.id} value={s.id}>
                    {(s.reference ?? s.id.slice(0, 8))} — {formatMoney(s.balanceMinor, s.currency)} ({s.status})
                  </option>
                ))}
              </Select>
            </FormField>
            <Button onClick={() => buildEbot.mutate()} disabled={!statementId || buildEbot.isPending}>Build EBOT</Button>
          </Card>
          <Card>
            <CardHeader title="Build ECOT" subtitle="Claim movement from a claim" />
            <FormField label="Claim">
              <Select value={claimId} onChange={(e) => setClaimId(e.target.value)}>
                <option value="">Select a claim…</option>
                {claims.map((c) => (
                  <option key={c.id} value={c.id}>
                    {(c.reference ?? c.id.slice(0, 8))} — paid {formatMoney(c.paidMinor, c.currency)} ({c.status})
                  </option>
                ))}
              </Select>
            </FormField>
            <Button onClick={() => buildEcot.mutate()} disabled={!claimId || buildEcot.isPending}>Build ECOT</Button>
          </Card>
        </div>
      )}

      <Card padded={false}>
        <CardHeader title="Bureau messages" subtitle="Outbound advices and inbound acknowledgements" />
        {messages.length === 0
          ? <EmptyState title="No bureau messages yet" message="Build an EBOT or ECOT to exchange with the bureau." />
          : <Table columns={columns} rows={messages} rowKey={(m) => m.id} />}
      </Card>

      {envelope != null && (
        <Card style={{ marginTop: 'var(--space-5)' }}>
          <CardHeader title="Canonical ACORD envelope" subtitle="Deterministic, sorted-key serialization (stands in for the AL3 / XML wire format)" />
          <pre style={{ overflowX: 'auto', fontSize: 12, background: 'var(--color-surface-sunken, #f6f8fa)', padding: 'var(--space-4)', borderRadius: 8 }}>
            {JSON.stringify(envelope, null, 2)}
          </pre>
        </Card>
      )}
    </>
  );
}
