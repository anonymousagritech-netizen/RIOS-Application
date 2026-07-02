import { describe, it, expect } from 'vitest';
import { fromMajor, money } from './money.js';
import {
  EARNING_PATTERNS,
  isEarningPattern,
  earnedFraction,
  computeUPR,
  computeDAC,
  type EarningPattern,
} from './earning.js';

// Annual period used throughout: 365 days, not a leap year.
const START = '2025-01-01';
const END = '2025-12-31';

describe('earnedFraction: boundaries (all patterns)', () => {
  it('earns nothing before inception', () => {
    for (const p of EARNING_PATTERNS) {
      expect(earnedFraction(p, START, END, '2024-12-31')).toBe(0);
      expect(earnedFraction(p, START, END, '2020-06-15')).toBe(0);
    }
  });

  it('is fully earned at/after expiry (except risk-attaching, whose tail runs on)', () => {
    for (const p of ['PRO_RATA', 'EIGHTHS', 'TWENTY_FOURTHS'] as EarningPattern[]) {
      expect(earnedFraction(p, START, END, END)).toBe(1);
      expect(earnedFraction(p, START, END, '2026-06-01')).toBe(1);
    }
    // Risk-attaching: policies attaching on the last day still have a term to
    // run, so the treaty is only half earned at its own expiry...
    expect(earnedFraction('RISK_ATTACHING', START, END, END)).toBeCloseTo(0.5, 12);
    // ...and fully earned one period length later (24 months from attachment).
    expect(earnedFraction('RISK_ATTACHING', START, END, '2026-12-31')).toBe(1);
    expect(earnedFraction('RISK_ATTACHING', START, END, '2030-01-01')).toBe(1);
  });

  it('stays within [0,1] and is monotonic through the earning window', () => {
    const dates = ['2024-12-31', START, '2025-03-31', '2025-06-30', '2025-09-30', END, '2026-06-30', '2026-12-31'];
    for (const p of EARNING_PATTERNS) {
      let prev = -1;
      for (const d of dates) {
        const f = earnedFraction(p, START, END, d);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
        expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
  });

  it('rejects an inverted period', () => {
    expect(() => earnedFraction('PRO_RATA', END, START, '2025-06-30')).toThrow(RangeError);
  });

  it('rejects malformed dates', () => {
    expect(() => earnedFraction('PRO_RATA', 'not-a-date', END, '2025-06-30')).toThrow(RangeError);
    expect(() => earnedFraction('PRO_RATA', START, END, '30/06/2025')).toThrow(RangeError);
  });
});

describe('earnedFraction: PRO_RATA (daily)', () => {
  it('earns the first day at the end of inception day', () => {
    expect(earnedFraction('PRO_RATA', START, END, START)).toBeCloseTo(1 / 365, 12);
  });

  it('earns 181/365 as of 30 June', () => {
    expect(earnedFraction('PRO_RATA', START, END, '2025-06-30')).toBeCloseTo(181 / 365, 12);
  });

  it('handles a leap-year period (366 days)', () => {
    // 2024 is a leap year: Jan..Dec = 366 days; 2024-06-30 is day 182.
    expect(earnedFraction('PRO_RATA', '2024-01-01', '2024-12-31', '2024-06-30')).toBeCloseTo(182 / 366, 12);
  });

  it('handles a single-day period', () => {
    expect(earnedFraction('PRO_RATA', '2025-07-01', '2025-07-01', '2025-06-30')).toBe(0);
    expect(earnedFraction('PRO_RATA', '2025-07-01', '2025-07-01', '2025-07-01')).toBe(1);
  });
});

describe('earnedFraction: EIGHTHS (quarterly steps)', () => {
  it('steps 0 → 1/8 → 3/8 → 5/8 at calendar-quarter ends', () => {
    expect(earnedFraction('EIGHTHS', START, END, '2025-03-30')).toBe(0); // Q1 not complete
    expect(earnedFraction('EIGHTHS', START, END, '2025-03-31')).toBe(1 / 8); // Q1 complete
    expect(earnedFraction('EIGHTHS', START, END, '2025-04-01')).toBe(1 / 8); // flat within Q2
    expect(earnedFraction('EIGHTHS', START, END, '2025-06-30')).toBe(3 / 8);
    expect(earnedFraction('EIGHTHS', START, END, '2025-08-15')).toBe(3 / 8);
    expect(earnedFraction('EIGHTHS', START, END, '2025-09-30')).toBe(5 / 8);
    expect(earnedFraction('EIGHTHS', START, END, '2025-12-30')).toBe(5 / 8); // Q4 not yet complete
  });

  it('snaps to fully earned at expiry (expired contracts carry no UPR)', () => {
    expect(earnedFraction('EIGHTHS', START, END, END)).toBe(1);
  });

  it('counts quarters from the calendar quarter containing a mid-quarter inception', () => {
    const s = '2025-02-15';
    const e = '2026-02-14';
    expect(earnedFraction('EIGHTHS', s, e, '2025-03-31')).toBe(1 / 8); // Q1-2025 complete
    expect(earnedFraction('EIGHTHS', s, e, '2025-06-30')).toBe(3 / 8);
    expect(earnedFraction('EIGHTHS', s, e, '2025-12-31')).toBe(7 / 8); // 4 quarters complete
    expect(earnedFraction('EIGHTHS', s, e, '2026-02-13')).toBe(7 / 8); // final 8th still unearned
    expect(earnedFraction('EIGHTHS', s, e, '2026-02-14')).toBe(1); // expiry
  });
});

describe('earnedFraction: TWENTY_FOURTHS (monthly steps)', () => {
  it('steps (2k−1)/24 at calendar-month ends', () => {
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-01-30')).toBe(0);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-01-31')).toBe(1 / 24);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-02-28')).toBe(3 / 24);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-06-30')).toBe(11 / 24);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-07-01')).toBe(11 / 24);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-11-30')).toBe(21 / 24);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-12-30')).toBe(21 / 24);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, END)).toBe(1); // expiry clamp (schedule alone says 23/24)
  });

  it('recognises February month-end, including leap years', () => {
    expect(earnedFraction('TWENTY_FOURTHS', '2024-01-01', '2024-12-31', '2024-02-29')).toBe(3 / 24);
    expect(earnedFraction('TWENTY_FOURTHS', '2024-01-01', '2024-12-31', '2024-02-28')).toBe(1 / 24);
  });

  it('is finer-grained than 8ths between quarter ends', () => {
    // End of Feb: 24ths has earned 3/24 = 0.125 but 8ths still 0 (Q1 incomplete).
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-02-28')).toBe(0.125);
    expect(earnedFraction('EIGHTHS', START, END, '2025-02-28')).toBe(0);
    // End of Q1: 8ths = 1/8, 24ths = 5/24 (three months at mid-month writing).
    expect(earnedFraction('EIGHTHS', START, END, '2025-03-31')).toBe(1 / 8);
    expect(earnedFraction('TWENTY_FOURTHS', START, END, '2025-03-31')).toBe(5 / 24);
  });
});

