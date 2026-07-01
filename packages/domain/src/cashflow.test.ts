import { describe, it, expect } from 'vitest';
import { projectCashFlow, stressCashFlow, type CashFlowPeriod } from './cashflow.js';

const periods: CashFlowPeriod[] = [
  { label: 'Q1', inflowsMinor: 500_000, outflowsMinor: 300_000 },
  { label: 'Q2', inflowsMinor: 200_000, outflowsMinor: 600_000 },
  { label: 'Q3', inflowsMinor: 400_000, outflowsMinor: 350_000 },
];

describe('cashflow.projectCashFlow', () => {
  it('rolls the balance forward and reports the running closing', () => {
    const r = projectCashFlow(100_000, periods);
    expect(r.periods.map((p) => p.closingMinor)).toEqual([300_000, -100_000, -50_000]);
    expect(r.closingMinor).toBe(-50_000);
    expect(r.totalInflowsMinor).toBe(1_100_000);
    expect(r.totalOutflowsMinor).toBe(1_250_000);
  });

  it('flags shortfall periods and the minimum balance', () => {
    const r = projectCashFlow(100_000, periods);
    expect(r.shortfallPeriods).toEqual(['Q2', 'Q3']);
    expect(r.minClosingMinor).toBe(-100_000);
  });

  it('never dips below opening when inflows dominate', () => {
    const r = projectCashFlow(0, [{ label: 'M1', inflowsMinor: 100, outflowsMinor: 0 }]);
    expect(r.shortfallPeriods).toEqual([]);
    expect(r.closingMinor).toBe(100);
  });
});

describe('cashflow.stressCashFlow', () => {
  it('haircuts inflows and uplifts outflows, worsening liquidity', () => {
    const base = projectCashFlow(100_000, periods);
    const stressed = stressCashFlow(100_000, periods, { inflowHaircut: 0.2, outflowUplift: 0.25 });
    expect(stressed.minClosingMinor).toBeLessThan(base.minClosingMinor);
    // Q1 stressed: in 400,000 out 375,000 => net +25,000 => closing 125,000
    expect(stressed.periods[0]!.closingMinor).toBe(125_000);
  });
});
