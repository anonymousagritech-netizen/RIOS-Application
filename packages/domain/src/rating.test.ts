import { describe, it, expect } from 'vitest';
import { fromMajor, money } from './money.js';
import {
  burningCostRate,
  exposureRate,
  interpolateExposureCurve,
  ilf,
  premiumAtLimit,
  rateOnLine,
  premiumFromRol,
  minimumAndDepositPremium,
  catLoadFromModel,
  type ExposureCurvePoint,
  type IlfCurvePoint,
} from './rating.js';

const usd = (major: number) => fromMajor(major, 'USD');

// ---------------------------------------------------------------------------
// 1. Burning-cost (experience) rating
// ---------------------------------------------------------------------------

describe('burningCostRate', () => {
  it('computes a pure rate from losses over exposure premium', () => {
    // Losses 1m + 2m + 3m = 6m; premium 10m + 10m + 10m = 30m.
    // pureRate = 6m / 30m = 0.20.
    const r = burningCostRate({
      historicalLossesMinor: [usd(1_000_000), usd(2_000_000), usd(3_000_000)],
      historicalPremiumMinor: [usd(10_000_000), usd(10_000_000), usd(10_000_000)],
    });
    expect(r.pureRate).toBeCloseTo(0.2);
    expect(r.loadedRate).toBeCloseTo(0.2); // loading defaults to 1
    expect(r.trendedDevelopedLossesMinor.amount).toBe(usd(6_000_000).amount);
    expect(r.totalExposureMinor.amount).toBe(usd(30_000_000).amount);
  });

  it('applies trend, development and loading factors', () => {
    // Loss 1,000,000.00 (=> 100,000,000 minor) × trend 1.10 × dev 1.20 = 132,000,000 minor.
    // exposure 10,000,000.00 (=> 1,000,000,000 minor). pureRate = 132m/1000m = 0.132.
    // loadedRate = 0.132 × 1.25 = 0.165.
    const r = burningCostRate({
      historicalLossesMinor: [usd(1_000_000)],
      subjectPremiumMinor: [usd(10_000_000)],
      trendFactor: 1.1,
      developmentFactor: 1.2,
      loadingFactor: 1.25,
    });
    expect(r.trendedDevelopedLossesMinor.amount).toBe(money(132_000_000, 'USD').amount);
    expect(r.pureRate).toBeCloseTo(0.132);
    expect(r.loadedRate).toBeCloseTo(0.165);
  });

  it('returns a zero rate when exposure is zero (no divide-by-zero)', () => {
    // Exposure 0 -> pureRate 0 even though losses are positive.
    const r = burningCostRate({
      historicalLossesMinor: [usd(5_000_000)],
      subjectPremiumMinor: [usd(0)],
    });
    expect(r.pureRate).toBe(0);
    expect(r.loadedRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Exposure rating
// ---------------------------------------------------------------------------

// A simple exposure curve: G(0)=0, G(0.5)=0.75, G(1)=1.0 (loss cost concentrated low).
const curve: ExposureCurvePoint[] = [
  { ratio: 0, G: 0 },
  { ratio: 0.5, G: 0.75 },
  { ratio: 1, G: 1.0 },
];

describe('interpolateExposureCurve', () => {
  it('interpolates linearly between points', () => {
    // Between ratio 0 (G=0) and 0.5 (G=0.75): at 0.25, G = 0 + 0.5×0.75 = 0.375.
    expect(interpolateExposureCurve(curve, 0.25)).toBeCloseTo(0.375);
  });

  it('clamps below and above the curve range', () => {
    // x=-0.2 clamps to first point G=0; x=2 clamps to last point G=1.
    expect(interpolateExposureCurve(curve, -0.2)).toBe(0);
    expect(interpolateExposureCurve(curve, 2)).toBe(1);
  });
});

describe('exposureRate', () => {
  it('allocates subject premium to a layer via G(top) - G(attach)', () => {
    // Underlying exposure 1,000,000; layer 500,000 xs 0.
    // attachRatio = 0/1m = 0 -> G=0; topRatio = 500k/1m = 0.5 -> G=0.75.
    // layerFraction = 0.75 - 0 = 0.75; lossCost = 1,000,000.00 premium × 0.75 = 750,000.00.
    const r = exposureRate({
      subjectPremiumMinor: usd(1_000_000),
      exposureCurve: curve,
      layerAttachmentMinor: usd(0),
      layerLimitMinor: usd(500_000),
      underlyingExposureMinor: usd(1_000_000),
    });
    expect(r.gAttach).toBeCloseTo(0);
    expect(r.gTop).toBeCloseTo(0.75);
    expect(r.layerFraction).toBeCloseTo(0.75);
    expect(r.layerLossCostMinor.amount).toBe(usd(750_000).amount);
  });

  it('handles an attachment above the curve range (top clamped)', () => {
    // Underlying exposure 1,000,000; layer 1,000,000 xs 1,000,000.
    // attachRatio = 1m/1m = 1.0 -> G=1.0; topRatio = 2m/1m = 2.0 -> clamps to G=1.0.
    // layerFraction = 1.0 - 1.0 = 0 -> loss cost 0 (layer sits entirely above exhaustion).
    const r = exposureRate({
      subjectPremiumMinor: usd(1_000_000),
      exposureCurve: curve,
      layerAttachmentMinor: usd(1_000_000),
      layerLimitMinor: usd(1_000_000),
      underlyingExposureMinor: usd(1_000_000),
    });
    expect(r.layerFraction).toBeCloseTo(0);
    expect(r.layerLossCostMinor.amount).toBe(0);
  });

  it('returns zero loss cost when underlying exposure is zero', () => {
    const r = exposureRate({
      subjectPremiumMinor: usd(1_000_000),
      exposureCurve: curve,
      layerAttachmentMinor: usd(0),
      layerLimitMinor: usd(500_000),
      underlyingExposureMinor: usd(0),
    });
    expect(r.layerFraction).toBe(0);
    expect(r.layerLossCostMinor.amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Increased Limit Factors
// ---------------------------------------------------------------------------

const ilfCurve: IlfCurvePoint[] = [
  { limit: 1_000_000, factor: 1.0 },
  { limit: 2_000_000, factor: 1.5 },
  { limit: 5_000_000, factor: 2.0 },
];

describe('ilf', () => {
  it('interpolates between curve points', () => {
    // Between 1m (1.0) and 2m (1.5): at 1.5m, ILF = 1.0 + 0.5×0.5 = 1.25.
    expect(ilf(1_500_000, ilfCurve)).toBeCloseTo(1.25);
  });

  it('clamps below and above the curve range', () => {
    // 500k clamps to first factor 1.0; 10m clamps to last factor 2.0.
    expect(ilf(500_000, ilfCurve)).toBe(1.0);
    expect(ilf(10_000_000, ilfCurve)).toBe(2.0);
  });
});

describe('premiumAtLimit', () => {
  it('scales a basis premium by the ratio of ILFs', () => {
    // Basis premium 100,000.00 at basis limit 1m (ILF 1.0); target limit 2m (ILF 1.5).
    // premiumAtLimit = 100,000 × 1.5/1.0 = 150,000.00.
    const r = premiumAtLimit(usd(100_000), 2_000_000, 1_000_000, ilfCurve);
    expect(r.amount).toBe(usd(150_000).amount);
  });
});

// ---------------------------------------------------------------------------
// 4. Rate on line <-> premium
// ---------------------------------------------------------------------------

describe('rateOnLine / premiumFromRol', () => {
  it('computes ROL = premium / limit and its inverse', () => {
    // Premium 500,000.00 over limit 5,000,000.00 -> ROL = 0.10.
    expect(rateOnLine(usd(500_000), usd(5_000_000))).toBeCloseTo(0.1);
    // Inverse: ROL 0.10 × limit 5,000,000.00 -> premium 500,000.00.
    expect(premiumFromRol(0.1, usd(5_000_000)).amount).toBe(usd(500_000).amount);
  });

  it('throws on a zero limit', () => {
    expect(() => rateOnLine(usd(500_000), usd(0))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Minimum & Deposit Premium
// ---------------------------------------------------------------------------

describe('minimumAndDepositPremium', () => {
  it('computes MDP = estimatedPremium × mdpRate as both deposit and minimum', () => {
    // Estimated premium 500,000.00 × 0.80 -> MDP 400,000.00 (deposit = minimum).
    const r = minimumAndDepositPremium({ estimatedPremiumMinor: usd(500_000), mdpRate: 0.8 });
    expect(r.depositPremiumMinor.amount).toBe(usd(400_000).amount);
    expect(r.minimumPremiumMinor.amount).toBe(usd(400_000).amount);
    expect(r.mdpRate).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// 6. Catastrophe load from a modeled layer loss
// ---------------------------------------------------------------------------

describe('catLoadFromModel', () => {
  it('expresses a modeled layer loss as an amount, ROL and share of AAL', () => {
    // Modeled layer loss 250,000.00; layer limit 5,000,000.00 -> ROL = 250k/5m = 0.05.
    // Portfolio AAL 1,000,000.00 -> shareOfAal = 250k/1m = 0.25.
    const r = catLoadFromModel({
      aalMinor: usd(1_000_000),
      layerAttachmentMinor: usd(5_000_000),
      layerLimitMinor: usd(5_000_000),
      modeledLayerLossMinor: usd(250_000),
    });
    expect(r.catLoadMinor.amount).toBe(usd(250_000).amount);
    expect(r.catLoadRateOnLine).toBeCloseTo(0.05);
    expect(r.shareOfAal).toBeCloseTo(0.25);
  });

  it('returns zero rate/share when limit and AAL are zero', () => {
    const r = catLoadFromModel({
      aalMinor: usd(0),
      layerAttachmentMinor: usd(5_000_000),
      layerLimitMinor: usd(0),
      modeledLayerLossMinor: usd(250_000),
    });
    expect(r.catLoadRateOnLine).toBe(0);
    expect(r.shareOfAal).toBe(0);
  });
});
