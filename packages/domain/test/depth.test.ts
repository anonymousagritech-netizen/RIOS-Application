import { describe, it, expect } from 'vitest';
import { fromMajor, money } from '../src/money.js';
import { progressiveTax, runPayslip, payrollRunTotals } from '../src/payroll.js';
import { portfolioTransfer } from '../src/proportional.js';
import {
  gmmInitialMeasurement,
  csmRollforward,
  vfaCsmRollforward,
} from '../src/ifrs17.js';

describe('payroll', () => {
  const bands = [
    { from: 0, rate: 0 },
    { from: fromMajor(1000, 'USD').amount, rate: 0.1 }, // 10% above 1,000
    { from: fromMajor(3000, 'USD').amount, rate: 0.2 }, // 20% above 3,000
  ];

  it('applies progressive tax marginally', () => {
    // taxable 4,000: 0 on first 1,000; 10% on next 2,000 (=200); 20% on last 1,000 (=200) => 400
    expect(progressiveTax(fromMajor(4000, 'USD'), bands).amount).toBe(fromMajor(400, 'USD').amount);
    expect(progressiveTax(fromMajor(500, 'USD'), bands).amount).toBe(0);
  });

  it('computes a full gross-to-net payslip', () => {
    const r = runPayslip({
      baseSalary: fromMajor(5000, 'USD'),
      earnings: [{ code: 'BONUS', amount: fromMajor(1000, 'USD'), taxable: true }],
      preTaxDeductions: [{ code: 'PENSION', amount: fromMajor(600, 'USD') }],
      taxBands: bands,
      employeeSocialRate: 0.05,
      employerSocialRate: 0.1,
    });
    expect(r.gross.amount).toBe(fromMajor(6000, 'USD').amount);
    // taxable = 6000 - 600 = 5400; tax: 10%*2000 + 20%*2400 = 200 + 480 = 680
    expect(r.taxablePay.amount).toBe(fromMajor(5400, 'USD').amount);
    expect(r.incomeTax.amount).toBe(fromMajor(680, 'USD').amount);
    // employee social 5% of 5400 = 270
    expect(r.employeeSocial.amount).toBe(fromMajor(270, 'USD').amount);
    // net = 6000 - 600 - 680 - 270 = 4450
    expect(r.net.amount).toBe(fromMajor(4450, 'USD').amount);
    // employer cost = 6000 + 10%*6000 = 6600
    expect(r.employerCost.amount).toBe(fromMajor(6600, 'USD').amount);
  });

  it('totals a payroll run', () => {
    const p = runPayslip({ baseSalary: fromMajor(3000, 'USD'), taxBands: bands, employeeSocialRate: 0.05, employerSocialRate: 0.1 });
    const t = payrollRunTotals([p, p], 'USD');
    expect(t.headcount).toBe(2);
    expect(t.totalGross.amount).toBe(fromMajor(6000, 'USD').amount);
  });
});

describe('portfolio transfer', () => {
  it('computes entry transfers and net', () => {
    // UPR 1,000,000 @ 35% = 350,000 premium in; outstanding 800,000 @ 90% = 720,000 loss assumed
    const r = portfolioTransfer(fromMajor(1_000_000, 'USD'), fromMajor(800_000, 'USD'), {
      premiumPortfolioPct: 35,
      lossPortfolioPct: 90,
      direction: 'entry',
    });
    expect(r.premiumTransfer.amount).toBe(fromMajor(350_000, 'USD').amount);
    expect(r.lossTransfer.amount).toBe(fromMajor(720_000, 'USD').amount);
    // net = 350,000 - 720,000 = -370,000 (reinsurer is net out-of-pocket assuming the book)
    expect(r.netTransfer.amount).toBe(fromMajor(-370_000, 'USD').amount);
  });

  it('reverses signs on withdrawal', () => {
    const r = portfolioTransfer(fromMajor(1_000_000, 'USD'), fromMajor(800_000, 'USD'), {
      premiumPortfolioPct: 35,
      lossPortfolioPct: 90,
      direction: 'withdrawal',
    });
    expect(r.premiumTransfer.amount).toBe(fromMajor(-350_000, 'USD').amount);
    expect(r.netTransfer.amount).toBe(fromMajor(370_000, 'USD').amount);
  });
});

describe('IFRS 17 GMM / CSM / VFA', () => {
  it('recognises CSM on a profitable group', () => {
    // PV premiums 1,000,000; PV claims 700,000; RA 50,000 => FCF = 700k - 1,000k + 50k = -250k => CSM 250k
    const r = gmmInitialMeasurement({
      presentValueOfPremiums: fromMajor(1_000_000, 'USD'),
      presentValueOfClaims: fromMajor(700_000, 'USD'),
      riskAdjustment: fromMajor(50_000, 'USD'),
    });
    expect(r.fulfilmentCashFlows.amount).toBe(fromMajor(-250_000, 'USD').amount);
    expect(r.csm.amount).toBe(fromMajor(250_000, 'USD').amount);
    expect(r.onerous).toBe(false);
  });

  it('flags an onerous group with a loss component', () => {
    const r = gmmInitialMeasurement({
      presentValueOfPremiums: fromMajor(700_000, 'USD'),
      presentValueOfClaims: fromMajor(900_000, 'USD'),
      riskAdjustment: fromMajor(50_000, 'USD'),
    });
    expect(r.onerous).toBe(true);
    expect(r.lossComponent.amount).toBe(fromMajor(250_000, 'USD').amount);
    expect(r.csm.amount).toBe(0);
  });

  it('rolls the CSM forward with interest and coverage-unit release', () => {
    // opening 250,000 @3% interest = 257,500; no new business/changes;
    // release this period 1 of 5 remaining units => 257,500 * 1/5 = 51,500; closing 206,000
    const r = csmRollforward({
      openingCsm: fromMajor(250_000, 'USD'),
      interestAccretionRate: 0.03,
      coverageUnitsThisPeriod: 1,
      coverageUnitsRemaining: 5,
    });
    expect(r.csmAfterInterest.amount).toBe(fromMajor(257_500, 'USD').amount);
    expect(r.released.amount).toBe(fromMajor(51_500, 'USD').amount);
    expect(r.closingCsm.amount).toBe(fromMajor(206_000, 'USD').amount);
  });

  it('VFA absorbs the change in variable fee into the CSM', () => {
    // opening 100,000 @0% interest; +20,000 variable fee; release 0 => closing 120,000
    const r = vfaCsmRollforward({
      openingCsm: fromMajor(100_000, 'USD'),
      interestAccretionRate: 0,
      changeInVariableFee: fromMajor(20_000, 'USD'),
      coverageUnitsThisPeriod: 0,
      coverageUnitsRemaining: 10,
    });
    expect(r.csmAfterChanges.amount).toBe(fromMajor(120_000, 'USD').amount);
    expect(r.closingCsm.amount).toBe(fromMajor(120_000, 'USD').amount);
  });

  it('floors the CSM at zero when changes exceed it', () => {
    const r = csmRollforward({
      openingCsm: fromMajor(50_000, 'USD'),
      interestAccretionRate: 0,
      changeInEstimates: fromMajor(-80_000, 'USD'),
      coverageUnitsThisPeriod: 1,
      coverageUnitsRemaining: 5,
    });
    expect(r.csmAfterChanges.amount).toBe(0);
    expect(r.closingCsm.amount).toBe(0);
  });
});
