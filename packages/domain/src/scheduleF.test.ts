import { describe, it, expect } from 'vitest';
import { money, MoneyError } from './money.js';
import {
  scheduleFProvision,
  ratingIsSecure,
  ILLUSTRATIVE_OVERDUE_PROVISION_RATE,
  type ScheduleFCounterparty,
} from './scheduleF.js';

const usd = (minor: number) => money(minor, 'USD');

const cp = (over: Partial<ScheduleFCounterparty> = {}): ScheduleFCounterparty => ({
  counterparty: 'Re Co',
  authorized: true,
  recoverable: usd(1_000_000),
  overdue: usd(0),
  collateral: usd(0),
  ...over,
});

describe('scheduleF.ratingIsSecure (illustrative default sets)', () => {
  it('treats investment-grade agency ratings as secure', () => {
    expect(ratingIsSecure('SP', 'AA-')).toBe(true);
    expect(ratingIsSecure('sp', 'BBB-')).toBe(true); // agency case-insensitive
    expect(ratingIsSecure('AM_BEST', 'A-')).toBe(true);
    expect(ratingIsSecure('MOODYS', 'Baa3')).toBe(true);
  });

  it('fails closed for sub-grade, unknown ratings and unknown agencies', () => {
    expect(ratingIsSecure('SP', 'BB+')).toBe(false);
    expect(ratingIsSecure('SP', 'aa-')).toBe(false); // rating symbols are exact
    expect(ratingIsSecure('UNKNOWN_AGENCY', 'AAA')).toBe(false);
    expect(ratingIsSecure('INTERNAL', 'WATCHLIST')).toBe(false);
  });

  it('accepts a caller-supplied (tenant-configured) secure set', () => {
    expect(ratingIsSecure('INTERNAL', 'GREEN', { INTERNAL: ['GREEN'] })).toBe(true);
    expect(ratingIsSecure('SP', 'AAA', { INTERNAL: ['GREEN'] })).toBe(false);
  });
});

describe('scheduleF.scheduleFProvision', () => {
  it('authorized with nothing overdue attracts no provision', () => {
    const r = scheduleFProvision([cp()], 'USD');
    expect(r.lines[0]!.provision.amount).toBe(0);
    expect(r.lines[0]!.net.amount).toBe(1_000_000);
    expect(r.totals.provision.amount).toBe(0);
    expect(r.overdueProvisionRate).toBe(ILLUSTRATIVE_OVERDUE_PROVISION_RATE);
  });

  it('authorized overdue attracts the overdue rate (illustrative default 20%)', () => {
    const r = scheduleFProvision([cp({ overdue: usd(400_000) })], 'USD');
    expect(r.lines[0]!.provision.amount).toBe(80_000); // 20% of 400,000
    expect(r.totals.netRecoverable.amount).toBe(920_000);
  });

  it('unauthorized & uncollateralized is provisioned in full', () => {
    const r = scheduleFProvision([cp({ authorized: false })], 'USD');
    expect(r.lines[0]!.uncollateralized.amount).toBe(1_000_000);
    expect(r.lines[0]!.provision.amount).toBe(1_000_000);
    expect(r.lines[0]!.net.amount).toBe(0);
  });

  it('unauthorized with partial collateral: shortfall + 20% of collateralized overdue', () => {
    const r = scheduleFProvision(
      [cp({ authorized: false, collateral: usd(600_000), overdue: usd(500_000) })],
      'USD',
    );
    // shortfall 400,000 + 20% × min(overdue 500,000, collateral 600,000) = 400,000 + 100,000
    expect(r.lines[0]!.uncollateralized.amount).toBe(400_000);
    expect(r.lines[0]!.provision.amount).toBe(500_000);
  });

  it('unauthorized fully collateralized still carries the overdue penalty only', () => {
    const r = scheduleFProvision(
      [cp({ authorized: false, collateral: usd(2_000_000), overdue: usd(300_000) })],
      'USD',
    );
    expect(r.lines[0]!.uncollateralized.amount).toBe(0);
    expect(r.lines[0]!.provision.amount).toBe(60_000); // 20% of 300,000
  });

  it('caps the provision at the exposure and clamps overdue into it', () => {
    const r = scheduleFProvision(
      [cp({ authorized: false, overdue: usd(5_000_000), collateral: usd(0) })],
      'USD',
    );
    expect(r.lines[0]!.overdue.amount).toBe(1_000_000); // clamped to exposure
    expect(r.lines[0]!.provision.amount).toBe(1_000_000); // never exceeds exposure
  });

  it('a net-payable (negative recoverable) counterparty needs no provision', () => {
    const r = scheduleFProvision([cp({ authorized: false, recoverable: usd(-50_000) })], 'USD');
    expect(r.lines[0]!.provision.amount).toBe(0);
    expect(r.lines[0]!.net.amount).toBe(-50_000);
  });

  it('totals split authorized vs unauthorized and reconcile to net', () => {
    const r = scheduleFProvision(
      [
        cp({ counterparty: 'Auth Re', overdue: usd(100_000) }),
        cp({ counterparty: 'Unauth Re', authorized: false, recoverable: usd(500_000), collateral: usd(200_000) }),
      ],
      'USD',
    );
    expect(r.totals.authorizedRecoverable.amount).toBe(1_000_000);
    expect(r.totals.unauthorizedRecoverable.amount).toBe(500_000);
    expect(r.totals.authorizedProvision.amount).toBe(20_000);
    expect(r.totals.unauthorizedProvision.amount).toBe(300_000);
    expect(r.totals.provision.amount).toBe(320_000);
    expect(r.totals.netRecoverable.amount).toBe(1_500_000 - 320_000);
    // authorized/unauthorized splits cross-foot to the grand totals
    expect(r.totals.authorizedRecoverable.amount + r.totals.unauthorizedRecoverable.amount).toBe(
      r.totals.recoverable.amount,
    );
    expect(r.totals.authorizedProvision.amount + r.totals.unauthorizedProvision.amount).toBe(
      r.totals.provision.amount,
    );
  });

  it('the overdue rate is configurable (illustrative default, not a certified factor)', () => {
    const r = scheduleFProvision([cp({ overdue: usd(400_000) })], 'USD', { overdueProvisionRate: 0.5 });
    expect(r.lines[0]!.provision.amount).toBe(200_000);
    expect(r.overdueProvisionRate).toBe(0.5);
  });

  it('handles an empty book with an explicit currency', () => {
    const r = scheduleFProvision([], 'USD');
    expect(r.lines).toHaveLength(0);
    expect(r.totals.recoverable.amount).toBe(0);
    expect(r.totals.netRecoverable.currency).toBe('USD');
  });

  it('rejects invalid rates, negative collateral/overdue and mixed currencies', () => {
    expect(() => scheduleFProvision([cp()], 'USD', { overdueProvisionRate: 1.5 })).toThrow(MoneyError);
    expect(() => scheduleFProvision([cp({ collateral: usd(-1) })], 'USD')).toThrow(MoneyError);
    expect(() => scheduleFProvision([cp({ overdue: usd(-1) })], 'USD')).toThrow(MoneyError);
    expect(() =>
      scheduleFProvision([cp({ recoverable: money(1_000, 'EUR'), overdue: money(0, 'EUR'), collateral: money(0, 'EUR') })], 'USD'),
    ).toThrow(MoneyError);
  });
});
