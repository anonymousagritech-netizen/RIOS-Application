import { describe, it, expect } from 'vitest';
import { countsAsWorked, summariseMonth, attendancePayFactor, type AttendanceStatus } from './attendanceStatus.js';

describe('attendance status', () => {
  it('counts present, OD, WFH and regularized as worked; leave/holiday/absent not', () => {
    expect(countsAsWorked('present')).toBe(true);
    expect(countsAsWorked('od')).toBe(true);
    expect(countsAsWorked('wfh')).toBe(true);
    expect(countsAsWorked('regularized')).toBe(true);
    expect(countsAsWorked('on_leave')).toBe(false);
    expect(countsAsWorked('holiday')).toBe(false);
    expect(countsAsWorked('absent')).toBe(false);
    expect(countsAsWorked('weekend')).toBe(false);
  });

  it('summarises a month into worked vs non-worked buckets', () => {
    // 3 present + 1 od + 1 wfh + 1 regularized = 6 worked; 1 leave, 1 absent, 1 holiday, 2 weekend not.
    const m: AttendanceStatus[] = ['present', 'present', 'present', 'od', 'wfh', 'regularized', 'on_leave', 'absent', 'holiday', 'weekend', 'weekend'];
    const s = summariseMonth(m);
    expect(s.workedDays).toBe(6);
    expect(s.od).toBe(1);
    expect(s.wfh).toBe(1);
    expect(s.onLeave).toBe(1);
    expect(s.absent).toBe(1);
    expect(s.weekend).toBe(2);
    expect(s.present).toBe(4); // 3 present + the regularized day also counts as present-equivalent
  });

  it('computes an attendance pay factor, guarding divide-by-zero', () => {
    expect(attendancePayFactor(20, 22)).toBeCloseTo(0.909, 3); // 20 of 22 working days
    expect(attendancePayFactor(22, 22)).toBe(1);
    expect(attendancePayFactor(5, 0)).toBe(1); // no working days -> fixed salary unaffected
    expect(attendancePayFactor(30, 22)).toBe(1); // clamp at 1
  });
});
