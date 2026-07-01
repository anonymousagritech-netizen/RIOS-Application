import { describe, it, expect } from 'vitest';
import { counterpartyProfitability, counterpartyScore, scoreBand, brokerTierForVolume } from './counterparty.js';

const M = (major: number) => major * 100;

describe('counterparty analytics', () => {
  it('computes profitability ratios and result', () => {
    const p = counterpartyProfitability({ gwpMinor: M(1_000_000), incurredMinor: M(600_000), commissionMinor: M(250_000), contractsBound: 0, contractsQuoted: 0, renewedCount: 0, upForRenewalCount: 0, yearsActive: 0 });
    expect(p.lossRatioPct).toBe(60);
    expect(p.commissionRatioPct).toBe(25);
    expect(p.combinedRatioPct).toBe(85);
    expect(p.underwritingResultMinor).toBe(M(150_000));
    expect(p.marginPct).toBe(15);
  });

  it('scores a strong counterparty highly', () => {
    const s = counterpartyScore({
      gwpMinor: M(20_000_000), incurredMinor: M(10_000_000), commissionMinor: M(4_000_000),
      contractsBound: 8, contractsQuoted: 10, renewedCount: 9, upForRenewalCount: 10, yearsActive: 8,
    });
    expect(s.score).toBeGreaterThan(60);
    expect(['GOLD', 'PLATINUM']).toContain(s.band);
    expect(s.hitRatioPct).toBe(80);
    expect(s.retentionPct).toBe(90);
    expect(s.contributions.length).toBe(5);
  });

  it('scores a weak counterparty low', () => {
    const s = counterpartyScore({
      gwpMinor: M(50_000), incurredMinor: M(70_000), commissionMinor: M(15_000),
      contractsBound: 1, contractsQuoted: 10, renewedCount: 0, upForRenewalCount: 5, yearsActive: 0,
    });
    expect(s.score).toBeLessThan(40);
    expect(s.band).toBe('BRONZE');
  });

  it('bands and tiers', () => {
    expect(scoreBand(85)).toBe('PLATINUM');
    expect(scoreBand(50)).toBe('SILVER');
    expect(brokerTierForVolume(M(60_000_000))).toBe('GLOBAL');
    expect(brokerTierForVolume(M(500_000))).toBe('BOUTIQUE');
  });
});
