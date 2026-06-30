/**
 * Attendance day-status model and the pure rules that depend on it.
 *
 * Each working day resolves to exactly one enumerated status (never a bag of
 * contradictory booleans). OD (on-duty / off-site business) and WFH count as
 * worked days for payroll attendance-linked components; leave/holiday/weekend
 * and absence do not.
 */

export type AttendanceStatus =
  | 'present'
  | 'checked_out'
  | 'od'        // on-duty: off-site for business (client visit, field, conference)
  | 'wfh'       // work from home
  | 'regularized' // a corrected past entry, approved
  | 'on_break'
  | 'on_leave'
  | 'holiday'
  | 'weekend'
  | 'absent';

const WORKED: ReadonlySet<AttendanceStatus> = new Set<AttendanceStatus>([
  'present', 'checked_out', 'od', 'wfh', 'regularized', 'on_break',
]);

/** Does this status count as a worked day for payroll/leave-accrual purposes? */
export function countsAsWorked(status: AttendanceStatus): boolean {
  return WORKED.has(status);
}

export interface AttendanceMonthSummary {
  workedDays: number;
  present: number;
  od: number;
  wfh: number;
  onLeave: number;
  absent: number;
  holiday: number;
  weekend: number;
  regularized: number;
}

/** Roll a month's per-day statuses into a summary used by the calendar header. */
export function summariseMonth(statuses: AttendanceStatus[]): AttendanceMonthSummary {
  const s: AttendanceMonthSummary = {
    workedDays: 0, present: 0, od: 0, wfh: 0, onLeave: 0, absent: 0, holiday: 0, weekend: 0, regularized: 0,
  };
  for (const st of statuses) {
    if (countsAsWorked(st)) s.workedDays += 1;
    if (st === 'present' || st === 'checked_out' || st === 'on_break') s.present += 1;
    else if (st === 'od') s.od += 1;
    else if (st === 'wfh') s.wfh += 1;
    else if (st === 'regularized') { s.regularized += 1; s.present += 1; }
    else if (st === 'on_leave') s.onLeave += 1;
    else if (st === 'absent') s.absent += 1;
    else if (st === 'holiday') s.holiday += 1;
    else if (st === 'weekend') s.weekend += 1;
  }
  return s;
}

/**
 * Attendance-linked pay factor: fraction of the pay period actually worked,
 * used where a pay component is proportional to attendance. Returns 1 when the
 * period has no working days (avoids divide-by-zero) so fixed salaries are
 * unaffected.
 */
export function attendancePayFactor(workedDays: number, workingDaysInPeriod: number): number {
  if (workingDaysInPeriod <= 0) return 1;
  return Math.min(1, Math.max(0, workedDays / workingDaysInPeriod));
}
