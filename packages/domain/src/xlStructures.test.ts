import { describe, it, expect } from 'vitest';
import { fromMajor } from './money.js';
import {
  perRiskRecovery,
  perOccurrenceRecovery,
  aggregateXlRecovery,
  stopLossRecovery,
  reinstatementPremium,
  layerReinstatementCapacity,
  type Reinstatement,
} from './xlStructures.js';

const usd = (major: number) => fromMajor(major, 'USD');

// ---------------------------------------------------------------------------
// 1. Per-risk XL
// ---------------------------------------------------------------------------

describe('perRiskRecovery', () => {
  it('pays the excess up to the limit', () => {
    // 5M xs 5M layer, risk loss 8M -> clamp(8M - 5M, 0, 5M) = 3M
    expect(
      perRiskRecovery({ lossMinor: usd(8_000_000), attachmentMinor: usd(5_000_000), limitMinor: usd(5_000_000) })
        .amount,
    ).toBe(usd(3_000_000).amount);
  });

  it('caps at the limit and floors at zero', () => {
    // loss 12M -> clamp(12M - 5M, 0, 5M) = 5M (capped)
    expect(
      perRiskRecovery({ lossMinor: usd(12_000_000), attachmentMinor: usd(5_000_000), limitMinor: usd(5_000_000) })
        .amount,
    ).toBe(usd(5_000_000).amount);
    // loss 3M below attachment -> clamp(3M - 5M, 0, 5M) = 0
    expect(
      perRiskRecovery({ lossMinor: usd(3_000_000), attachmentMinor: usd(5_000_000), limitMinor: usd(5_000_000) })
        .amount,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-occurrence XL
// ---------------------------------------------------------------------------

describe('perOccurrenceRecovery', () => {
  it('clamps the aggregated occurrence loss against attachment/limit', () => {
    // 20M xs 10M cat layer, aggregated occurrence loss 25M -> clamp(25M - 10M, 0, 20M) = 15M
    expect(
      perOccurrenceRecovery({
        occurrenceLossMinor: usd(25_000_000),
        attachmentMinor: usd(10_000_000),
        limitMinor: usd(20_000_000),
      }).amount,
    ).toBe(usd(15_000_000).amount);
  });

  it('caps at the occurrence limit', () => {
    // occurrence loss 40M -> clamp(40M - 10M, 0, 20M) = 20M (capped)
    expect(
      perOccurrenceRecovery({
        occurrenceLossMinor: usd(40_000_000),
        attachmentMinor: usd(10_000_000),
        limitMinor: usd(20_000_000),
      }).amount,
    ).toBe(usd(20_000_000).amount);
  });
});

// ---------------------------------------------------------------------------
// 3. Aggregate XL / stop loss with AAD
// ---------------------------------------------------------------------------

describe('aggregateXlRecovery', () => {
  it('sums losses, subtracts the AAD, caps at the aggregate limit', () => {
    // losses 3M + 4M + 5M = 12M; AAD 5M; limit 10M -> clamp(12M - 5M, 0, 10M) = 7M
    const r = aggregateXlRecovery({
      periodLossesMinor: [usd(3_000_000), usd(4_000_000), usd(5_000_000)],
      aadMinor: usd(5_000_000),
      limitMinor: usd(10_000_000),
    });
    expect(r.sumLossesMinor.amount).toBe(usd(12_000_000).amount);
    expect(r.recoveryMinor.amount).toBe(usd(7_000_000).amount);
  });

  it('floors at zero when below the AAD', () => {
    // losses 1M + 1M = 2M; AAD 5M -> clamp(2M - 5M, 0, 10M) = 0
    const r = aggregateXlRecovery({
      periodLossesMinor: [usd(1_000_000), usd(1_000_000)],
      aadMinor: usd(5_000_000),
      limitMinor: usd(10_000_000),
    });
    expect(r.recoveryMinor.amount).toBe(0);
  });

  it('caps at the aggregate limit', () => {
    // losses 30M; AAD 5M; limit 10M -> clamp(30M - 5M, 0, 10M) = 10M (capped)
    const r = aggregateXlRecovery({
      periodLossesMinor: [usd(30_000_000)],
      aadMinor: usd(5_000_000),
      limitMinor: usd(10_000_000),
    });
    expect(r.recoveryMinor.amount).toBe(usd(10_000_000).amount);
  });
});

// ---------------------------------------------------------------------------
// 4. Whole-account stop loss in loss-ratio terms
// ---------------------------------------------------------------------------

describe('stopLossRecovery', () => {
  it('converts loss ratios to money and recovers the excess', () => {
    // subject premium 10M; incurred 10M (100% LR); attach 80%, limit 110%.
    // attachment = 0.80 * 10M = 8M; ceiling = 1.10 * 10M = 11M.
    // recovery = clamp(10M, 8M, 11M) - 8M = 10M - 8M = 2M
    const r = stopLossRecovery({
      subjectPremiumMinor: usd(10_000_000),
      incurredLossesMinor: usd(10_000_000),
      attachmentLossRatio: 0.8,
      limitLossRatio: 1.1,
    });
    expect(r.attachmentMinor.amount).toBe(usd(8_000_000).amount);
    expect(r.ceilingMinor.amount).toBe(usd(11_000_000).amount);
    expect(r.recoveryMinor.amount).toBe(usd(2_000_000).amount);
    expect(r.incurredLossRatio).toBeCloseTo(1.0);
  });

  it('caps recovery at the ceiling loss ratio', () => {
    // subject 10M; incurred 13M (130% LR); attach 80% (8M), limit 110% (11M).
    // recovery = clamp(13M, 8M, 11M) - 8M = 11M - 8M = 3M (capped at the band width)
    const r = stopLossRecovery({
      subjectPremiumMinor: usd(10_000_000),
      incurredLossesMinor: usd(13_000_000),
      attachmentLossRatio: 0.8,
      limitLossRatio: 1.1,
    });
    expect(r.recoveryMinor.amount).toBe(usd(3_000_000).amount);
  });

  it('pays nothing below the attachment loss ratio', () => {
    // subject 10M; incurred 7M (70% LR) < 80% attach -> recovery 0
    const r = stopLossRecovery({
      subjectPremiumMinor: usd(10_000_000),
      incurredLossesMinor: usd(7_000_000),
      attachmentLossRatio: 0.8,
      limitLossRatio: 1.1,
    });
    expect(r.recoveryMinor.amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Reinstatement premium
// ---------------------------------------------------------------------------

const proRata = (rate: number, extra: Partial<Reinstatement> = {}): Reinstatement => ({
  rate,
  proRataAmount: true,
  ...extra,
});

describe('reinstatementPremium', () => {
  it('charges pro-rata as to amount for a partial reinstatement', () => {
    // 5M xs 5M layer, 3M loss, 100% reinstatement, deposit 1M
    // -> only the original limit is touched (3M < 5M), so NO reinstatement is needed -> RP = 0
    const r = reinstatementPremium({
      lossToLayerMinor: usd(3_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [proRata(1.0)],
    });
    expect(r.totalReinstatementPremiumMinor.amount).toBe(0);
    expect(r.breakdown.length).toBe(0);
    // remaining cover = capacity 10M - loss 3M = 7M
    expect(r.remainingCoverMinor.amount).toBe(usd(7_000_000).amount);
  });

  it('charges pro-rata for loss biting into the first reinstatement', () => {
    // 5M xs 5M layer, 8M loss, 100% reinstatement, deposit 1M.
    // First 5M consumes original cover (free); next 3M reinstated by R#0.
    // RP = 1M * 1.0 * (3M / 5M) = 1M * 0.6 = 600,000
    const r = reinstatementPremium({
      lossToLayerMinor: usd(8_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [proRata(1.0)],
    });
    expect(r.totalReinstatementPremiumMinor.amount).toBe(usd(600_000).amount);
    expect(r.breakdown[0]!.amountReinstatedMinor.amount).toBe(usd(3_000_000).amount);
    // remaining cover = capacity 10M - loss 8M = 2M
    expect(r.remainingCoverMinor.amount).toBe(usd(2_000_000).amount);
  });

  it('charges a full reinstatement at the full rate', () => {
    // 5M xs 5M, 10M loss, 100% reinstatement, deposit 1M.
    // Original 5M free; next 5M fully reinstated by R#0 -> RP = 1M * 1.0 * (5M/5M) = 1,000,000
    const r = reinstatementPremium({
      lossToLayerMinor: usd(10_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [proRata(1.0)],
    });
    expect(r.totalReinstatementPremiumMinor.amount).toBe(usd(1_000_000).amount);
    expect(r.remainingCoverMinor.amount).toBe(0);
  });

  it('treats a free reinstatement as zero premium', () => {
    // 5M xs 5M, 10M loss, free reinstatement, deposit 1M -> RP = 0 (free)
    const r = reinstatementPremium({
      lossToLayerMinor: usd(10_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [proRata(1.0, { free: true })],
    });
    expect(r.totalReinstatementPremiumMinor.amount).toBe(0);
    expect(r.breakdown[0]!.rate).toBe(0);
  });

  it('applies pro-rata as to time', () => {
    // 5M xs 5M, 10M loss (full reinstatement of R#0), 100% rate, deposit 1M,
    // 146 of 365 days remaining -> RP = 1M * 1.0 * (5M/5M) * (146/365) = 1M * 0.4 = 400,000
    const r = reinstatementPremium({
      lossToLayerMinor: usd(10_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [proRata(1.0, { proRataTime: { daysRemaining: 146, totalDays: 365 } })],
    });
    expect(r.totalReinstatementPremiumMinor.amount).toBe(usd(400_000).amount);
    expect(r.breakdown[0]!.timeFraction).toBeCloseTo(0.4);
  });

  it('consumes multiple reinstatements in order as the loss erodes the layer', () => {
    // 5M xs 5M, TWO reinstatements @100%, deposit 1M, total loss 13M.
    // Original 5M (free) + R#0 reinstates 5M + R#1 reinstates 3M.
    // RP = R#0: 1M*1.0*(5M/5M)=1,000,000  +  R#1: 1M*1.0*(3M/5M)=600,000  = 1,600,000
    const r = reinstatementPremium({
      lossToLayerMinor: usd(13_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [proRata(1.0), proRata(1.0)],
    });
    expect(r.breakdown.map((b) => b.premiumMinor.amount)).toEqual([
      usd(1_000_000).amount,
      usd(600_000).amount,
    ]);
    expect(r.totalReinstatementPremiumMinor.amount).toBe(usd(1_600_000).amount);
    // capacity = 5M * (2 + 1) = 15M; remaining = 15M - 13M = 2M
    expect(r.remainingCoverMinor.amount).toBe(usd(2_000_000).amount);
  });

  it('exhausts the layer: loss beyond all reinstatements charges nothing extra', () => {
    // 5M xs 5M, ONE reinstatement @100%, deposit 1M, loss 20M.
    // Capacity = 5M*(1+1) = 10M. Original 5M free; R#0 fully reinstated (5M) -> RP = 1,000,000.
    // The remaining 10M of loss is uncovered (layer exhausted) -> no further charge, remaining cover 0.
    const r = reinstatementPremium({
      lossToLayerMinor: usd(20_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [proRata(1.0)],
    });
    expect(r.totalReinstatementPremiumMinor.amount).toBe(usd(1_000_000).amount);
    expect(r.breakdown.length).toBe(1);
    expect(r.remainingCoverMinor.amount).toBe(0);
  });

  it('charges the full tranche premium when not pro-rata as to amount', () => {
    // 5M xs 5M, loss 8M (3M into R#0), 100% rate, deposit 1M, proRataAmount=false
    // -> full tranche premium regardless of fraction = 1M * 1.0 = 1,000,000
    const r = reinstatementPremium({
      lossToLayerMinor: usd(8_000_000),
      layerLimitMinor: usd(5_000_000),
      depositPremiumMinor: usd(1_000_000),
      reinstatements: [{ rate: 1.0, proRataAmount: false }],
    });
    expect(r.totalReinstatementPremiumMinor.amount).toBe(usd(1_000_000).amount);
  });
});

// ---------------------------------------------------------------------------
// 6. layerReinstatementCapacity
// ---------------------------------------------------------------------------

describe('layerReinstatementCapacity', () => {
  it('returns limit * (reinstatements + 1)', () => {
    // 5M limit, 2 reinstatements -> 5M * (2 + 1) = 15M aggregate cover
    expect(
      layerReinstatementCapacity({ layerLimitMinor: usd(5_000_000), numReinstatements: 2 }).amount,
    ).toBe(usd(15_000_000).amount);
  });

  it('single-shot (0 reinstatements) equals the limit', () => {
    // 5M limit, 0 reinstatements -> 5M
    expect(
      layerReinstatementCapacity({ layerLimitMinor: usd(5_000_000), numReinstatements: 0 }).amount,
    ).toBe(usd(5_000_000).amount);
  });
});
