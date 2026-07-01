/**
 * Task SLA logic - pure, deterministic, framework-free.
 *
 * Given a due time and the current time (passed in - the domain stays clockless),
 * classify a task's SLA state and roll a set of tasks into a summary. Used by the
 * operations / task console. No I/O.
 */

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
export type TaskSla = 'DONE' | 'NO_DUE' | 'ON_TRACK' | 'DUE_SOON' | 'OVERDUE';

const DUE_SOON_MS = 48 * 3600_000; // within 48h is "due soon"

/** SLA state for a single task. */
export function taskSla(status: TaskStatus, dueAtMs: number | null, nowMs: number): TaskSla {
  if (status === 'DONE' || status === 'CANCELLED') return 'DONE';
  if (dueAtMs == null) return 'NO_DUE';
  if (nowMs > dueAtMs) return 'OVERDUE';
  if (dueAtMs - nowMs <= DUE_SOON_MS) return 'DUE_SOON';
  return 'ON_TRACK';
}

export interface TaskLike { status: TaskStatus; dueAtMs: number | null; priority?: string; }

export interface TaskSummary {
  total: number;
  open: number;            // not done/cancelled
  overdue: number;
  dueSoon: number;
  done: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  slaCompliancePct: number; // share of due, non-done tasks that are not overdue
}

/** Roll a set of tasks into operations KPIs. */
export function taskSummary(tasks: TaskLike[], nowMs: number): TaskSummary {
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let open = 0, overdue = 0, dueSoon = 0, done = 0, dueTracked = 0, onTrack = 0;
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    if (t.priority) byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
    const sla = taskSla(t.status, t.dueAtMs, nowMs);
    if (sla === 'DONE') { done++; continue; }
    open++;
    if (sla === 'OVERDUE') { overdue++; dueTracked++; }
    else if (sla === 'DUE_SOON') { dueSoon++; dueTracked++; onTrack++; }
    else if (sla === 'ON_TRACK') { dueTracked++; onTrack++; }
  }
  return {
    total: tasks.length, open, overdue, dueSoon, done, byStatus, byPriority,
    slaCompliancePct: dueTracked > 0 ? Math.round((onTrack / dueTracked) * 1000) / 10 : 100,
  };
}
