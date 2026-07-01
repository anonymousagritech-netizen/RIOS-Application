import { describe, it, expect } from 'vitest';
import { recoveryPosition, applyInuring, aggregateByEvent, type RecoveryEntry } from './claimsRecovery.js';
import { money } from './money.js';

const usd = (major: number) => money(Math.round(major * 100), 'USD');

describe('claimsRecovery.recoveryPosition', () => {
  it('splits received vs expected and nets incurred / paid / outstanding', () => {
    const recoveries: RecoveryEntry[] = [
      { type: 'REINSURANCE', amount: usd(300), status: 'RECEIVED' },
      { type: 'SALVAGE', amount: usd(50), status: 'RECEIVED' },
      { type: 'SUBROGATION', amount: usd(100), status: 'EXPECTED' },
    ];
    const p = recoveryPosition(usd(1000), usd(600), recoveries);
    expect(p.receivedRecovered.amount).toBe(35000); // 350.00 cash in
    expect(p.expectedRecovered.amount).toBe(10000); // 100.00 anticipated
    expect(p.totalRecovered.amount).toBe(45000);
    expect(p.netIncurred.amount).toBe(1000_00 - 450_00); // 550.00
    expect(p.netPaid.amount).toBe(600_00 - 350_00); // 250.00
    expect(p.outstanding.amount).toBe(550_00 - 250_00); // 300.00 reserve to settle
  });

  it('buckets recoveries by type', () => {
    const p = recoveryPosition(usd(1000), usd(0), [
      { type: 'SALVAGE', amount: usd(40) },
      { type: 'SALVAGE', amount: usd(10) },
      { type: 'SUBROGATION', amount: usd(25) },
    ]);
    expect(p.byType.SALVAGE!.amount).toBe(5000);
    expect(p.byType.SUBROGATION!.amount).toBe(2500);
  });

  it('floors net at zero when recoveries exceed the loss (over-recovery)', () => {
    const p = recoveryPosition(usd(100), usd(100), [{ type: 'SUBROGATION', amount: usd(150), status: 'RECEIVED' }]);
    expect(p.netIncurred.amount).toBe(0);
    expect(p.netPaid.amount).toBe(0);
    expect(p.outstanding.amount).toBe(0);
  });

  it('treats status as EXPECTED by default', () => {
    const p = recoveryPosition(usd(1000), usd(1000), [{ type: 'REINSURANCE', amount: usd(400) }]);
    expect(p.expectedRecovered.amount).toBe(40000);
    expect(p.netPaid.amount).toBe(100000); // no cash recovered yet
    expect(p.netIncurred.amount).toBe(60000);
  });
});

describe('claimsRecovery.applyInuring', () => {
  it('reduces the loss the protected layer sees by inuring recoveries', () => {
    const r = applyInuring(usd(1000), [usd(200), usd(150)]);
    expect(r.inuringTotal.amount).toBe(35000);
    expect(r.netToProtected.amount).toBe(65000);
  });

  it('never goes below zero and handles no inuring cover', () => {
    expect(applyInuring(usd(100), [usd(250)]).netToProtected.amount).toBe(0);
    expect(applyInuring(usd(100), []).netToProtected.amount).toBe(10000);
  });
});

describe('claimsRecovery.aggregateByEvent', () => {
  it('aggregates claim losses to the occurrence level, sorted by total desc', () => {
    const agg = aggregateByEvent([
      { event: 'CAT-2026-01', loss: usd(500) },
      { event: 'CAT-2026-02', loss: usd(2000) },
      { event: 'CAT-2026-01', loss: usd(300) },
    ]);
    expect(agg).toHaveLength(2);
    expect(agg[0]).toMatchObject({ event: 'CAT-2026-02', count: 1 });
    expect(agg[0]!.total.amount).toBe(200000);
    expect(agg[1]).toMatchObject({ event: 'CAT-2026-01', count: 2 });
    expect(agg[1]!.total.amount).toBe(80000); // 500 + 300
  });
});
