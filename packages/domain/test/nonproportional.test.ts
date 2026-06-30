import { describe, it, expect } from 'vitest';
import { fromMajor, money } from '../src/money.js';
import {
  layerRecovery,
  programmeRecovery,
  applyLossesToLayer,
  premiumFromRateOnLine,
  rateOnLine,
  minimumAndDepositPremium,
  reinstatementPremium,
  type ProgrammeLayer,
} from '../src/nonproportional.js';

const layer = (attachment: number, limit: number, extra: Partial<ProgrammeLayer> = {}): ProgrammeLayer => ({
  attachment: fromMajor(attachment, 'USD'),
  limit: fromMajor(limit, 'USD'),
  reinstatements: 1,
  ...extra,
});

describe('layer recovery', () => {
  it('pays nothing below the attachment', () => {
    expect(layerRecovery(fromMajor(3_000_000, 'USD'), layer(5_000_000, 5_000_000)).amount).toBe(0);
  });

  it('pays the excess up to the limit', () => {
    // $5m xs $5m, loss $8m -> recover $3m
    expect(layerRecovery(fromMajor(8_000_000, 'USD'), layer(5_000_000, 5_000_000)).amount).toBe(
      fromMajor(3_000_000, 'USD').amount,
    );
    // loss $12m -> capped at $5m
    expect(layerRecovery(fromMajor(12_000_000, 'USD'), layer(5_000_000, 5_000_000)).amount).toBe(
      fromMajor(5_000_000, 'USD').amount,
    );
  });
});

describe('programme recovery (stacked layers)', () => {
  it('distributes a loss across the tower and retains the rest', () => {
    const layers = [
      layer(5_000_000, 5_000_000, { name: '5 xs 5' }),
      layer(10_000_000, 10_000_000, { name: '10 xs 10' }),
    ];
    const r = programmeRecovery(fromMajor(18_000_000, 'USD'), layers);
    // first layer full 5m, second layer 8m
    expect(r.byLayer[0]!.recovery.amount).toBe(fromMajor(5_000_000, 'USD').amount);
    expect(r.byLayer[1]!.recovery.amount).toBe(fromMajor(8_000_000, 'USD').amount);
    expect(r.totalRecovery.amount).toBe(fromMajor(13_000_000, 'USD').amount);
    expect(r.retainedByCedent.amount).toBe(fromMajor(5_000_000, 'USD').amount); // the $5m retention
  });
});

describe('aggregate erosion with AAD and reinstatements', () => {
  it('limits total recoveries to the layer capacity', () => {
    // $5m xs $5m, 1 reinstatement -> total capacity $10m.
    const losses = [fromMajor(9_000_000, 'USD'), fromMajor(9_000_000, 'USD'), fromMajor(9_000_000, 'USD')];
    const r = applyLossesToLayer(losses, layer(5_000_000, 5_000_000, { reinstatements: 1 }));
    // each loss recovers $4m, but capacity is $10m -> 4 + 4 + 2.
    expect(r.applications.map((a) => a.recovery.amount)).toEqual([
      fromMajor(4_000_000, 'USD').amount,
      fromMajor(4_000_000, 'USD').amount,
      fromMajor(2_000_000, 'USD').amount,
    ]);
    expect(r.totalRecovered.amount).toBe(fromMajor(10_000_000, 'USD').amount);
    expect(r.capacityRemaining.amount).toBe(0);
  });

  it('erodes the annual aggregate deductible first', () => {
    const losses = [fromMajor(6_000_000, 'USD'), fromMajor(7_000_000, 'USD')];
    const r = applyLossesToLayer(
      losses,
      layer(5_000_000, 5_000_000, { reinstatements: 1, aggregateDeductible: fromMajor(1_000_000, 'USD') }),
    );
    // loss1 excess = 1m, fully absorbed by AAD -> recovery 0.
    // loss2 excess = 2m, AAD exhausted -> recovery 2m.
    expect(r.applications[0]!.recovery.amount).toBe(0);
    expect(r.applications[1]!.recovery.amount).toBe(fromMajor(2_000_000, 'USD').amount);
    expect(r.aadEroded.amount).toBe(fromMajor(1_000_000, 'USD').amount);
  });
});

describe('rate on line and MDP', () => {
  it('computes premium from ROL and back', () => {
    const limit = fromMajor(5_000_000, 'USD');
    const { layerPremium } = premiumFromRateOnLine(limit, 0.1);
    expect(layerPremium.amount).toBe(fromMajor(500_000, 'USD').amount);
    expect(rateOnLine(layerPremium, limit)).toBeCloseTo(0.1);
  });

  it('computes minimum & deposit premium', () => {
    const r = minimumAndDepositPremium({
      estimatedPremium: fromMajor(500_000, 'USD'),
      depositPct: 80,
      minimumPct: 90,
    });
    expect(r.depositPremium.amount).toBe(fromMajor(400_000, 'USD').amount);
    expect(r.minimumPremium.amount).toBe(fromMajor(450_000, 'USD').amount);
  });
});

describe('reinstatement premium', () => {
  it('charges pro-rata as to amount at 100% rate', () => {
    // $5m xs $5m, annual premium $500k, 1 reinstatement @100%.
    // A $4m recovery reinstates 4m/5m = 80% of the limit -> RP = 500k * 0.8 = 400k.
    const l = layer(5_000_000, 5_000_000, { reinstatements: 1, reinstatementRates: [1.0] });
    const r = reinstatementPremium({
      layer: l,
      annualPremium: fromMajor(500_000, 'USD'),
      recoveries: [fromMajor(4_000_000, 'USD')],
    });
    expect(r.totalReinstatementPremium.amount).toBe(fromMajor(400_000, 'USD').amount);
    expect(r.limitReinstated.amount).toBe(fromMajor(4_000_000, 'USD').amount);
  });

  it('applies pro-rata as to time', () => {
    // Full-limit loss, 100% rate, but only 50% of period unexpired -> RP = 500k * 1.0 * 0.5 = 250k.
    const l = layer(5_000_000, 5_000_000, { reinstatements: 1, reinstatementRates: [1.0] });
    const r = reinstatementPremium({
      layer: l,
      annualPremium: fromMajor(500_000, 'USD'),
      recoveries: [fromMajor(5_000_000, 'USD')],
      timeFractions: [0.5],
    });
    expect(r.totalReinstatementPremium.amount).toBe(fromMajor(250_000, 'USD').amount);
  });

  it('does not charge beyond available reinstatements', () => {
    // Only 1 reinstatement; two full-limit losses -> only the first reinstates.
    const l = layer(5_000_000, 5_000_000, { reinstatements: 1, reinstatementRates: [1.0] });
    const r = reinstatementPremium({
      layer: l,
      annualPremium: fromMajor(500_000, 'USD'),
      recoveries: [fromMajor(5_000_000, 'USD'), fromMajor(5_000_000, 'USD')],
    });
    expect(r.totalReinstatementPremium.amount).toBe(fromMajor(500_000, 'USD').amount);
    expect(r.charges.length).toBe(1);
  });

  it('treats free reinstatements as zero premium', () => {
    const l = layer(5_000_000, 5_000_000, { reinstatements: 1, reinstatementRates: [0] });
    const r = reinstatementPremium({
      layer: l,
      annualPremium: fromMajor(500_000, 'USD'),
      recoveries: [fromMajor(5_000_000, 'USD')],
    });
    expect(r.totalReinstatementPremium.amount).toBe(0);
  });
});
