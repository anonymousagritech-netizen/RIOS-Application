import { describe, it, expect } from 'vitest';
import { bucketCashFlows, type ScheduledCashItem } from './cashflowForecast.js';

const items: ScheduledCashItem[] = [
  { date: '2026-07-10', direction: 'INFLOW', amountMinor: 500_000, currency: 'USD', source: 'PREMIUM' },
  { date: '2026-07-20', direction: 'OUTFLOW', amountMinor: 200_000, currency: 'USD', source: 'CLAIM' },
  { date: '2026-08-15', direction: 'OUTFLOW', amountMinor: 300_000, currency: 'USD', source: 'TRADE' },
  { date: '2026-09-05', direction: 'INFLOW', amountMinor: 100_000, currency: 'USD', source: 'PREMIUM' },
];

describe('cashflowForecast.bucketCashFlows', () => {
  it('buckets items into monthly grids and nets each bucket', () => {
    const r = bucketCashFlows({ asOf: '2026-07-01', horizonDays: 90, bucketDays: 30, currency: 'USD', items });
    expect(r.buckets.length).toBe(3);
    expect(r.buckets.map((b) => b.bucketDate)).toEqual(['2026-07-01', '2026-07-31', '2026-08-30']);
    // Bucket 0 (Jul): +500k premium, -200k claim => net +300k
    expect(r.buckets[0]!.inflowMinor).toBe(500_000);
    expect(r.buckets[0]!.outflowMinor).toBe(200_000);
    expect(r.buckets[0]!.netMinor).toBe(300_000);
    expect(r.buckets[0]!.source).toBe('CLAIM+PREMIUM');
    // Bucket 1 (late Jul-Aug): -300k trade
    expect(r.buckets[1]!.netMinor).toBe(-300_000);
    // Bucket 2 (late Aug-Sep): +100k premium
    expect(r.buckets[2]!.netMinor).toBe(100_000);
  });

  it('totals inflows, outflows and the overall net', () => {
    const r = bucketCashFlows({ asOf: '2026-07-01', horizonDays: 90, bucketDays: 30, currency: 'USD', items });
    expect(r.totalInflowMinor).toBe(600_000);
    expect(r.totalOutflowMinor).toBe(500_000);
    expect(r.netMinor).toBe(100_000);
  });

  it('ignores items outside the [asOf, asOf+horizon) window', () => {
    const r = bucketCashFlows({
      asOf: '2026-07-01',
      horizonDays: 30,
      bucketDays: 30,
      currency: 'USD',
      items: [
        { date: '2026-06-30', direction: 'INFLOW', amountMinor: 999, currency: 'USD', source: 'PAST' },
        { date: '2026-07-15', direction: 'INFLOW', amountMinor: 100, currency: 'USD', source: 'IN' },
        { date: '2026-08-01', direction: 'INFLOW', amountMinor: 999, currency: 'USD', source: 'FUTURE' },
      ],
    });
    expect(r.buckets.length).toBe(1);
    expect(r.buckets[0]!.inflowMinor).toBe(100);
    expect(r.netMinor).toBe(100);
  });

  it('defaults to 30-day buckets', () => {
    const r = bucketCashFlows({ asOf: '2026-07-01', horizonDays: 60, currency: 'USD', items });
    expect(r.bucketDays).toBe(30);
    expect(r.buckets.length).toBe(2);
  });

  it('throws on a mixed-currency item set', () => {
    expect(() =>
      bucketCashFlows({
        asOf: '2026-07-01',
        horizonDays: 30,
        currency: 'USD',
        items: [{ date: '2026-07-10', direction: 'INFLOW', amountMinor: 1, currency: 'EUR', source: 'X' }],
      }),
    ).toThrow(/single currency/);
  });

  it('rejects a non-positive horizon', () => {
    expect(() => bucketCashFlows({ asOf: '2026-07-01', horizonDays: 0, currency: 'USD', items: [] })).toThrow();
  });
});
