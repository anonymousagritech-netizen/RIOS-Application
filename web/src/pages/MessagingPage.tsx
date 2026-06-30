/**
 * Email & SMS engines (brief §3). A message outbox: compose to the queue, then
 * deliver via the (in-process dev) provider. Real SMTP/SMS gateways are wired in
 * production. integration:write to send.
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge, StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { FormField, Select, Input, Textarea } from '../components/Form';
import { PageLoader } from '../components/Feedback';
import { formatNumber, formatDateTime, titleCase } from '../lib/format';
import { Inbox, Send, Clock, AlertTriangle, Mail } from 'lucide-react';
import shared from './shared.module.css';
import styles from './MessagingPage.module.css';

interface Message { id: string; channel: string; to: string; subject?: string | null; body: string; status: string; provider?: string | null; createdAt: string; sentAt?: string | null }
const STATUS_COLORS: Record<string, string> = { queued: 'amber', sent: 'green', failed: 'red' };

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

  const stats = useMemo(() => {
    const list = q.data?.messages ?? [];
    return {
      total: list.length,
      queued: list.filter((m) => m.status === 'queued').length,
      sent: list.filter((m) => m.status === 'sent').length,
      failed: list.filter((m) => m.status === 'failed').length,
    };
  }, [q.data]);

  if (q.isLoading) return <PageLoader label="Loading outbox…" />;

  const cols: Column<Message>[] = [
    { key: 'channel', header: 'Channel', render: (m) => <Badge color="slate">{titleCase(m.channel)}</Badge> },
    { key: 'to', header: 'To', render: (m) => <span className={shared.cellMain}>{m.to}</span> },
    { key: 'subject', header: 'Subject', render: (m) => <span className={shared.cellSub}>{m.subject ?? '-'}</span> },
    { key: 'status', header: 'Status', render: (m) => <StatusPill status={m.status} metaColors={STATUS_COLORS} /> },
    { key: 'sent', header: 'Sent', align: 'right', render: (m) => <span className={shared.cellSub}>{m.sentAt ? formatDateTime(m.sentAt) : '-'}</span> },
  ];

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Messaging' }]}
        title="Messaging"
        description="Email & SMS outbox. The dev provider delivers in-process; SMTP/SMS gateways are wired in production."
        actions={canSend ? <Button variant="secondary" onClick={() => deliver.mutate()} loading={deliver.isPending} icon={<Send size={16} />}>Deliver queue</Button> : null}
      />

      <div className={styles.kpiGrid}>
        <KpiCard label="Messages" value={formatNumber(stats.total)} icon={<Inbox size={20} />} accent="var(--primary)" />
        <KpiCard label="Queued" value={formatNumber(stats.queued)} icon={<Clock size={20} />} accent="var(--accent-orange)" />
        <KpiCard label="Sent" value={formatNumber(stats.sent)} icon={<Send size={20} />} accent="var(--accent-emerald)" />
        <KpiCard label="Failed" value={formatNumber(stats.failed)} icon={<AlertTriangle size={20} />} accent="var(--accent-rose)" />
      </div>

      <div className={canSend ? styles.cols : undefined}>
        {canSend && (
          <Card padded={false}>
            <CardHeader title="Compose" subtitle="Queue a message for the next delivery run." />
            <div className={styles.compose}>
              <div className={styles.row}>
                <div className={styles.channelField}>
                  <FormField label="Channel">
                    <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                      <option value="email">Email</option>
                      <option value="sms">SMS</option>
                    </Select>
                  </FormField>
                </div>
                <div className={styles.toField}>
                  <FormField label="To">
                    <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === 'sms' ? '+1…' : 'name@example.com'} />
                  </FormField>
                </div>
              </div>
              {channel === 'email' && <FormField label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></FormField>}
              <FormField label="Body"><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></FormField>
              <div className={styles.composeActions}>
                <Button variant="primary" onClick={() => send.mutate()} loading={send.isPending} disabled={!to.trim() || !body.trim()} icon={<Mail size={16} />}>Queue message</Button>
              </div>
            </div>
          </Card>
        )}

        <Card padded={false}>
          <CardHeader title="Outbox" subtitle="Queued and delivered messages for this tenant." />
          <div style={{ padding: 'var(--space-4)' }}>
            <Table columns={cols} rows={q.data?.messages} rowKey={(m) => m.id} empty={<EmptyState title="Empty outbox" message="No messages queued yet." icon={<Inbox size={16} />} />} />
          </div>
        </Card>
      </div>
    </>
  );
}
