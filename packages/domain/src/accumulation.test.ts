/**
 * Accumulation control (bind-time zonal aggregate projection + RDS loss).
 */

import { describe, expect, it } from 'vitest';
import {
  projectZoneAggregates,
  accumulationSummary,
  rdsGrossLoss,
  type ZoneLimitInput,
  type ZoneExposureInput,
} from './accumulation.js';

const hardLimit: ZoneLimitInput = { zone: 'US-FL-WIND', peril: null, currency: 'USD', limitMinor: 100_000_000, mode: 'HARD' };
const softLimit: ZoneLimitInput = { zone: 'JP-EQ', peril: 'EARTHQUAKE', currency: 'USD', limitMinor: 50_000_000, mode: 'SOFT' };

describe('projectZoneAggregates', () => {
  it('projects current + addition against the limit and passes within it', () => {
    const current: ZoneExposureInput[] = [{ zone: 'US-FL-WIND', peril: 'WIND', currency: 'USD', exposureMinor: 60_000_000 }];
    const additions: ZoneExposureInput[] = [{ zone: 'US-FL-WIND', peril: 'WIND', currency: 'USD', exposureMinor: 30_000_000 }];
    const [p] = projectZoneAggregates([hardLimit], current, additions);
    expect(p).toMatchObject({
      zone: 'US-FL-WIND',
      currentMinor: 60_000_000,
      additionMinor: 30_000_000,
      projectedMinor: 90_000_000,
      headroomMinor: 10_000_000,
      verdict: 'PASS',
    });
  });

  it('exactly at the limit is still PASS (headroom 0); one over is a breach', () => {
    const at = projectZoneAggregates([hardLimit], [], [{ zone: 'US-FL-WIND', currency: 'USD', exposureMinor: 100_000_000 }]);
    expect(at[0]!.verdict).toBe('PASS');
    expect(at[0]!.headroomMinor).toBe(0);
    const over = projectZoneAggregates([hardLimit], [], [{ zone: 'US-FL-WIND', currency: 'USD', exposureMinor: 100_000_001 }]);
    expect(over[0]!.verdict).toBe('BLOCK');
    expect(over[0]!.headroomMinor).toBe(-1);
  });

  it('a HARD breach is BLOCK, a SOFT breach is WARN', () => {
    const current: ZoneExposureInput[] = [{ zone: 'JP-EQ', peril: 'EARTHQUAKE', currency: 'USD', exposureMinor: 40_000_000 }];
    const additions: ZoneExposureInput[] = [{ zone: 'JP-EQ', peril: 'EARTHQUAKE', currency: 'USD', exposureMinor: 20_000_000 }];
    const [soft] = projectZoneAggregates([softLimit], current, additions);
    expect(soft!.verdict).toBe('WARN');
    const [hard] = projectZoneAggregates([{ ...softLimit, mode: 'HARD' }], current, additions);
    expect(hard!.verdict).toBe('BLOCK');
  });

  it('omits limits the candidate adds nothing to', () => {
    const additions: ZoneExposureInput[] = [{ zone: 'US-FL-WIND', currency: 'USD', exposureMinor: 1 }];
    const zones = projectZoneAggregates([hardLimit, softLimit], [], additions);
    expect(zones.length).toBe(1);
    expect(zones[0]!.zone).toBe('US-FL-WIND');
  });

  it('a null-peril limit aggregates all perils in the zone; a peril-specific limit only its own', () => {
    const additions: ZoneExposureInput[] = [
      { zone: 'US-FL-WIND', peril: 'WIND', currency: 'USD', exposureMinor: 40_000_000 },
      { zone: 'US-FL-WIND', peril: 'FLOOD', currency: 'USD', exposureMinor: 70_000_000 },
    ];
    const [allPerils] = projectZoneAggregates([hardLimit], [], additions);
    expect(allPerils!.additionMinor).toBe(110_000_000);
    expect(allPerils!.verdict).toBe('BLOCK');
    const windOnly = projectZoneAggregates([{ ...hardLimit, peril: 'WIND' }], [], additions);
    expect(windOnly[0]!.additionMinor).toBe(40_000_000);
    expect(windOnly[0]!.verdict).toBe('PASS');
    // A peril-specific limit does not match untagged (null-peril) exposure.
    const untagged = projectZoneAggregates([{ ...hardLimit, peril: 'WIND' }], [], [
      { zone: 'US-FL-WIND', peril: null, currency: 'USD', exposureMinor: 999_000_000 },
    ]);
    expect(untagged.length).toBe(0);
  });

  it('matches zone/peril case-insensitively but never across currencies', () => {
    const additions: ZoneExposureInput[] = [{ zone: 'us-fl-wind ', peril: 'wind', currency: 'usd', exposureMinor: 150_000_000 }];
    const zones = projectZoneAggregates([hardLimit], [], additions);
    expect(zones[0]!.verdict).toBe('BLOCK');
    const eur = projectZoneAggregates([hardLimit], [], [{ zone: 'US-FL-WIND', currency: 'EUR', exposureMinor: 150_000_000 }]);
    expect(eur.length).toBe(0); // cross-currency accumulation goes through FX upstream
  });

  it('handles empty inputs', () => {
    expect(projectZoneAggregates([], [], [])).toEqual([]);
    expect(projectZoneAggregates([hardLimit], [], [])).toEqual([]);
  });
});

describe('accumulationSummary', () => {
  it('BLOCK beats WARN beats PASS', () => {
    const mk = (verdict: 'PASS' | 'WARN' | 'BLOCK') =>
      ({ ...projectZoneAggregates([hardLimit], [], [{ zone: 'US-FL-WIND', currency: 'USD', exposureMinor: 1 }])[0]!, verdict });
    expect(accumulationSummary([mk('PASS')]).verdict).toBe('PASS');
    expect(accumulationSummary([mk('PASS'), mk('WARN')]).verdict).toBe('WARN');
    const s = accumulationSummary([mk('WARN'), mk('BLOCK')]);
    expect(s.verdict).toBe('BLOCK');
    expect(s.blocked.length).toBe(1);
    expect(s.warnings.length).toBe(1);
    expect(accumulationSummary([]).verdict).toBe('PASS');
  });
});

describe('rdsGrossLoss', () => {
  it('applies the damage ratio per zone and the total reconciles to the breakdown', () => {
    const r = rdsGrossLoss(
      [
        { zone: 'US-FL-WIND', peril: 'WIND', currency: 'USD', exposureMinor: 100_000_001 },
        { zone: 'US-GA-WIND', peril: 'WIND', currency: 'USD', exposureMinor: 50_000_001 },
      ],
      0.25,
    );
    expect(r.zones[0]!.grossLossMinor).toBe(25_000_000); // round(100_000_001 × 0.25)
    expect(r.zones[1]!.grossLossMinor).toBe(12_500_000);
    expect(r.totalGrossLossMinor).toBe(r.zones.reduce((a, z) => a + z.grossLossMinor, 0));
  });

  it('clamps the damage ratio to [0, 1] and handles empty portfolios', () => {
    expect(rdsGrossLoss([{ zone: 'Z', currency: 'USD', exposureMinor: 100 }], 2).zones[0]!.grossLossMinor).toBe(100);
    expect(rdsGrossLoss([{ zone: 'Z', currency: 'USD', exposureMinor: 100 }], -1).zones[0]!.grossLossMinor).toBe(0);
    expect(rdsGrossLoss([], 0.5).totalGrossLossMinor).toBe(0);
  });
});
