import { describe, it, expect } from 'vitest';
import { evaluateParametric, evaluateIlw, type ParametricCover, type Ilw } from './parametric.js';

const quake: ParametricCover = {
  perilType: 'earthquake',
  index: { source: 'MOCK_USGS', metric: 'magnitude' },
  payout: { type: 'BINARY', trigger: 7.0, payoutMinor: 1_000_000_00 },
};

describe('parametric', () => {
  it('binary pays the full payout at/above the trigger, nothing below', () => {
    // magnitude 7.1 >= 7.0 -> pay 100,000,000 minor; 6.9 -> 0
    expect(evaluateParametric(quake, 7.1).payoutMinor).toBe(1_000_000_00);
    expect(evaluateParametric(quake, 7.0).triggered).toBe(true);
    expect(evaluateParametric(quake, 6.9).payoutMinor).toBe(0);
  });

  it('step pays the highest band whose trigger is met', () => {
    const cover: ParametricCover = {
      perilType: 'hurricane', index: { source: 'MOCK_NHC', metric: 'category' },
      payout: { type: 'STEP', steps: [
        { trigger: 3, payoutMinor: 250_000_00 },
        { trigger: 4, payoutMinor: 500_000_00 },
        { trigger: 5, payoutMinor: 1_000_000_00 },
      ] },
    };
    expect(evaluateParametric(cover, 4).payoutMinor).toBe(500_000_00); // cat 4 band
    expect(evaluateParametric(cover, 5).payoutMinor).toBe(1_000_000_00); // top band
    expect(evaluateParametric(cover, 2).payoutMinor).toBe(0); // below first band
  });

  it('linear pays per unit above attachment, capped at the limit', () => {
    // $50k per mm of rainfall above 100mm, capped at $500k.
    const cover: ParametricCover = {
      perilType: 'flood', index: { source: 'MOCK_NOAA', metric: 'rainfallMm' },
      payout: { type: 'LINEAR', attachment: 100, slopeMinorPerUnit: 50_000_00, limitMinor: 500_000_00 },
    };
    // 105mm -> 5mm over * 50k = 250,000 -> 25,000,000 minor
    expect(evaluateParametric(cover, 105).payoutMinor).toBe(250_000_00);
    // 130mm -> 30mm * 50k = 1.5M, capped at 500k limit
    expect(evaluateParametric(cover, 130).payoutMinor).toBe(500_000_00);
    // 90mm below attachment -> 0
    expect(evaluateParametric(cover, 90).payoutMinor).toBe(0);
  });
});

const usWind: Ilw = {
  structure: 'BINARY', basis: 'OCCURRENCE', peril: 'US wind',
  industryTriggerMinor: 20_000_000_000_00, // $20bn
  limitMinor: 100_000_000_00,              // $100m
  warrantyMinOwnLossMinor: 5_000_000_00,   // $5m own loss
};

describe('ILW', () => {
  it('pays the full limit when both the industry trigger and own-loss warranty are met', () => {
    // industry $25bn >= $20bn AND own $6m >= $5m -> pay $100m limit
    const r = evaluateIlw(usWind, 25_000_000_000_00, 6_000_000_00);
    expect(r.triggered).toBe(true);
    expect(r.payoutMinor).toBe(100_000_000_00);
  });

  it('does not pay if the industry index is below the trigger', () => {
    const r = evaluateIlw(usWind, 18_000_000_000_00, 6_000_000_00);
    expect(r.industryTriggerMet).toBe(false);
    expect(r.payoutMinor).toBe(0);
  });

  it('does not pay if the own-loss warranty (dual trigger) is not met', () => {
    // industry met but own loss $1m < $5m warranty
    const r = evaluateIlw(usWind, 25_000_000_000_00, 1_000_000_00);
    expect(r.industryTriggerMet).toBe(true);
    expect(r.warrantyMet).toBe(false);
    expect(r.payoutMinor).toBe(0);
  });

  it('indemnity ILW pays min(own loss, limit)', () => {
    const ind: Ilw = { ...usWind, structure: 'INDEMNITY' };
    // own $40m < $100m limit -> pay $40m
    expect(evaluateIlw(ind, 25_000_000_000_00, 40_000_000_00).payoutMinor).toBe(40_000_000_00);
  });
});
