import { describe, it, expect } from 'vitest';
import { fromMajor, money } from '../src/money.js';
import { convert, revalue, crossRate } from '../src/fx.js';
import { burningCost, exposureRate, checkAuthority, paretoCurve } from '../src/pricing.js';
import { paaLrc, lic, onerousTest, insuranceContractLiability } from '../src/ifrs17.js';
import {
  nonLifePremiumReserveRisk,
  aggregateScr,
  solvencyCapitalRequirement,
  minimumCapitalRequirement,
  solvencyRatio,
} from '../src/solvency2.js';
import type { Layer } from '../src/nonproportional.js';

describe('fx', () => {
  it('converts across currencies and quantises to target precision', () => {
    const r = convert(fromMajor(1000, 'EUR'), 'USD', 1.08);
    expect(r.to.amount).toBe(fromMajor(1080, 'USD').amount);
    // USD -> JPY (0 minor units)
    const j = convert(fromMajor(100, 'USD'), 'JPY', 150);
    expect(j.to.amount).toBe(fromMajor(15000, 'JPY').amount);
  });

  it('computes FX gain/loss on revaluation', () => {
    const g = revalue(fromMajor(1000, 'EUR'), 'USD', 1.08, 1.12);
    expect(g.gainLoss.amount).toBe(fromMajor(40, 'USD').amount);
  });

  it('triangulates a cross rate', () => {
    expect(crossRate(1.27, 1.08)).toBeCloseTo(1.1759, 3);
  });
});

const layer: Layer = { attachment: fromMajor(5_000_000, 'USD'), limit: fromMajor(5_000_000, 'USD'), reinstatements: 1 };

describe('pricing — burning cost', () => {
  it('rates a layer from experience with loading and ROL', () => {
    const r = burningCost(
      {
        years: [
          { year: 2023, subjectPremium: fromMajor(20_000_000, 'USD'), losses: [fromMajor(7_000_000, 'USD')] }, // 2m to layer
          { year: 2024, subjectPremium: fromMajor(20_000_000, 'USD'), losses: [] }, // 0
        ],
        layer,
        loadingFactor: 1.25,
      },
      fromMajor(20_000_000, 'USD'),
    );
    // total layer losses = 2,000,000; subject premium = 40,000,000; pure = 0.05
    expect(r.totalLayerLosses.amount).toBe(fromMajor(2_000_000, 'USD').amount);
    expect(r.pureBurningCost).toBeCloseTo(0.05);
    expect(r.loadedBurningCost).toBeCloseTo(0.0625);
    // technical premium = 0.0625 * 20,000,000 = 1,250,000; ROL = 1.25m/5m = 0.25
    expect(r.technicalPremium.amount).toBe(fromMajor(1_250_000, 'USD').amount);
    expect(r.rateOnLine).toBeCloseTo(0.25);
  });

  it('applies a minimum rate on line floor', () => {
    const r = burningCost(
      { years: [{ year: 2024, subjectPremium: fromMajor(20_000_000, 'USD'), losses: [] }], layer, loadingFactor: 1.25, minRateOnLine: 0.1 },
      fromMajor(20_000_000, 'USD'),
    );
    expect(r.rateOnLine).toBeCloseTo(0.1);
    expect(r.technicalPremium.amount).toBe(fromMajor(500_000, 'USD').amount);
  });
});

describe('pricing — exposure rating & authority', () => {
  it('produces a non-negative expected loss from an exposure curve', () => {
    const r = exposureRate(
      [{ bandLimit: 20_000_000, premium: fromMajor(10_000_000, 'USD'), lossRatio: 0.6 }],
      layer,
      paretoCurve(2),
    );
    expect(r.expectedLoss.amount).toBeGreaterThan(0);
    expect(r.rateOnLine).toBeGreaterThan(0);
  });

  it('flags authority and capacity breaches', () => {
    expect(checkAuthority({ requestedLine: 5, authorityLimit: 10, remainingCapacity: 10 }).allowed).toBe(true);
    const r = checkAuthority({ requestedLine: 15, authorityLimit: 10, remainingCapacity: 8 });
    expect(r.allowed).toBe(false);
    expect(r.breaches.length).toBe(2);
  });

  it('exposure curve is monotonic on [0,1]', () => {
    const g = paretoCurve(2);
    expect(g(0)).toBeCloseTo(0);
    expect(g(1)).toBeCloseTo(1);
    expect(g(0.5)).toBeGreaterThan(0);
    expect(g(0.5)).toBeLessThan(1);
  });
});

