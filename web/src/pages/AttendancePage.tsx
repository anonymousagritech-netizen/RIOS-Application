import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock, LogIn, LogOut, Coffee, Play, CalendarDays, Timer, CheckCircle2,
  CalendarCheck, Cake, Megaphone, Award, MapPin, Download, Building2, Users,
} from 'lucide-react';
import { api, API_BASE, getToken, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { useToast } from '../components/Toast';
import styles from './AttendancePage.module.css';

/** Best-effort device coordinates; resolves undefined if denied/unavailable. */
function getCoords(): Promise<{ lat: number; lng: number } | undefined> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}

interface TeamRow {
  id: string; name: string; email: string; status: string;
  punchInAt: string | null; punchOutAt: string | null; workedMinutes: number; onBreak: boolean;
}
interface TeamResponse { date: string; summary: { total: number; present: number; checkedOut: number; onBreak: number }; records: TeamRow[] }

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
interface MeResponse { today: AttRecord | null; history: AttRecord[]; geofenced?: boolean }

interface Workspace {
  hasEmployee: boolean;
  leaveBalance: { entitlement: number; used: number; remaining: number };
  upcomingHolidays: { date: string; name: string }[];
  birthdays: { name: string; date: string; inDays: number }[];
  announcements: { title: string; body: string; category: string; postedAt: string }[];
  performance: { period: string; band: string | null; overallScore: number } | null;
}

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

  const { data: ws } = useQuery({
    queryKey: ['me-workspace'],
    queryFn: () => api<Workspace>('/api/me/workspace'),
    staleTime: 300_000,
  });

  const { hasPermission } = useAuth();
  const isHr = hasPermission('hr:read');
  const { data: team } = useQuery({
    queryKey: ['attendance-team'],
    queryFn: () => api<TeamResponse>('/api/attendance/team'),
    enabled: isHr,
    refetchInterval: 60_000,
  });

  async function downloadCsv() {
    try {
      const res = await fetch(`${API_BASE}/api/attendance/export`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'attendance.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Could not download CSV'); }
  }

  const registerOffice = useMutation({
    mutationFn: async () => {
      const c = await getCoords();
      if (!c) throw new ApiError(0, 'Location unavailable - allow location access');
      return api('/api/attendance/offices', {
        method: 'POST',
        body: { name: 'Head office', latitude: c.lat, longitude: c.lng, radiusMeters: 200, bufferMeters: 100 },
      });
    },
    onSuccess: () => toast.success('Office geofence set at your location'),
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not set office'),
  });

  const teamColumns: Column<TeamRow>[] = [
    {
      key: 'name', header: 'Employee',
      render: (r) => (
        <div><div className={styles.teamName}>{r.name}</div><div className={styles.teamEmail}>{r.email}</div></div>
      ),
    },
    { key: 'in', header: 'In', render: (r) => fmtClock(r.punchInAt) },
    { key: 'out', header: 'Out', render: (r) => fmtClock(r.punchOutAt) },
    { key: 'worked', header: 'Worked', align: 'right', render: (r) => fmtDuration(r.workedMinutes) },
    { key: 'status', header: 'Status', align: 'right', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'slate'}>{r.status.replace('_', ' ')}</Badge> },
  ];

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
    mutationFn: (body?: { lat: number; lng: number }) =>
      api(`/api/attendance/${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['attendance-me'] }); toast.success(label); },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : 'Could not record attendance'),
  });

  const punchIn = useMutation(makeAction('punch-in', 'Punched in'));
  const punchOut = useMutation(makeAction('punch-out', 'Punched out'));
  const doPunchIn = async () => punchIn.mutate(await getCoords());
  const doPunchOut = async () => punchOut.mutate(await getCoords());
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
            {data?.geofenced && <span className={styles.geoHint}><MapPin size={14} /> Geofenced punch</span>}
          </div>
          <div className={styles.actions}>
            {!isIn ? (
              <button className={`${styles.btn} ${styles.btnIn}`} disabled={busy} onClick={doPunchIn}>
                <LogIn size={18} /> Punch in
              </button>
            ) : (
              <>
                {!onBreak ? (
                  <button className={`${styles.btn} ${styles.btnBreak}`} disabled={busy} onClick={() => breakStart.mutate(undefined)}>
                    <Coffee size={18} /> Start break
                  </button>
                ) : (
                  <button className={`${styles.btn} ${styles.btnResume}`} disabled={busy} onClick={() => breakEnd.mutate(undefined)}>
                    <Play size={18} /> End break
                  </button>
                )}
                <button className={`${styles.btn} ${styles.btnOut}`} disabled={busy} onClick={doPunchOut}>
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

      <div className={styles.widgets}>
        <Card padded className={styles.widget}>
          <div className={styles.widgetHead}><CalendarCheck size={16} /> Leave balance</div>
          {ws ? (
            <>
              <div className={styles.leaveTop}>
                <span className={styles.leaveBig}>{ws.leaveBalance.remaining}</span>
                <span className={styles.leaveUnit}>days left</span>
              </div>
              <div className={styles.bar}>
                <span
                  className={styles.barFill}
                  style={{ width: `${Math.min(100, (ws.leaveBalance.used / Math.max(1, ws.leaveBalance.entitlement)) * 100)}%` }}
                />
              </div>
              <div className={styles.widgetMeta}>{ws.leaveBalance.used} of {ws.leaveBalance.entitlement} annual days used</div>
            </>
          ) : <div className={styles.widgetMeta}>Loading...</div>}
        </Card>

        <Card padded className={styles.widget}>
          <div className={styles.widgetHead}><CalendarDays size={16} /> Upcoming holidays</div>
          {ws?.upcomingHolidays.length ? (
            <ul className={styles.list}>
              {ws.upcomingHolidays.map((h) => (
                <li key={h.date + h.name}>
                  <span className={styles.listMain}>{h.name}</span>
                  <span className={styles.listSub}>{new Date(h.date + 'T00:00:00').toLocaleDateString([], { day: '2-digit', month: 'short' })}</span>
                </li>
              ))}
            </ul>
          ) : <div className={styles.widgetMeta}>No upcoming holidays.</div>}
        </Card>

        <Card padded className={styles.widget}>
          <div className={styles.widgetHead}><Cake size={16} /> Birthdays</div>
          {ws?.birthdays.length ? (
            <ul className={styles.list}>
              {ws.birthdays.map((b) => (
                <li key={b.name + b.date}>
                  <span className={styles.listMain}>{b.name}</span>
                  <span className={styles.listSub}>{b.inDays === 0 ? 'Today' : b.inDays === 1 ? 'Tomorrow' : `in ${b.inDays} days`}</span>
                </li>
              ))}
            </ul>
          ) : <div className={styles.widgetMeta}>No birthdays in the next 45 days.</div>}
        </Card>

        <Card padded className={styles.widget}>
          <div className={styles.widgetHead}><Award size={16} /> Performance</div>
          {ws?.performance ? (
            <>
              <div className={styles.leaveTop}>
                <span className={styles.leaveBig}>{ws.performance.overallScore.toFixed(1)}</span>
                <span className={styles.leaveUnit}>{ws.performance.band ?? 'rated'}</span>
              </div>
              <div className={styles.widgetMeta}>Latest review: {ws.performance.period}</div>
            </>
          ) : <div className={styles.widgetMeta}>No performance review yet.</div>}
        </Card>

        <Card padded className={`${styles.widget} ${styles.widgetWide}`}>
          <div className={styles.widgetHead}><Megaphone size={16} /> Announcements</div>
          {ws?.announcements.length ? (
            <ul className={styles.annList}>
              {ws.announcements.map((a) => (
                <li key={a.title}>
                  <span className={styles.annTitle}>{a.title}</span>
                  <span className={styles.annBody}>{a.body}</span>
                </li>
              ))}
            </ul>
          ) : <div className={styles.widgetMeta}>No announcements.</div>}
        </Card>
      </div>

      {isHr && (
        <Card>
          <CardHeader
            title="Team attendance today"
            subtitle={team ? `${team.summary.present} present, ${team.summary.onBreak} on break, ${team.summary.checkedOut} checked out of ${team.summary.total}` : 'All employees'}
            actions={
              <div className={styles.adminActions}>
                <Button variant="secondary" size="sm" icon={<Building2 size={15} />} onClick={() => registerOffice.mutate()}>
                  Set office here
                </Button>
                <Button variant="secondary" size="sm" icon={<Download size={15} />} onClick={downloadCsv}>
                  Download CSV
                </Button>
              </div>
            }
          />
          <Table
            columns={teamColumns}
            rows={team?.records}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<Users size={18} />} title="No attendance recorded today" message="Records appear as employees punch in." />}
            skeletonRows={4}
          />
        </Card>
      )}

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
