import { describe, it, expect } from 'vitest';
import { ifrs17Rollforward } from './ifrs17Disclosure.js';

describe('ifrs17Disclosure.ifrs17Rollforward', () => {
  const opening = { lrcExclLossMinor: 1_000_000, lossComponentMinor: 50_000, licMinor: 400_000 };
  const movements = {
    premiumsReceivedMinor: 600_000,
    insuranceRevenueMinor: 550_000,
    acquisitionCashFlowsMinor: 40_000,
    lossComponentRecognisedMinor: 20_000,
    lossComponentReversedMinor: 10_000,
    claimsIncurredMinor: 300_000,
    claimsPaidMinor: 250_000,
    financeExpenseLrcMinor: 15_000,
    financeExpenseLicMinor: 8_000,
  };
  const r = ifrs17Rollforward(opening, movements);

  it('rolls each column forward: opening + increases - decreases = closing', () => {
    // LRC excl loss: 1,000,000 + 600,000 + 15,000 - 550,000 - 40,000 = 1,025,000
    expect(r.lrcExclLoss.closing).toBe(1_025_000);
    // Loss component: 50,000 + 20,000 - 10,000 = 60,000
    expect(r.lossComponent.closing).toBe(60_000);
    // LIC: 400,000 + 300,000 + 8,000 - 250,000 = 458,000
    expect(r.lic.closing).toBe(458_000);
  });

  it('total closing ties across the three columns (disclosure identity)', () => {
    expect(r.totalOpening).toBe(1_450_000);
    expect(r.totalClosing).toBe(1_025_000 + 60_000 + 458_000);
    const cols = [r.lrcExclLoss, r.lossComponent, r.lic];
    const up = cols.flatMap((c) => c.increases).reduce((a, x) => a + x.amountMinor, 0);
    const down = cols.flatMap((c) => c.decreases).reduce((a, x) => a + x.amountMinor, 0);
    expect(r.totalClosing).toBe(r.totalOpening + up - down);
  });

  it('derives the insurance service result for the P&L note', () => {
    // service expense = 300,000 incurred + 20,000 loss rec - 10,000 reversal + 40,000 acq = 350,000
    expect(r.insuranceServiceExpenseMinor).toBe(350_000);
    expect(r.insuranceRevenueMinor).toBe(550_000);
    expect(r.insuranceServiceResultMinor).toBe(200_000);
    expect(r.insuranceFinanceExpenseMinor).toBe(23_000);
  });

  it('omits zero lines and handles a minimal movement set', () => {
    const minimal = ifrs17Rollforward(
      { lrcExclLossMinor: 100, lossComponentMinor: 0, licMinor: 0 },
      { premiumsReceivedMinor: 50, insuranceRevenueMinor: 30, claimsIncurredMinor: 20, claimsPaidMinor: 5 },
    );
    expect(minimal.lrcExclLoss.closing).toBe(120);
    expect(minimal.lossComponent.increases).toHaveLength(0);
    expect(minimal.lic.closing).toBe(15);
    expect(minimal.totalClosing).toBe(135);
  });
});
