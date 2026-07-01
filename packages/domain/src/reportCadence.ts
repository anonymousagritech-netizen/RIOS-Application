/**
 * Report-schedule cadence maths - pure, deterministic, framework-free.
 *
 * Calendar cadences (daily … annual) for scheduled reports. Given a base date
 * (passed in - the module never reads the clock), advance to the next run. Used
 * by the scheduler tick to roll report_schedule.next_run_at. No I/O.
 */

export type ReportCadence = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

export const CADENCE_LABEL: Record<ReportCadence, string> = {
  DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', ANNUAL: 'Annual',
};

/** Advance `from` by exactly one cadence period (UTC), returning a new Date. */
export function nextReportRun(cadence: ReportCadence, from: Date): Date {
  const d = new Date(from.getTime());
  switch (cadence) {
    case 'DAILY': d.setUTCDate(d.getUTCDate() + 1); break;
    case 'WEEKLY': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'MONTHLY': d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'QUARTERLY': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'ANNUAL': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return d;
}

/** Whether a schedule with this next_run is due at `now` (both passed in). */
export function isReportDue(nextRun: Date | null, now: Date): boolean {
  if (!nextRun) return true; // never scheduled ⇒ due immediately
  return now.getTime() >= nextRun.getTime();
}

/** Approximate period length in days - for sorting / display only. */
export function cadenceDays(cadence: ReportCadence): number {
  switch (cadence) {
    case 'DAILY': return 1;
    case 'WEEKLY': return 7;
    case 'MONTHLY': return 30;
    case 'QUARTERLY': return 91;
    case 'ANNUAL': return 365;
  }
}