describe('earnedFraction: RISK_ATTACHING (quadratic S-curve over 2× the period)', () => {
  const W = 365;
  it('ramps up quadratically during the attachment period', () => {
    // t = 181 elapsed days as of 30 June: t² / 2W².
    expect(earnedFraction('RISK_ATTACHING', START, END, '2025-06-30')).toBeCloseTo((181 * 181) / (2 * W * W), 12);
    // Slower than pro-rata early on (premium attaches but has barely earned).
    expect(earnedFraction('RISK_ATTACHING', START, END, '2025-06-30'))
      .toBeLessThan(earnedFraction('PRO_RATA', START, END, '2025-06-30'));
  });

  it('is exactly half earned at the end of the attachment period', () => {
    expect(earnedFraction('RISK_ATTACHING', START, END, END)).toBeCloseTo(0.5, 12);
  });

  it('ramps down symmetrically in the run-off year', () => {
    // 546 elapsed days (2026-06-30): 1 − (2W−t)²/2W².
    const t = 546;
    expect(earnedFraction('RISK_ATTACHING', START, END, '2026-06-30'))
      .toBeCloseTo(1 - ((2 * W - t) * (2 * W - t)) / (2 * W * W), 12);
  });

  it('mirrors around the midpoint (f(t) + f(2W−t) = 1)', () => {
    const early = earnedFraction('RISK_ATTACHING', START, END, '2025-03-31'); // t = 90
    const late = earnedFraction('RISK_ATTACHING', START, END, '2026-10-01'); // t = 639 = 730−91 → pairs with t=91
    const early2 = earnedFraction('RISK_ATTACHING', START, END, '2025-04-01'); // t = 91
    expect(early2 + late).toBeCloseTo(1, 12);
    expect(early).toBeLessThan(early2);
  });
});

