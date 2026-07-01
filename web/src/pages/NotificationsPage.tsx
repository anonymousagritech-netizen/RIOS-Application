import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, BellRing, CheckCheck, AlertTriangle, AlertOctagon, Info,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/Table';
import { titleCase } from '../lib/format';
import styles from './NotificationsPage.module.css';

type NotificationKind =
  | 'SYSTEM' | 'REFERRAL' | 'SLA' | 'TASK' | 'CLAIM' | 'RENEWAL' | 'FINANCE';
type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Notification {
  id: string;
  channel: string;
  subject: string;
  body: string;
  kind: NotificationKind;
  severity: Severity;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  sentAt: string | null;
  createdAt: string;
}

const KIND_COLOR: Record<
  NotificationKind,
  'slate' | 'blue' | 'amber' | 'violet' | 'teal' | 'indigo' | 'orange' | 'rose'
> = {
  SYSTEM: 'slate',
  REFERRAL: 'violet',
  SLA: 'amber',
  TASK: 'blue',
  CLAIM: 'rose',
  RENEWAL: 'teal',
  FINANCE: 'indigo',
};

function severityIcon(severity: Severity) {
  if (severity === 'CRITICAL') return <AlertOctagon size={15} />;
  if (severity === 'WARNING') return <AlertTriangle size={15} />;
  return <Info size={15} />;
}

function severityClass(severity: Severity): string {
  if (severity === 'CRITICAL') return styles.sevCritical ?? '';
  if (severity === 'WARNING') return styles.sevWarning ?? '';
  return styles.sevInfo ?? '';
}

type Filter = 'all' | 'unread';

export function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');

  const listQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: Notification[] }>('notifications'),
  });
  const countQuery = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => api<{ count: number }>('notifications/unread-count'),
  });

  const notifications = listQuery.data?.notifications ?? [];

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'count'] });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api(`notifications/${id}/read`, { body: {} }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Failed to mark read'),
  });

  const markAll = useMutation({
    mutationFn: () => api<{ ok: boolean; marked: number }>('notifications/read-all', { body: {} }),
    onSuccess: (res) => {
      invalidate();
      toast.success(res.marked > 0 ? `Marked ${res.marked} as read` : 'All caught up');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Failed to mark all read'),
  });

  const stats = useMemo(() => {
    let warning = 0;
    let critical = 0;
    let unread = 0;
    for (const n of notifications) {
      if (n.severity === 'WARNING') warning += 1;
      else if (n.severity === 'CRITICAL') critical += 1;
      if (!n.isRead) unread += 1;
    }
    return { warning, critical, unread };
  }, [notifications]);

  const unreadCount = countQuery.data?.count ?? stats.unread;

  const visible = useMemo(
    () => (filter === 'unread' ? notifications.filter((n) => !n.isRead) : notifications),
    [notifications, filter],
  );

  const openRow = (n: Notification) => {
    if (!n.isRead) markRead.mutate(n.id);
    if (n.link) navigate(n.link);
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Alerts, referrals, SLA breaches and updates across your portfolio."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Notifications' }]}
        actions={
          <Button
            variant="secondary"
            icon={<CheckCheck size={16} />}
            loading={markAll.isPending}
            disabled={unreadCount === 0}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        }
      />

      <div className={styles.kpis}>
        <KpiCard
          label="Unread"
          value={String(unreadCount)}
          hint="Awaiting your attention"
          icon={<BellRing size={18} />}
          accent="var(--primary)"
          loading={countQuery.isLoading && listQuery.isLoading}
        />
        <KpiCard
          label="Total"
          value={String(notifications.length)}
          hint="Most recent 100"
          icon={<Bell size={18} />}
          loading={listQuery.isLoading}
        />
        <KpiCard
          label="Warnings"
          value={String(stats.warning)}
          hint="Severity WARNING"
          icon={<AlertTriangle size={18} />}
          accent="var(--c-amber)"
          loading={listQuery.isLoading}
        />
        <KpiCard
          label="Critical"
          value={String(stats.critical)}
          hint="Severity CRITICAL"
          icon={<AlertOctagon size={18} />}
          accent="var(--c-red)"
          loading={listQuery.isLoading}
        />
      </div>

      <Card padded={false}>
        <div className={styles.filterBar}>
          <button
            type="button"
            className={`${styles.filterChip} ${filter === 'all' ? styles.filterActive : ''}`}
            onClick={() => setFilter('all')}
          >
            All <span className={styles.filterCount}>{notifications.length}</span>
          </button>
          <button
            type="button"
            className={`${styles.filterChip} ${filter === 'unread' ? styles.filterActive : ''}`}
            onClick={() => setFilter('unread')}
          >
            Unread <span className={styles.filterCount}>{stats.unread}</span>
          </button>
        </div>

        {visible.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <EmptyState
              icon={<CheckCheck size={28} />}
              title="You're all caught up"
              message={
                filter === 'unread'
                  ? 'No unread notifications right now.'
                  : 'Notifications will appear here as things happen.'
              }
            />
          </div>
        ) : (
          <ul className={styles.list}>
            {visible.map((n) => (
              <li
                key={n.id}
                className={`${styles.row} ${!n.isRead ? styles.rowUnread : ''}`}
                onClick={() => openRow(n)}
                onKeyDown={(e) => { if (e.key === 'Enter') openRow(n); }}
                tabIndex={0}
                role="button"
              >
                <span
                  className={`${styles.sev} ${severityClass(n.severity)}`}
                  aria-hidden
                >
                  {severityIcon(n.severity)}
                </span>

                <div className={styles.body}>
                  <div className={styles.subjectRow}>
                    {!n.isRead && <span className={styles.unreadDot} aria-hidden />}
                    <span
                      className={`${styles.subject} ${!n.isRead ? styles.subjectUnread : ''}`}
                    >
                      {n.subject}
                    </span>
                    <Badge color={KIND_COLOR[n.kind]}>{titleCase(n.kind)}</Badge>
                  </div>
                  {n.body && <span className={styles.text}>{n.body}</span>}
                </div>

                <div className={styles.meta}>
                  <span className={styles.time}>
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
