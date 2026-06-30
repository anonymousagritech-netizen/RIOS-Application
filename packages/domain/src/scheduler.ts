/**
 * Scheduler / job orchestration (brief §3 - scheduler). Pure scheduling maths:
 * given a job's interval and its last run, compute the next run and decide what
 * is due. Interval-based (every N minutes) rather than full cron - deterministic
 * and clock-free, so the server passes `now` in. The server persists jobs/runs
 * and triggers execution; this module only decides *when*.
 */

export interface Schedulable {
  id?: string;
  intervalMinutes: number;
  enabled: boolean;
  /** Epoch ms of the last run, or null if never run. */
  lastRunMs?: number | null;
}

/**
 * The next run time in epoch ms. A never-run job is due at `baseMs` (its anchor,
 * typically creation or now); otherwise it is lastRun + interval.
 */
export function nextRun(lastRunMs: number | null | undefined, intervalMinutes: number, baseMs: number): number {
  const step = Math.max(1, Math.floor(intervalMinutes)) * 60_000;
  if (lastRunMs == null) return baseMs;
  return lastRunMs + step;
}

/** Is the job due to run at `nowMs`? Disabled jobs are never due. */
export function isDue(job: Schedulable, nowMs: number, baseMs?: number): boolean {
  if (!job.enabled) return false;
  return nowMs >= nextRun(job.lastRunMs, job.intervalMinutes, baseMs ?? nowMs);
}

/** The subset of jobs due at `nowMs`. */
export function dueJobs<T extends Schedulable>(jobs: T[], nowMs: number): T[] {
  return (jobs ?? []).filter((j) => isDue(j, nowMs, nowMs));
}

/**
 * Advance a job after a run completes: returns the new lastRun (the run time)
 * and the next scheduled run.
 */
export function advance(intervalMinutes: number, ranAtMs: number): { lastRunMs: number; nextRunMs: number } {
  return { lastRunMs: ranAtMs, nextRunMs: nextRun(ranAtMs, intervalMinutes, ranAtMs) };
}