describe('computeUPR: integer exactness (earned + UPR === written)', () => {
  it('splits a clean annual premium exactly pro-rata', () => {
    // 365,000.00 USD over 365 days = 100,000 minor units per day.
    const written = fromMajor(365_000, 'USD');
    const r = computeUPR(written, 'PRO_RATA', START, END, '2025-06-30');
    expect(r.earnedPremium.amount).toBe(18_100_000); // 181 days
    expect(r.upr.amount).toBe(18_400_000); // 184 days
    expect(r.earnedPremium.amount + r.upr.amount).toBe(written.amount);
  });

  it('is UPR = written before inception and 0 after expiry', () => {
    const written = fromMajor(1_000_000, 'USD');
    for (const p of ['PRO_RATA', 'EIGHTHS', 'TWENTY_FOURTHS'] as EarningPattern[]) {
      const before = computeUPR(written, p, START, END, '2024-12-31');
      expect(before.earnedPremium.amount).toBe(0);
      expect(before.upr.amount).toBe(written.amount);
      const after = computeUPR(written, p, START, END, '2026-01-01');
      expect(after.earnedPremium.amount).toBe(written.amount);
      expect(after.upr.amount).toBe(0);
    }
  });

  it('never loses or invents a minor unit on awkward amounts, any pattern, any date', () => {
    const written = money(100_003, 'USD'); // indivisible amount
    const dates = ['2024-12-31', START, '2025-02-14', '2025-03-31', '2025-06-30', '2025-11-30', END, '2026-06-30', '2027-01-01'];
    for (const p of EARNING_PATTERNS) {
      for (const d of dates) {
        const r = computeUPR(written, p, START, END, d);
        expect(r.earnedPremium.amount + r.upr.amount).toBe(written.amount);
        expect(Number.isInteger(r.earnedPremium.amount)).toBe(true);
        expect(Number.isInteger(r.upr.amount)).toBe(true);
        expect(r.upr.amount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is exact for zero-decimal currencies (JPY)', () => {
    const written = money(1_000_001, 'JPY');
    const r = computeUPR(written, 'TWENTY_FOURTHS', START, END, '2025-06-30');
    expect(r.earnedPremium.amount + r.upr.amount).toBe(written.amount);
    expect(r.earnedPremium.currency).toBe('JPY');
  });

  it('applies the 8ths step to the money split', () => {
    const written = fromMajor(800_000, 'USD');
    const r = computeUPR(written, 'EIGHTHS', START, END, '2025-06-30');
    expect(r.fraction).toBe(3 / 8);
    expect(r.earnedPremium.amount).toBe(30_000_000); // 300,000.00
    expect(r.upr.amount).toBe(50_000_000); // 500,000.00
  });
});

describe('computeDAC', () => {
  it('amortises acquisition cost on the same pattern and stays integer-exact', () => {
    const cost = fromMajor(91_250, 'USD'); // 25% of 365,000
    const r = computeDAC(cost, 'PRO_RATA', START, END, '2025-06-30');
    expect(r.fraction).toBeCloseTo(181 / 365, 12);
    expect(r.amortised.amount).toBe(4_525_000); // 25,000/day × 181
    expect(r.dac.amount).toBe(4_600_000);
    expect(r.amortised.amount + r.dac.amount).toBe(cost.amount);
  });

  it('matches the premium earning fraction exactly (matching principle)', () => {
    const written = money(7_777_777, 'USD');
    const cost = money(1_944_443, 'USD');
    for (const p of EARNING_PATTERNS) {
      const u = computeUPR(written, p, START, END, '2025-08-15');
      const d = computeDAC(cost, p, START, END, '2025-08-15');
      expect(d.fraction).toBe(u.fraction);
      expect(d.amortised.amount + d.dac.amount).toBe(cost.amount);
    }
  });

  it('defers everything before inception and nothing after expiry', () => {
    const cost = fromMajor(10_000, 'EUR');
    const before = computeDAC(cost, 'EIGHTHS', START, END, '2024-06-30');
    expect(before.dac.amount).toBe(cost.amount);
    const after = computeDAC(cost, 'EIGHTHS', START, END, '2026-06-30');
    expect(after.dac.amount).toBe(0);
    expect(after.amortised.amount).toBe(cost.amount);
  });
});

describe('isEarningPattern', () => {
  it('accepts the four patterns and rejects everything else', () => {
    for (const p of EARNING_PATTERNS) expect(isEarningPattern(p)).toBe(true);
    expect(isEarningPattern('pro_rata')).toBe(false);
    expect(isEarningPattern('365THS')).toBe(false);
    expect(isEarningPattern(undefined)).toBe(false);
    expect(isEarningPattern(8)).toBe(false);
  });
});
