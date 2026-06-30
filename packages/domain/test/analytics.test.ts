import { describe, it, expect } from 'vitest';
import { pivot, totals, type Measure } from '../src/analytics.js';
import {
  averageAnnualLoss,
  exceedanceProbability,
  exceedanceCurve,
  probableMaximumLoss,
  pmlProfile,
  type EltEvent,
} from '../src/catastrophe.js';

const facts = [
  { lob: 'PROPERTY', ccy: 'USD', amountMinor: 100 },
  { lob: 'PROPERTY', ccy: 'USD', amountMinor: 300 },
  { lob: 'CASUALTY', ccy: 'USD', amountMinor: 200 },
  { lob: 'CASUALTY', ccy: 'EUR', amountMinor: 50 },
];

describe('pivot engine', () => {
  const measures: Measure[] = [
    { field: 'amountMinor', agg: 'sum', as: 'total' },
    { agg: 'count' },
  ];

  it('groups by one dimension and aggregates, sorted by first measure desc', () => {
    const cells = pivot(facts, ['lob'], measures);
    expect(cells).toHaveLength(2);
    // PROPERTY total 400 > CASUALTY total 250, so PROPERTY first.
    expect(cells[0]!.key.lob).toBe('PROPERTY');
    expect(cells[0]!.values.total).toBe(400);
    expect(cells[0]!.count).toBe(2);
    expect(cells[1]!.values.total).toBe(250);
  });

  it('supports multi-dimension grouping and avg/min/max', () => {
    const cells = pivot(facts, ['lob', 'ccy'], [
      { field: 'amountMinor', agg: 'avg', as: 'avg' },
      { field: 'amountMinor', agg: 'max', as: 'max' },
    ]);
    expect(cells).toHaveLength(3); // PROPERTY/USD, CASUALTY/USD, CASUALTY/EUR
    const propUsd = cells.find((c) => c.key.lob === 'PROPERTY' && c.key.ccy === 'USD')!;
    expect(propUsd.values.avg).toBe(200); // (100+300)/2
    expect(propUsd.values.max).toBe(300);
  });

  it('computes a grand total with no grouping', () => {
    expect(totals(facts, measures)).toEqual({ total: 650, count: 4 });
  });
});

// Clean ELT: AAL = 0.1*100 + 0.02*500 + 0.01*1000 = 30
const elt: EltEvent[] = [
  { id: 'A', rate: 0.1, lossMinor: 100 },
  { id: 'B', rate: 0.02, lossMinor: 500 },
  { id: 'C', rate: 0.01, lossMinor: 1000 },
];

describe('catastrophe metrics', () => {
  it('computes average annual loss', () => {
    expect(averageAnnualLoss(elt)).toBe(30);
  });

  it('computes occurrence exceedance probability above a threshold', () => {
    // events with loss > 400: B(0.02) + C(0.01) = 0.03 → 1 - e^-0.03
    expect(exceedanceProbability(elt, 400)).toBeCloseTo(1 - Math.exp(-0.03), 10);
    expect(exceedanceProbability(elt, 2000)).toBe(0);
  });

  it('derives PML at return periods from the cumulative rate', () => {
    expect(probableMaximumLoss(elt, 100)).toBe(1000); // cum rate reaches 0.01 at C
    expect(probableMaximumLoss(elt, 50)).toBe(500);   // 0.02 reached at B (cum 0.03)
    expect(probableMaximumLoss(elt, 10)).toBe(100);   // 0.10 reached at A (cum 0.13)
    // Rarer than any modelled event → caps at the largest modelled loss.
    expect(probableMaximumLoss(elt, 1000)).toBe(1000);
    expect(probableMaximumLoss([], 100)).toBe(0);     // no events
  });

  it('produces an ordered EP curve and a PML profile', () => {
    const curve = exceedanceCurve(elt);
    expect(curve.map((p) => p.lossMinor)).toEqual([1000, 500, 100]);
    expect(curve[0]!.returnPeriod).toBeCloseTo(100, 6); // 1/0.01
    const profile = pmlProfile(elt, [10, 50, 100]);
    expect(profile).toEqual([
      { returnPeriod: 10, lossMinor: 100 },
      { returnPeriod: 50, lossMinor: 500 },
      { returnPeriod: 100, lossMinor: 1000 },
    ]);
  });
});
