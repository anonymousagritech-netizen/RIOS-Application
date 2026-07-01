import { describe, it, expect } from 'vitest';
import {
  canTransition, isTerminalStage, stageProgress, riskScore, riskBand,
  technicalPremium, UW_PIPELINE,
} from './underwriting.js';

describe('underwriting stage machine', () => {
  it('permits the happy-path transitions and rejects illegal ones', () => {
    expect(canTransition('SUBMISSION', 'TRIAGE')).toBe(true);
    expect(canTransition('PRICING', 'QUOTED')).toBe(true);
    expect(canTransition('QUOTED', 'BOUND')).toBe(true);
    // illegal skips
    expect(canTransition('SUBMISSION', 'BOUND')).toBe(false);
    expect(canTransition('BOUND', 'QUOTED')).toBe(false);
    // any live stage can decline / lapse
    expect(canTransition('ANALYSIS', 'DECLINED')).toBe(true);
    expect(canTransition('TRIAGE', 'LAPSED')).toBe(true);
  });

  it('marks terminal stages and reports pipeline progress', () => {
    expect(isTerminalStage('BOUND')).toBe(true);
    expect(isTerminalStage('DECLINED')).toBe(true);
    expect(isTerminalStage('PRICING')).toBe(false);
    expect(stageProgress('SUBMISSION')).toBe(0);
    expect(stageProgress('BOUND')).toBe(1);
    expect(stageProgress(UW_PIPELINE[3]!)).toBeCloseTo(3 / 6, 5);
    expect(stageProgress('DECLINED')).toBe(0);
  });
});

describe('risk scoring', () => {
  it('scores a benign, long-standing non-cat account low', () => {
    const r = riskScore({ lossRatioPct: 20, catExposed: false, capacityUtilPct: 10, classHazard: 1, priorClaims: 0, yearsWithCedent: 5 });
    expect(r.score).toBeLessThan(25);
    expect(r.band).toBe('LOW');
    // relationship applies a credit
    expect(r.contributions.find((c) => c.factor === 'Cedent relationship')!.points).toBe(-5);
  });

  it('scores a cat-exposed, loss-heavy, high-hazard account high', () => {
    const r = riskScore({ lossRatioPct: 95, catExposed: true, capacityUtilPct: 90, classHazard: 5, priorClaims: 4, yearsWithCedent: 0 });
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.band).toBe('HIGH');
  });

  it('is transparent: contributions sum (rounded) to the score', () => {
    const r = riskScore({ lossRatioPct: 60, catExposed: true, capacityUtilPct: 50, classHazard: 3, priorClaims: 1, yearsWithCedent: 2 });
    const sum = r.contributions.reduce((a, c) => a + c.points, 0);
    expect(Math.round(Math.max(0, Math.min(100, sum)))).toBe(r.score);
  });

  it('bands boundaries correctly', () => {
    expect(riskBand(24)).toBe('LOW');
    expect(riskBand(25)).toBe('MODERATE');
    expect(riskBand(49)).toBe('MODERATE');
    expect(riskBand(50)).toBe('ELEVATED');
    expect(riskBand(75)).toBe('HIGH');
  });
});

describe('technical premium', () => {
  it('grosses expected loss up for expense + risk-scaled profit load', () => {
    const low = technicalPremium({ expectedLossMinor: 1_000_000, riskScore: 10 });
    const high = technicalPremium({ expectedLossMinor: 1_000_000, riskScore: 90 });
    // higher risk → higher profit load → higher premium → lower implied loss ratio
    expect(high.technicalPremiumMinor).toBeGreaterThan(low.technicalPremiumMinor);
    expect(high.impliedLossRatioPct).toBeLessThan(low.impliedLossRatioPct);
    expect(low.technicalPremiumMinor).toBeGreaterThan(1_000_000); // always above pure loss
  });
});
