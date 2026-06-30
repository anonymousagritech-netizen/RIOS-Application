import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock, LogIn, LogOut, Coffee, Play, CalendarDays, Timer, CheckCircle2,
  CalendarCheck, Cake, Megaphone, Award, MapPin, Download, Building2, Users,
  LayoutGrid, Home, Briefcase, Pencil, FileText, UserCheck, Plane, Check, X,
} from 'lucide-react';
import { api, API_BASE, getToken, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Tabs } from '../components/Tabs';
import { Modal, ConfirmDialog } from '../components/Modal';
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

// ---- Attendance command-center types (Part B) ----
type DayStatus =
  | 'present' | 'checked_out' | 'od' | 'wfh' | 'regularized'
  | 'on_break' | 'on_leave' | 'holiday' | 'weekend' | 'absent';
interface MonthDay { day: string; status: DayStatus; future: boolean }
interface MonthSummary {
  workedDays: number; present: number; od: number; wfh: number;
  onLeave: number; absent: number; holiday: number; weekend: number; regularized: number;
}
interface MonthResponse { month: string; employeeId: string | null; days: MonthDay[]; summary: MonthSummary }
interface AttRequest {
  id: string; kind: 'regularization' | 'od' | 'wfh'; requestDate: string;
  reason: string | null; status: string; employeeName: string;
  punchInAt: string | null; punchOutAt: string | null;
}
interface OnLeaveRow { name: string; kind: string; startDate: string; endDate: string; onLeaveToday: boolean }
interface OnLeaveResponse { today: OnLeaveRow[]; upcoming: OnLeaveRow[] }

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
function fmtClock(iso: string | null): string {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(iso: string): string {
  // Accept either 'YYYY-MM-DD' or a full ISO timestamp; render local calendar day.
  return new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString([], { day: '2-digit', month: 'short' });
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

// Calendar-cell appearance is driven by data-status (styled in the CSS module
// from design tokens) so there are no hardcoded colours here.
const DAY_LABEL: Record<DayStatus, string> = {
  present: 'P', checked_out: 'P', regularized: 'R', od: 'OD', wfh: 'WFH',
  on_break: 'P', on_leave: 'L', holiday: 'H', weekend: '·', absent: 'A',
};
const STATUS_TEXT: Record<DayStatus, string> = {
  present: 'Present', checked_out: 'Present', regularized: 'Regularized', od: 'On-Duty (off-site)',
  wfh: 'Work from home', on_break: 'Present', on_leave: 'On leave', holiday: 'Holiday',
  weekend: 'Weekend', absent: 'Absent',
};
const REQUEST_KIND_LABEL: Record<AttRequest['kind'], string> = {
  regularization: 'Regularization', od: 'On-Duty (OD)', wfh: 'Work from home',
};

function monthKeyNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(key: string, by: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const d = new Date(y, (m - 1) + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthTitle(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

export function AttendancePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const isHr = hasPermission('hr:read');
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState('today');
  const [month, setMonth] = useState(() => monthKeyNow());

  // Request dialog state.
  const [reqOpen, setReqOpen] = useState(false);
  const [reqKind, setReqKind] = useState<AttRequest['kind']>('wfh');
  const [reqDate, setReqDate] = useState('');
  const [reqReason, setReqReason] = useState('');
  const [reqIn, setReqIn] = useState('');
  const [reqOut, setReqOut] = useState('');
  // Approve/reject confirmation state.
  const [decide, setDecide] = useState<{ req: AttRequest; decision: 'approved' | 'rejected' } | null>(null);

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

  const { data: monthData, isLoading: monthLoading } = useQuery({
    queryKey: ['attendance-month', month],
    queryFn: () => api<MonthResponse>(`/api/attendance/month?month=${month}`),
  });

  const { data: onLeave } = useQuery({
    queryKey: ['hr-on-leave'],
    queryFn: () => api<OnLeaveResponse>('/api/hr/on-leave?days=7'),
    staleTime: 120_000,
  });

  const { data: team } = useQuery({
    queryKey: ['attendance-team'],
    queryFn: () => api<TeamResponse>('/api/attendance/team'),
    enabled: isHr,
    refetchInterval: 60_000,
  });

  const { data: approvals } = useQuery({
    queryKey: ['attendance-approvals'],
    queryFn: () => api<{ requests: AttRequest[] }>('/api/attendance/requests'),
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

  // Submit an OD / WFH / regularization request, routed to my manager.
  const submitRequest = useMutation({
    mutationFn: () =>
      api('/api/attendance/request', {
        method: 'POST',
        body: {
          date: reqDate,
          kind: reqKind,
          reason: reqReason || undefined,
          punchInAt: reqKind === 'regularization' && reqIn ? new Date(`${reqDate}T${reqIn}`).toISOString() : undefined,
          punchOutAt: reqKind === 'regularization' && reqOut ? new Date(`${reqDate}T${reqOut}`).toISOString() : undefined,
        },
      }),
    onSuccess: (r: unknown) => {
      const resolved = (r as { approverResolved?: boolean })?.approverResolved;
      toast.success(resolved ? 'Request sent to your manager for approval' : 'Request submitted (no manager on file - HR will review)');
      setReqOpen(false); setReqReason(''); setReqIn(''); setReqOut('');
      qc.invalidateQueries({ queryKey: ['attendance-month', month] });
      qc.invalidateQueries({ queryKey: ['attendance-approvals'] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not submit request'),
  });

  // Manager decision on a pending request.
  const decideRequest = useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected' }) =>
      api(`/api/attendance/requests/${v.id}/decide`, { method: 'POST', body: { decision: v.decision } }),
    onSuccess: (_r, v) => {
      toast.success(v.decision === 'approved' ? 'Request approved' : 'Request rejected');
      setDecide(null);
      qc.invalidateQueries({ queryKey: ['attendance-approvals'] });
      qc.invalidateQueries({ queryKey: ['attendance-month', month] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not record decision'),
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

  // Calendar grid: pad the first week so day-of-week columns line up (Mon..Sun).
  const calendar = useMemo(() => {
    const days = monthData?.days ?? [];
    if (!days[0]) return { lead: 0, days };
    const first = new Date(days[0].day + 'T00:00:00');
    const lead = (first.getDay() + 6) % 7; // Monday-first
    return { lead, days };
  }, [monthData?.days]);

  const columns: Column<AttRecord>[] = [
    { key: 'date', header: 'Date', render: (r) => new Date(r.workDate + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }) },
    { key: 'in', header: 'In', render: (r) => fmtClock(r.punchInAt) },
    { key: 'out', header: 'Out', render: (r) => fmtClock(r.punchOutAt) },
    { key: 'break', header: 'Break', align: 'right', render: (r) => `${r.breakMinutes}m` },
    { key: 'worked', header: 'Worked', align: 'right', render: (r) => <strong>{fmtDuration(r.workedMinutes)}</strong> },
    { key: 'status', header: 'Status', align: 'right', render: (r) => <Badge color={STATUS_COLOR[r.status] ?? 'slate'}>{r.status.replace('_', ' ')}</Badge> },
  ];

  const openRequest = (kind: AttRequest['kind']) => {
    setReqKind(kind);
    setReqDate(new Date().toISOString().slice(0, 10));
    setReqReason(''); setReqIn(''); setReqOut('');
    setReqOpen(true);
  };

  const tabs = [
    { id: 'today', label: <><Timer size={15} /> Today</> },
    { id: 'calendar', label: <><LayoutGrid size={15} /> Calendar</> },
    ...(isHr ? [{ id: 'team', label: <><Users size={15} /> Team {approvals?.requests.length ? `(${approvals.requests.length})` : ''}</> }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Punch in and out, track your month, and request OD, WFH or corrections."
        actions={
          <Button variant="secondary" size="sm" icon={<FileText size={15} />} onClick={() => navigate('/payroll')}>
            Payslips
          </Button>
        }
      />

      <div className={styles.tabBar}><Tabs tabs={tabs} active={tab} onChange={setTab} /></div>

      {tab === 'today' && (
        <>
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
              <div className={styles.quickRow}>
                <button className={styles.quickBtn} onClick={() => openRequest('od')}><Briefcase size={15} /> On-Duty</button>
                <button className={styles.quickBtn} onClick={() => openRequest('wfh')}><Home size={15} /> WFH</button>
                <button className={styles.quickBtn} onClick={() => openRequest('regularization')}><Pencil size={15} /> Regularize</button>
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
              <div className={styles.widgetHead}><Plane size={16} /> Who's on leave</div>
              {onLeave && (onLeave.today.length || onLeave.upcoming.length) ? (
                <ul className={styles.list}>
                  {onLeave.today.map((p) => (
                    <li key={'t' + p.name + p.startDate}>
                      <span className={styles.listMain}>{p.name}</span>
                      <Badge color="amber">Today</Badge>
                    </li>
                  ))}
                  {onLeave.upcoming.slice(0, 6).map((p) => (
                    <li key={'u' + p.name + p.startDate}>
                      <span className={styles.listMain}>{p.name}</span>
                      <span className={styles.listSub}>from {fmtDay(p.startDate)}</span>
                    </li>
                  ))}
                </ul>
              ) : <div className={styles.widgetMeta}>Nobody is on leave in the next 7 days.</div>}
            </Card>

            <Card padded className={styles.widget}>
              <div className={styles.widgetHead}><CalendarDays size={16} /> Upcoming holidays</div>
              {ws?.upcomingHolidays.length ? (
                <ul className={styles.list}>
                  {ws.upcomingHolidays.map((h) => (
                    <li key={h.date + h.name}>
                      <span className={styles.listMain}>{h.name}</span>
                      <span className={styles.listSub}>{fmtDay(h.date)}</span>
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
      )}

      {tab === 'calendar' && (
        <>
          <Card padded>
            <div className={styles.calHead}>
              <div className={styles.calNav}>
                <button className={styles.calArrow} aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
                <span className={styles.calTitle}>{monthTitle(month)}</span>
                <button className={styles.calArrow} aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
              </div>
              <div className={styles.calActions}>
                <Button variant="secondary" size="sm" icon={<Briefcase size={15} />} onClick={() => openRequest('od')}>OD</Button>
                <Button variant="secondary" size="sm" icon={<Home size={15} />} onClick={() => openRequest('wfh')}>WFH</Button>
                <Button variant="secondary" size="sm" icon={<Pencil size={15} />} onClick={() => openRequest('regularization')}>Regularize</Button>
              </div>
            </div>

            <div className={styles.dow}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d}>{d}</span>)}
            </div>
            <div className={styles.calGrid} aria-busy={monthLoading}>
              {Array.from({ length: calendar.lead }).map((_, i) => <span key={'pad' + i} className={styles.calPad} />)}
              {calendar.days.map((d) => (
                <div
                  key={d.day}
                  className={`${styles.calCell} ${d.future ? styles.calFuture : ''}`}
                  data-status={d.future ? 'future' : d.status}
                  title={`${fmtDay(d.day)} - ${d.future ? 'Upcoming' : STATUS_TEXT[d.status]}`}
                >
                  <span className={styles.calNum}>{Number(d.day.slice(-2))}</span>
                  {!d.future && <span className={styles.calTag}>{DAY_LABEL[d.status]}</span>}
                </div>
              ))}
            </div>

            <div className={styles.legend}>
              {(['present', 'wfh', 'od', 'regularized', 'on_leave', 'holiday', 'absent'] as DayStatus[]).map((s) => (
                <span key={s} className={styles.legendItem}>
                  <span className={styles.legendSwatch} data-status={s} />{STATUS_TEXT[s]}
                </span>
              ))}
            </div>
          </Card>

          {monthData?.summary && (
            <div className={styles.summaryRow}>
              <KpiCard label="Worked days" value={String(monthData.summary.workedDays)} hint="Incl. OD, WFH, regularized" icon={<CheckCircle2 size={20} />} accent="var(--accent-emerald)" />
              <KpiCard label="WFH" value={String(monthData.summary.wfh)} hint="Work from home" icon={<Home size={20} />} accent="var(--accent-cyan)" />
              <KpiCard label="On-Duty" value={String(monthData.summary.od)} hint="Off-site, counted present" icon={<Briefcase size={20} />} accent="var(--accent-violet)" />
              <KpiCard label="On leave" value={String(monthData.summary.onLeave)} hint="Approved leave days" icon={<Plane size={20} />} accent="var(--accent-orange)" />
              <KpiCard label="Absent" value={String(monthData.summary.absent)} hint="Unaccounted days" icon={<X size={20} />} accent="var(--accent-rose)" />
            </div>
          )}
        </>
      )}

      {tab === 'team' && isHr && (
        <>
          <Card>
            <CardHeader
              title="Approvals"
              subtitle="OD / WFH / regularization requests routed to you as manager"
            />
            <Table
              columns={[
                { key: 'emp', header: 'Employee', render: (r: AttRequest) => <span className={styles.teamName}>{r.employeeName}</span> },
                { key: 'kind', header: 'Type', render: (r: AttRequest) => <Badge color="violet">{REQUEST_KIND_LABEL[r.kind]}</Badge> },
                { key: 'date', header: 'Date', render: (r: AttRequest) => fmtDay(r.requestDate) },
                { key: 'reason', header: 'Reason', render: (r: AttRequest) => <span className={styles.listSub}>{r.reason || '—'}</span> },
                {
                  key: 'act', header: '', align: 'right',
                  render: (r: AttRequest) => (
                    <div className={styles.rowActions}>
                      <Button variant="secondary" size="sm" icon={<Check size={14} />} onClick={() => setDecide({ req: r, decision: 'approved' })}>Approve</Button>
                      <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={() => setDecide({ req: r, decision: 'rejected' })}>Reject</Button>
                    </div>
                  ),
                },
              ]}
              rows={approvals?.requests}
              rowKey={(r) => r.id}
              empty={<EmptyState icon={<UserCheck size={18} />} title="No pending requests" message="Approvals from your reports appear here." />}
              skeletonRows={3}
            />
          </Card>

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
        </>
      )}

      {/* Request OD / WFH / regularization — explicit submit. */}
      <Modal
        open={reqOpen}
        onClose={() => setReqOpen(false)}
        title={`Request ${REQUEST_KIND_LABEL[reqKind]}`}
        description="Routed to your manager for approval. The original system-captured punches are always preserved."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReqOpen(false)} disabled={submitRequest.isPending}>Cancel</Button>
            <Button variant="primary" icon={<UserCheck size={15} />} loading={submitRequest.isPending} disabled={!reqDate} onClick={() => submitRequest.mutate()}>
              Submit for approval
            </Button>
          </>
        }
      >
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Type</span>
            <select className={styles.input} value={reqKind} onChange={(e) => setReqKind(e.target.value as AttRequest['kind'])}>
              <option value="wfh">Work from home</option>
              <option value="od">On-Duty (off-site)</option>
              <option value="regularization">Regularize a past entry</option>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Date</span>
            <input className={styles.input} type="date" value={reqDate} onChange={(e) => setReqDate(e.target.value)} />
          </label>
          {reqKind === 'regularization' && (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Corrected in</span>
                <input className={styles.input} type="time" value={reqIn} onChange={(e) => setReqIn(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Corrected out</span>
                <input className={styles.input} type="time" value={reqOut} onChange={(e) => setReqOut(e.target.value)} />
              </label>
            </>
          )}
          <label className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.fieldLabel}>Reason</span>
            <textarea className={styles.input} rows={2} value={reqReason} onChange={(e) => setReqReason(e.target.value)} placeholder="Optional note for your manager" />
          </label>
        </div>
      </Modal>

      {/* Manager decision confirmation. */}
      <ConfirmDialog
        open={!!decide}
        onClose={() => setDecide(null)}
        onConfirm={() => decide && decideRequest.mutate({ id: decide.req.id, decision: decide.decision })}
        title={decide?.decision === 'approved' ? 'Approve request' : 'Reject request'}
        message={
          decide
            ? `${decide.decision === 'approved' ? 'Approve' : 'Reject'} ${decide.req.employeeName}'s ${REQUEST_KIND_LABEL[decide.req.kind]} for ${fmtDay(decide.req.requestDate)}?`
            : ''
        }
        confirmLabel={decide?.decision === 'approved' ? 'Approve' : 'Reject'}
        destructive={decide?.decision === 'rejected'}
        loading={decideRequest.isPending}
      />
    </>
  );
}