describe('ifrs17 PAA', () => {
  it('rolls forward the LRC as coverage is earned', () => {
    const r = paaLrc({ premiumReceived: fromMajor(1_000_000, 'USD'), acquisitionCashFlows: fromMajor(100_000, 'USD'), coverageElapsed: 0.25 });
    expect(r.earnedPremium.amount).toBe(fromMajor(250_000, 'USD').amount);
    // LRC = unearned (750,000) - unamortised acq (75,000) = 675,000
    expect(r.lrc.amount).toBe(fromMajor(675_000, 'USD').amount);
  });

  it('computes LIC as discounted claims plus risk adjustment', () => {
    const r = lic({ expectedClaims: fromMajor(1_000_000, 'USD'), discountFactor: 0.95, riskAdjustmentPct: 0.06 });
    expect(r.discountedClaims.amount).toBe(fromMajor(950_000, 'USD').amount);
    expect(r.riskAdjustment.amount).toBe(fromMajor(57_000, 'USD').amount);
    expect(r.lic.amount).toBe(fromMajor(1_007_000, 'USD').amount);
  });

  it('identifies an onerous group and its loss component', () => {
    const ok = onerousTest({ fulfilmentCashFlows: fromMajor(800_000, 'USD'), lrcExcludingLossComponent: fromMajor(900_000, 'USD') });
    expect(ok.onerous).toBe(false);
    const bad = onerousTest({ fulfilmentCashFlows: fromMajor(1_000_000, 'USD'), lrcExcludingLossComponent: fromMajor(900_000, 'USD') });
    expect(bad.onerous).toBe(true);
    expect(bad.lossComponent.amount).toBe(fromMajor(100_000, 'USD').amount);
  });

  it('totals the insurance contract liability', () => {
    const total = insuranceContractLiability({ lrc: fromMajor(675_000, 'USD'), lic: fromMajor(1_007_000, 'USD'), lossComponent: money(0, 'USD') });
    expect(total.amount).toBe(fromMajor(1_682_000, 'USD').amount);
  });
});

describe('solvency II SCR', () => {
  it('computes non-life premium & reserve risk capital', () => {
    const r = nonLifePremiumReserveRisk({ premiumVolume: 100_000_000, reserveVolume: 50_000_000, sigma: 0.1 });
    expect(r.volume).toBe(150_000_000);
    expect(r.scr).toBeCloseTo(3 * 0.1 * 150_000_000); // 45,000,000
  });

  it('aggregates module SCRs via the correlation matrix', () => {
    // Two perfectly uncorrelated modules of 30 and 40 -> sqrt(900+1600)=50
    const scr = aggregateScr([30, 40], [
      [1, 0],
      [0, 1],
    ]);
    expect(scr).toBeCloseTo(50);
  });

  it('builds SCR with operational risk and adjustment', () => {
    const r = solvencyCapitalRequirement({
      moduleScrs: [30, 40],
      correlation: [
        [1, 0],
        [0, 1],
      ],
      operationalRisk: 10,
      adjustment: -5,
    });
    expect(r.basicScr).toBeCloseTo(50);
    expect(r.scr).toBeCloseTo(55);
  });

  it('bounds the MCR to the 25%-45% corridor and the absolute floor', () => {
    // SCR 100 -> corridor [25,45]; linear 60 -> clamp to 45
    expect(minimumCapitalRequirement({ scr: 100, linearMcr: 60, absoluteFloor: 3.7 })).toBeCloseTo(45);
    // linear 10 -> clamp up to 25
    expect(minimumCapitalRequirement({ scr: 100, linearMcr: 10, absoluteFloor: 3.7 })).toBeCloseTo(25);
    // absolute floor wins when corridor is tiny
    expect(minimumCapitalRequirement({ scr: 10, linearMcr: 2, absoluteFloor: 3.7 })).toBeCloseTo(3.7);
  });

  it('computes the solvency ratio', () => {
    expect(solvencyRatio(165, 100)).toBeCloseTo(1.65);
  });
});
