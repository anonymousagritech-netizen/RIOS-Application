import { describe, it, expect } from 'vitest';
import { epochDay, agingReport, applyReceipt, invoiceStatus, type AgingItem, type OpenItem } from './aging.js';

describe('aging.epochDay', () => {
  it('computes deterministic day differences', () => {
    expect(epochDay('2026-01-31') - epochDay('2026-01-01')).toBe(30);
    expect(epochDay('2026-03-01') - epochDay('2026-02-01')).toBe(28); // 2026 not a leap year
    expect(epochDay('2024-03-01') - epochDay('2024-02-01')).toBe(29); // 2024 leap year
    expect(() => epochDay('nope')).toThrow(RangeError);
  });
});

describe('aging.agingReport', () => {
  const items: AgingItem[] = [
    { ref: 'not-due', outstandingMinor: 10000, dueDate: '2026-07-15' }, // future -> Current
    { ref: 'd10', outstandingMinor: 20000, dueDate: '2026-06-21' }, // 10 dpd -> 1-30
    { ref: 'd45', outstandingMinor: 30000, dueDate: '2026-05-17' }, // 45 dpd -> 31-60
    { ref: 'd120', outstandingMinor: 40000, dueDate: '2026-03-03' }, // 120 dpd -> 90+
    { ref: 'zero', outstandingMinor: 0, dueDate: '2026-01-01' }, // ignored
  ];
  const rep = agingReport(items, '2026-07-01');

  it('buckets outstanding by days past due', () => {
    const byLabel = Object.fromEntries(rep.buckets.map((b) => [b.label, b.totalMinor]));
    expect(byLabel.Current).toBe(10000);
    expect(byLabel['1-30']).toBe(20000);
    expect(byLabel['31-60']).toBe(30000);
    expect(byLabel['61-90']).toBe(0);
    expect(byLabel['91+']).toBe(40000);
  });

  it('totals and overdue exclude not-yet-due, and weight the average by balance', () => {
    expect(rep.totalMinor).toBe(100000);
    expect(rep.overdueMinor).toBe(90000); // everything except the not-due 10,000
    // weighted dpd = (0*10000 + 10*20000 + 45*30000 + 120*40000) / 100000 = 63.5 -> 64
    expect(rep.weightedAvgDaysPastDue).toBe(64);
  });

  it('honours custom bucket boundaries', () => {
    const r = agingReport([{ outstandingMinor: 500, dueDate: '2026-06-24' }], '2026-07-01', [7, 14]);
    const labels = r.buckets.map((b) => b.label);
    expect(labels).toEqual(['Current', '1-7', '8-14', '15+']);
    expect(r.buckets.find((b) => b.label === '1-7')!.totalMinor).toBe(500); // 7 dpd
  });
});

describe('aging.applyReceipt', () => {
  const items: OpenItem[] = [
    { ref: 'newest', outstandingMinor: 5000, dueDate: '2026-06-01' },
    { ref: 'oldest', outstandingMinor: 3000, dueDate: '2026-01-01' },
    { ref: 'mid', outstandingMinor: 4000, dueDate: '2026-03-01' },
  ];

  it('applies oldest-first and reconciles applied + unapplied to the receipt', () => {
    const r = applyReceipt(items, 6000, 'oldest');
    const byRef = Object.fromEntries(r.allocations.map((a) => [a.ref, a]));
    expect(byRef.oldest!.appliedMinor).toBe(3000); // fully paid first
    expect(byRef.oldest!.fullyPaid).toBe(true);
    expect(byRef.mid!.appliedMinor).toBe(3000); // remaining 3000 onto next-oldest
    expect(byRef.mid!.remainingMinor).toBe(1000);
    expect(byRef.newest!.appliedMinor).toBe(0);
    expect(r.appliedMinor + r.unappliedMinor).toBe(6000);
    expect(r.unappliedMinor).toBe(0);
  });

  it('returns the overpayment as unapplied', () => {
    const r = applyReceipt(items, 20000, 'oldest');
    expect(r.appliedMinor).toBe(12000); // total outstanding
    expect(r.unappliedMinor).toBe(8000);
    expect(r.allocations.every((a) => a.fullyPaid)).toBe(true);
  });

  it('supports largest-first ordering and rejects negative receipts', () => {
    const r = applyReceipt(items, 5000, 'largest');
    expect(r.allocations[0]!.ref).toBe('newest'); // 5000 is the largest
    expect(r.allocations[0]!.appliedMinor).toBe(5000);
    expect(() => applyReceipt(items, -1)).toThrow(RangeError);
  });
});

describe('aging.invoiceStatus', () => {
  it('resolves settled / part-paid / overdue / open', () => {
    expect(invoiceStatus(1000, 1000, '2026-01-01', '2026-07-01')).toBe('SETTLED');
    expect(invoiceStatus(1000, 400, '2026-08-01', '2026-07-01')).toBe('PART_PAID');
    expect(invoiceStatus(1000, 0, '2026-06-01', '2026-07-01')).toBe('OVERDUE');
    expect(invoiceStatus(1000, 0, '2026-08-01', '2026-07-01')).toBe('OPEN');
  });
});
