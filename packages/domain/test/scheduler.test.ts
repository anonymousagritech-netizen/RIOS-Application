import { describe, it, expect } from 'vitest';
import { nextRun, isDue, dueJobs, advance, type Schedulable } from '../src/scheduler.js';

const MIN = 60_000;

describe('next run', () => {
  it('anchors a never-run job at the base time', () => {
    expect(nextRun(null, 60, 1000)).toBe(1000);
  });
  it('adds the interval to the last run', () => {
    expect(nextRun(0, 60, 0)).toBe(60 * MIN);
    expect(nextRun(10 * MIN, 30, 0)).toBe(10 * MIN + 30 * MIN);
  });
});

describe('is due', () => {
  const job: Schedulable = { intervalMinutes: 60, enabled: true, lastRunMs: 0 };
  it('is due once now reaches the next run', () => {
    expect(isDue(job, 60 * MIN)).toBe(true);
    expect(isDue(job, 60 * MIN - 1)).toBe(false);
  });
  it('is never due when disabled', () => {
    expect(isDue({ ...job, enabled: false }, 100 * MIN)).toBe(false);
  });
  it('a never-run enabled job is due at now', () => {
    expect(isDue({ intervalMinutes: 60, enabled: true, lastRunMs: null }, 5000)).toBe(true);
  });
});

describe('dueJobs & advance', () => {
  it('selects only the due, enabled jobs', () => {
    const now = 100 * MIN;
    const jobs: Schedulable[] = [
      { id: 'a', intervalMinutes: 60, enabled: true, lastRunMs: 0 },        // due (next at 60m)
      { id: 'b', intervalMinutes: 60, enabled: true, lastRunMs: 90 * MIN }, // next at 150m → not due
      { id: 'c', intervalMinutes: 60, enabled: false, lastRunMs: 0 },       // disabled
    ];
    expect(dueJobs(jobs, now).map((j) => j.id)).toEqual(['a']);
  });

  it('advances last/next after a run', () => {
    expect(advance(30, 100 * MIN)).toEqual({ lastRunMs: 100 * MIN, nextRunMs: 100 * MIN + 30 * MIN });
  });
});
