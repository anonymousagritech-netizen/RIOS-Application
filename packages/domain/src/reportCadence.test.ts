import { describe, it, expect } from 'vitest';
import { nextReportRun, isReportDue, cadenceDays } from './reportCadence.js';

const base = new Date('2026-01-31T09:00:00.000Z');

describe('report cadence', () => {
  it('advances each cadence by one period (UTC)', () => {
    expect(nextReportRun('DAILY', base).toISOString()).toBe('2026-02-01T09:00:00.000Z');
    expect(nextReportRun('WEEKLY', base).toISOString()).toBe('2026-02-07T09:00:00.000Z');
    // Jan 31 + 1 month rolls into March (JS date overflow) - documented behaviour.
    expect(nextReportRun('MONTHLY', base).toISOString()).toBe('2026-03-03T09:00:00.000Z');
    expect(nextReportRun('QUARTERLY', new Date('2026-01-15T00:00:00.000Z')).toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(nextReportRun('ANNUAL', new Date('2026-06-01T00:00:00.000Z')).toISOString()).toBe('2027-06-01T00:00:00.000Z');
  });

  it('does not mutate the input date', () => {
    const snapshot = base.getTime();
    nextReportRun('MONTHLY', base);
    expect(base.getTime()).toBe(snapshot);
  });

  it('isReportDue treats null next-run as due and compares times otherwise', () => {
    expect(isReportDue(null, base)).toBe(true);
    expect(isReportDue(new Date('2026-02-01T00:00:00Z'), base)).toBe(false);
    expect(isReportDue(new Date('2026-01-01T00:00:00Z'), base)).toBe(true);
  });

  it('cadenceDays orders periods', () => {
    expect(cadenceDays('DAILY')).toBeLessThan(cadenceDays('WEEKLY'));
    expect(cadenceDays('QUARTERLY')).toBeLessThan(cadenceDays('ANNUAL'));
  });
});
