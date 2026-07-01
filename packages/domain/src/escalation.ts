/**
 * SLA & escalation engine - pure, deterministic, framework-free.
 *
 * Given a work item's due time and the current time (both passed in - the module
 * never reads the clock), classify its SLA state, compute an escalation tier
 * (how far past due, in escalation steps) and decide whether a reminder is due.
 * Used by the workflow engine to drive escalations and reminders. No I/O.
 */

export type SlaState = 'ON_TRACK' | 'AT_RISK' | 'DUE_SOON' | 'BREACHED' | 'DONE' | 'NO_DUE';

export interface SlaInput {
  dueAt: number | null;        // epoch ms, or null if no SLA
  now: number;                 // epoch ms
  completedAt?: number | null; // epoch ms if the item is finished
  atRiskMs?: number;           // lead time before due to flag AT_RISK (default 24h)
  dueSoonMs?: number;          // tighter lead time for DUE_SOON (default 4h)
  escalationStepMs?: number;   // size of one escalation tier past due (default 24h)
}

export interface SlaResult {
  state: SlaState;
  overdueMs: number;           // ms past due (0 if not past due)
  remainingMs: number;         // ms until due (0 if past due / no due)
  escalationTier: number;      // 0 = not breached; 1,2,3… tiers past due
  breached: boolean;
}

const H = 3_600_000;

/** Classify a single work item's SLA state and escalation tier. */
export function slaState(input: SlaInput): SlaResult {
  const atRisk = input.atRiskMs ?? 24 * H;
  const dueSoon = input.dueSoonMs ?? 4 * H;
  const step = Math.max(1, input.escalationStepMs ?? 24 * H);

  if (input.completedAt != null) {
    return { state: 'DONE', overdueMs: 0, remainingMs: 0, escalationTier: 0, breached: false };
  }
  if (input.dueAt == null) {
    return { state: 'NO_DUE', overdueMs: 0, remainingMs: 0, escalationTier: 0, breached: false };
  }

  const delta = input.dueAt - input.now; // >0 => time remaining, <0 => overdue
  if (delta < 0) {
    const overdue = -delta;
    return {
      state: 'BREACHED', overdueMs: overdue, remainingMs: 0,
      escalationTier: Math.min(3, Math.floor(overdue / step) + 1), breached: true,
    };
  }
  const state: SlaState = delta <= dueSoon ? 'DUE_SOON' : delta <= atRisk ? 'AT_RISK' : 'ON_TRACK';
  return { state, overdueMs: 0, remainingMs: delta, escalationTier: 0, breached: false };
}

/**
 * Whether a reminder should fire: an open, due-bearing item whose last reminder
 * (if any) is older than the reminder interval, and which is at-risk or worse.
 */
export function reminderDue(input: SlaInput & { lastReminderAt?: number | null; reminderIntervalMs?: number }): boolean {
  const s = slaState(input);
  if (s.state === 'DONE' || s.state === 'NO_DUE' || s.state === 'ON_TRACK') return false;
  const interval = input.reminderIntervalMs ?? 24 * H;
  if (input.lastReminderAt == null) return true;
  return input.now - input.lastReminderAt >= interval;
}

export interface SlaBook {
  total: number;
  onTrack: number;
  atRisk: number;
  dueSoon: number;
  breached: number;
  done: number;
  compliancePct: number;       // (total − breached) / withDue, as a %
  escalations: number;         // count with escalationTier >= 1
}

/** Roll a set of SLA results into a compliance summary. */
export function slaBook(results: SlaResult[]): SlaBook {
  const withDue = results.filter((r) => r.state !== 'NO_DUE').length;
  const breached = results.filter((r) => r.breached).length;
  return {
    total: results.length,
    onTrack: results.filter((r) => r.state === 'ON_TRACK').length,
    atRisk: results.filter((r) => r.state === 'AT_RISK').length,
    dueSoon: results.filter((r) => r.state === 'DUE_SOON').length,
    breached,
    done: results.filter((r) => r.state === 'DONE').length,
    compliancePct: withDue > 0 ? Math.round(((withDue - breached) / withDue) * 1000) / 10 : 100,
    escalations: results.filter((r) => r.escalationTier >= 1).length,
  };
}
