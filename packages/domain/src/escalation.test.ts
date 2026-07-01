import { describe, it, expect } from 'vitest';
import { slaState, reminderDue, slaBook } from './escalation.js';

const H = 3_600_000;
const now = 1_000_000_000_000;

describe('SLA & escalation engine', () => {
  it('classifies SLA states by time to due', () => {
    expect(slaState({ dueAt: null, now }).state).toBe('NO_DUE');
    expect(slaState({ dueAt: now + 100, now, completedAt: now }).state).toBe('DONE');
    expect(slaState({ dueAt: now + 48 * H, now }).state).toBe('ON_TRACK');
    expect(slaState({ dueAt: now + 12 * H, now }).state).toBe('AT_RISK');
    expect(slaState({ dueAt: now + 2 * H, now }).state).toBe('DUE_SOON');
    expect(slaState({ dueAt: now - 1 * H, now }).state).toBe('BREACHED');
  });

  it('computes escalation tiers past due (capped at 3)', () => {
    expect(slaState({ dueAt: now - 1 * H, now }).escalationTier).toBe(1);
    expect(slaState({ dueAt: now - 25 * H, now }).escalationTier).toBe(2);
    expect(slaState({ dueAt: now - 49 * H, now }).escalationTier).toBe(3);
    expect(slaState({ dueAt: now - 500 * H, now }).escalationTier).toBe(3);
    expect(slaState({ dueAt: now - 1 * H, now }).overdueMs).toBe(1 * H);
  });

  it('reminderDue respects state, interval and last reminder', () => {
    expect(reminderDue({ dueAt: now + 48 * H, now })).toBe(false); // on track
    expect(reminderDue({ dueAt: now - H, now })).toBe(true);        // breached, never reminded
    expect(reminderDue({ dueAt: now - H, now, lastReminderAt: now - 1 * H })).toBe(false); // reminded recently
    expect(reminderDue({ dueAt: now - H, now, lastReminderAt: now - 48 * H })).toBe(true);  // stale reminder
    expect(reminderDue({ dueAt: null, now })).toBe(false);
  });

  it('slaBook rolls a compliance summary', () => {
    const book = slaBook([
      slaState({ dueAt: now + 48 * H, now }),
      slaState({ dueAt: now - H, now }),
      slaState({ dueAt: now - 30 * H, now }),
      slaState({ dueAt: null, now }),
      slaState({ dueAt: now + 100, now, completedAt: now }),
    ]);
    expect(book.total).toBe(5);
    expect(book.breached).toBe(2);
    expect(book.escalations).toBe(2);
    // withDue = 4 (excludes NO_DUE); compliance = (4-2)/4 = 50%.
    expect(book.compliancePct).toBe(50);
  });
});
