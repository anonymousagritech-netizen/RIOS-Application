import { describe, it, expect } from 'vitest';
import { presentValue, csmProjection } from './ifrs17.js';
import { money, toMajor } from './money.js';

const usd = (major: number) => money(Math.round(major * 100), 'USD');

describe('ifrs17.presentValue', () => {
  it('discounts a flat-rate cash-flow vector', () => {
    // 100 at t=1 and t=2 at 10% => 100/1.1 + 100/1.21 = 90.909 + 82.645 = 173.55
    const pv = presentValue([usd(100), usd(100)], 0.10);
    expect(toMajor(pv)).toBeCloseTo(173.55, 2);
  });

  it('uses a spot-rate term structure by maturity', () => {
    // t1 @5%, t2 @6%: 100/1.05 + 100/1.06^2 = 95.238 + 88.999 = 184.24
    const pv = presentValue([usd(100), usd(100)], [0.05, 0.06]);
    expect(toMajor(pv)).toBeCloseTo(184.24, 2);
  });

  it('holds the last spot rate for longer maturities and rejects empty / bad rates', () => {
    const pv = presentValue([usd(100), usd(100), usd(100)], [0.05]); // 5% flat via held rate
    expect(toMajor(pv)).toBeCloseTo(100 / 1.05 + 100 / 1.05 ** 2 + 100 / 1.05 ** 3, 2);
    expect(() => presentValue([], 0.05)).toThrow(RangeError);
    expect(() => presentValue([usd(1)], -2)).toThrow(RangeError);
  });
});

describe('ifrs17.csmProjection', () => {
  it('amortises the CSM to zero over the coverage period on a coverage-unit basis', () => {
    // No interest, equal units => straight-line release to zero.
    const r = csmProjection({ openingCsm: usd(900), interestAccretionRate: 0, coverageUnits: [1, 1, 1] });
    expect(r.periods.map((p) => toMajor(p.released))).toEqual([300, 300, 300]);
    expect(toMajor(r.finalCsm)).toBe(0);
    expect(toMajor(r.totalReleased)).toBe(900);
  });

  it('accretes interest before releasing, so total released exceeds the opening CSM', () => {
    const r = csmProjection({ openingCsm: usd(1000), interestAccretionRate: 0.05, coverageUnits: [1, 1] });
    // period 1: 1000*1.05=1050, release half=525, closing 525
    // period 2: 525*1.05=551.25, release all, closing ~0
    expect(toMajor(r.periods[0]!.released)).toBeCloseTo(525, 2);
    expect(toMajor(r.finalCsm)).toBeCloseTo(0, 2);
    expect(toMajor(r.totalReleased)).toBeGreaterThan(1000);
  });

  it('adds new business CSM into the schedule', () => {
    const r = csmProjection({
      openingCsm: usd(0),
      interestAccretionRate: 0,
      coverageUnits: [1, 1],
      newBusinessByPeriod: [usd(200), usd(0)],
    });
    // period 1: 0 + 200 new business, release half => 100
    expect(toMajor(r.periods[0]!.released)).toBe(100);
    expect(toMajor(r.totalReleased)).toBe(200);
  });
});
