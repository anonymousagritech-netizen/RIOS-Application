import { describe, it, expect } from 'vitest';
import { taskSla, taskSummary } from './tasks.js';

const H = 3600_000;
const now = 1_000_000_000_000;

describe('task SLA', () => {
  it('classifies a single task', () => {
    expect(taskSla('DONE', now - H, now)).toBe('DONE');
    expect(taskSla('CANCELLED', null, now)).toBe('DONE');
    expect(taskSla('OPEN', null, now)).toBe('NO_DUE');
    expect(taskSla('OPEN', now - H, now)).toBe('OVERDUE');
    expect(taskSla('OPEN', now + 24 * H, now)).toBe('DUE_SOON');
    expect(taskSla('IN_PROGRESS', now + 96 * H, now)).toBe('ON_TRACK');
  });

  it('rolls a set of tasks into a summary', () => {
    const s = taskSummary([
      { status: 'OPEN', dueAtMs: now - H, priority: 'HIGH' },        // overdue
      { status: 'IN_PROGRESS', dueAtMs: now + 24 * H, priority: 'MEDIUM' }, // due soon
      { status: 'OPEN', dueAtMs: now + 96 * H, priority: 'LOW' },    // on track
      { status: 'DONE', dueAtMs: now - H, priority: 'LOW' },         // done
      { status: 'OPEN', dueAtMs: null, priority: 'URGENT' },         // no due
    ], now);
    expect(s.total).toBe(5);
    expect(s.done).toBe(1);
    expect(s.open).toBe(4);
    expect(s.overdue).toBe(1);
    expect(s.dueSoon).toBe(1);
    expect(s.byPriority.HIGH).toBe(1);
    // dueTracked = 3 (overdue + due soon + on track), onTrack = 2 → 66.7%
    expect(s.slaCompliancePct).toBe(66.7);
  });

  it('reports 100% compliance when nothing is due-tracked', () => {
    const s = taskSummary([{ status: 'OPEN', dueAtMs: null }], now);
    expect(s.slaCompliancePct).toBe(100);
  });
});
