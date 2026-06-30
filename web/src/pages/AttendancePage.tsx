import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock, LogIn, LogOut, Coffee, Play, CalendarDays, Timer, CheckCircle2,
} from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { useToast } from '../components/Toast';
import styles from './AttendancePage.module.css';

interface AttRecord {
  id: string;
  workDate: string;
  punchInAt: string | null;
  punchOutAt: string | null;
  breakOpenAt: string | null;
  breakMinutes: number;
  status: string;
  workedMinutes: number;
  onBreak: boolean;
}
interface MeResponse { today: AttRecord | null; history: AttRecord[] }

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
function fmtClock(iso: string | null): string {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function liveWorked(t: AttRecord | null, nowMs: number): number {
  if (!t?.punchInAt) return 0;
  const start = new Date(t.punchInAt).getTime();
  const end = t.punchOutAt ? new Date(t.punchOutAt).getTime() : nowMs;
  let breaks = t.breakMinutes;
  if (t.breakOpenAt && !t.punchOutAt) breaks += Math.max(0, Math.round((nowMs - new Date(t.breakOpenAt).getTime()) / 60000));
  return Math.max(0, Math.round((end - start) / 60000) - breaks);
}

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'slate'> = {
  present: 'green', on_break: 'amber', checked_out: 'slate',
};

export function AttendancePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());

  const { data, isLoading } = useQuery({
    queryKey: ['attendance-me'],
    queryFn: () => api<MeResponse>('/api/attendance/me'),
    refetchInterval: 60_000,
  });

  // Tick every second so the working-hours clock stays live.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const today = data?.today ?? null;
  const worked = liveWorked(today, now);
  const isIn = !!today?.punchInAt && !today?.punchOutAt;
  const onBreak = !!today?.onBreak;

  const makeAction = (path: string, label: string) => ({
    mutationFn: () => api(`/api/attendance/${path}`, { method: 'POST' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance-me'] }); toast.success(label); },
    onError: () => toast.error('Could not record attendance'),
  });

  const punchIn = useMutation(makeAction('punch-in', 'Punched in'));
  const punchOut = useMutation(makeAction('punch-out', 'Punched out'));
  const breakStart = useMutation(makeAction('break/start', 'Break started'));
  const breakEnd = useMutation(makeAction('break/end', 'Break ended'));
  const busy = punchIn.isPending || punchOut.isPending || breakStart.isPending || breakEnd.isPending;

  // Weekly / monthly rollups from history.
  const stats = useMemo(() => {
    const hist = data?.history ?? [];
    const now2 = new Date();
    const weekStart = new Date(now2); weekStart.setDate(now2.getDate() - 6);
    const monthKey = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, '0')}`;
    let weekMin = 0, monthDays = 0, monthMin = 0;
    for (const r of hist) {
      const d = new Date(r.workDate + 'T00:00:00');
      if (d >= new Date(weekStart.toDateString())) weekMin += r.workedMinutes;
      if (r.workDate.startsWith(monthKey)) { monthDays += 1; monthMin += r.workedMinutes; }
    }
    return { weekMin, monthDays, avg: monthDays ? Math.round(monthMin / monthDays) : 0 };
  }, [data?.history]);

  const columns: Column<AttRecord>[] = [
    { key: 'date', header: 'Date', render: (r) => new Date(r.workDate + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }) },
    { key: 'in', header: 'In', render: (r) => fmtClock(r.punchInAt) },
    { key: 'out', header: 'Out', render: (r) => fmtClock(r.punchOutAt) },
    { key: 'break', header: 'Break', align: 'right', render: (r) => `${r.breakMinutes}m` },
    { key: 'worked', header: 'Worked', align: 'right', render: (r) => <strong>{fmtDuration(r.workedMinutes)}</strong> },
    { key: 'status', header: 'Status', align: 'right', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'slate'}>{r.status.replace('_', ' ')}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Punch in and out, track breaks, and review your working hours."
      />

      <div className={styles.hero}>
        <Card padded className={styles.clockCard}>
          <div className={styles.clockTop}>
            <span className={styles.clockLabel}><Timer size={15} /> Today, working time</span>
            <Badge color={isIn ? (onBreak ? 'amber' : 'green') : 'slate'}>
              {isIn ? (onBreak ? 'On break' : 'Working') : today?.punchOutAt ? 'Checked out' : 'Not started'}
            </Badge>
          </div>
          <div className={styles.clockValue}>{fmtDuration(worked)}</div>
          <div className={styles.clockMeta}>
            <span><LogIn size={14} /> In {fmtClock(today?.punchInAt ?? null)}</span>
            <span><LogOut size={14} /> Out {fmtClock(today?.punchOutAt ?? null)}</span>
            <span><Coffee size={14} /> Break {today?.breakMinutes ?? 0}m</span>
          </div>
          <div className={styles.actions}>
            {!isIn ? (
              <button className={`${styles.btn} ${styles.btnIn}`} disabled={busy} onClick={() => punchIn.mutate()}>
                <LogIn size={18} /> Punch in
              </button>
            ) : (
              <>
                {!onBreak ? (
                  <button className={`${styles.btn} ${styles.btnBreak}`} disabled={busy} onClick={() => breakStart.mutate()}>
                    <Coffee size={18} /> Start break
                  </button>
                ) : (
                  <button className={`${styles.btn} ${styles.btnResume}`} disabled={busy} onClick={() => breakEnd.mutate()}>
                    <Play size={18} /> End break
                  </button>
                )}
                <button className={`${styles.btn} ${styles.btnOut}`} disabled={busy} onClick={() => punchOut.mutate()}>
                  <LogOut size={18} /> Punch out
                </button>
              </>
            )}
          </div>
        </Card>

        <div className={styles.statCol}>
          <KpiCard label="This week" value={fmtDuration(stats.weekMin)} hint="Worked, last 7 days" icon={<Clock size={20} />} accent="var(--accent-cyan)" loading={isLoading} />
          <KpiCard label="Days this month" value={String(stats.monthDays)} hint="Days with attendance" icon={<CalendarDays size={20} />} accent="var(--accent-violet)" loading={isLoading} />
          <KpiCard label="Average / day" value={fmtDuration(stats.avg)} hint="This month" icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" loading={isLoading} />
        </div>
      </div>

      <Card>
        <CardHeader title="Attendance history" subtitle="Your records over the last 30 days" />
        <Table
          columns={columns}
          rows={data?.history}
          loading={isLoading}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No attendance yet" message="Punch in to start tracking your working hours." />}
          skeletonRows={6}
        />
      </Card>
    </>
  );
}
