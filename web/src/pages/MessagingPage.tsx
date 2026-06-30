/**
 * Email & SMS engines (brief §3). A message outbox: compose to the queue, then
 * deliver via the (in-process dev) provider. Real SMTP/SMS gateways are wired in
 * production. integration:write to send.
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
import { FormField, Select, Input, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatDateTime, titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Message { id: string; channel: string; to: string; subject?: string | null; body: string; status: string; provider?: string | null; createdAt: string; sentAt?: string | null }
const STATUS: Record<string, 'amber' | 'green' | 'red'> = { queued: 'amber', sent: 'green', failed: 'red' };

export function MessagingPage() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const canSend = hasPermission('integration:write');
  const q = useQuery({ queryKey: ['outbox'], queryFn: () => api<{ messages: Message[] }>('/api/messaging/outbox') });

  const [channel, setChannel] = useState('email');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const send = useMutation({
    mutationFn: () => api('/api/messaging/send', { body: { channel, to: to.trim(), subject: subject || undefined, body: body.trim() } }),
    onSuccess: () => { toast.success('Queued'); setTo(''); setSubject(''); setBody(''); qc.invalidateQueries({ queryKey: ['outbox'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not queue'),
  });
  const deliver = useMutation({
    mutationFn: () => api<{ delivered: number }>('/api/messaging/deliver', { body: {} }),
    onSuccess: (r) => { toast.success(`Delivered ${r.delivered}`); qc.invalidateQueries({ queryKey: ['outbox'] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not deliver'),
  });

  if (q.isLoading) return <PageLoader label="Loading outbox…" />;

  const cols: Column<Message>[] = [
    { key: 'channel', header: 'Channel', render: (m) => <Badge color="slate">{titleCase(m.channel)}</Badge> },
    { key: 'to', header: 'To', render: (m) => <span className={shared.cellMain}>{m.to}</span> },
    { key: 'subject', header: 'Subject', render: (m) => <span className={shared.cellSub}>{m.subject ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (m) => <Badge color={STATUS[m.status] ?? 'slate'}>{titleCase(m.status)}</Badge> },
    { key: 'sent', header: 'Sent', render: (m) => m.sentAt ? formatDateTime(m.sentAt) : '—' },
  ];

  return (
    <>
      <PageHeader title="Messaging" description="Email & SMS outbox. The dev provider delivers in-process; SMTP/SMS gateways are wired in production." />
      {canSend && (
        <Card>
          <CardHeader title="Compose" actions={<Button variant="ghost" onClick={() => deliver.mutate()} loading={deliver.isPending}>Deliver queue</Button>} />
          <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-3)', maxWidth: 640 }}>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <div style={{ width: 140 }}><FormField label="Channel"><Select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="email">Email</option><option value="sms">SMS</option></Select></FormField></div>
              <div style={{ flex: 1 }}><FormField label="To"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === 'sms' ? '+1…' : 'name@example.com'} /></FormField></div>
            </div>
            {channel === 'email' && <FormField label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></FormField>}
            <FormField label="Body"><Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></FormField>
            <div><Button variant="primary" onClick={() => send.mutate()} loading={send.isPending} disabled={!to.trim() || !body.trim()}>Queue message</Button></div>
          </div>
        </Card>
      )}
      <Card>
        <CardHeader title="Outbox" />
        <div style={{ padding: 'var(--space-4)' }}>
          <Table columns={cols} rows={q.data?.messages} rowKey={(m) => m.id} empty={<EmptyState title="Empty" message="No messages queued." />} />
        </div>
      </Card>
    </>
  );
}
