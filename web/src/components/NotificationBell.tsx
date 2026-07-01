import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, CheckCheck, AlertTriangle, AlertOctagon, Info, BellOff,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Notification } from '../pages/NotificationsPage';
import styles from './NotificationBell.module.css';

const MAX_ITEMS = 8;

function severityGlyph(severity: Notification['severity']) {
  if (severity === 'CRITICAL') return { icon: <AlertOctagon size={12} />, cls: styles.dotCritical };
  if (severity === 'WARNING') return { icon: <AlertTriangle size={12} />, cls: styles.dotWarning };
  return { icon: <Info size={12} />, cls: styles.dotInfo };
}

export function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const countQuery = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: () => api<{ count: number }>('notifications/unread-count'),
    refetchInterval: 30000,
  });

  const listQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: Notification[] }>('notifications'),
    enabled: open,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    void qc.invalidateQueries({ queryKey: ['notifications', 'count'] });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api(`notifications/${id}/read`, { body: {} }),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => api<{ ok: boolean; marked: number }>('notifications/read-all', { body: {} }),
    onSuccess: invalidate,
  });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const count = countQuery.data?.count ?? 0;
  const items = (listQuery.data?.notifications ?? []).slice(0, MAX_ITEMS);

  const openItem = (n: Notification) => {
    if (!n.isRead) markRead.mutate(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const goAll = () => {
    setOpen(false);
    navigate('/notifications');
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Bell size={18} />
        {count > 0 && (
          <span className={styles.badge} aria-hidden>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.panel} role="dialog" aria-label="Notifications">
          <div className={styles.head}>
            <span className={styles.headTitle}>Notifications</span>
            <button
              type="button"
              className={styles.markAll}
              onClick={() => markAll.mutate()}
              disabled={count === 0 || markAll.isPending}
            >
              <CheckCheck size={14} /> Mark all read
            </button>
          </div>

          {items.length === 0 ? (
            <div className={styles.empty}>
              <BellOff size={22} aria-hidden />
              <span>{listQuery.isLoading ? 'Loading...' : "You're all caught up"}</span>
            </div>
          ) : (
            <ul className={styles.list}>
              {items.map((n) => {
                const sev = severityGlyph(n.severity);
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`${styles.item} ${!n.isRead ? styles.itemUnread : ''}`}
                      onClick={() => openItem(n)}
                    >
                      <span className={`${styles.dot} ${sev.cls}`} aria-hidden>{sev.icon}</span>
                      <span className={styles.itemBody}>
                        <span className={styles.itemSubject}>{n.subject}</span>
                        {n.body && <span className={styles.itemText}>{n.body}</span>}
                        <span className={styles.itemTime}>
                          {new Date(n.createdAt).toLocaleString()}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className={styles.footer}>
            <button type="button" className={styles.viewAll} onClick={goAll}>
              View all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
