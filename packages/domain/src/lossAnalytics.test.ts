import { describe, it, expect } from 'vitest';
import { lossRatioPct, frequencySeverity, developmentFactors, projectUltimate, technicalAccount } from './lossAnalytics.js';

const M = (major: number) => major * 100;

describe('loss analytics', () => {
  it('computes loss ratio', () => {
    expect(lossRatioPct(M(650_000), M(1_000_000))).toBe(65);
    expect(lossRatioPct(M(100), 0)).toBe(0);
  });

  it('computes frequency and severity', () => {
    const fs = frequencySeverity(20, 100, M(2_000_000));
    expect(fs.frequency).toBe(0.2);
    expect(fs.severityMinor).toBe(M(100_000));
    expect(fs.claimCount).toBe(20);
  });

  it('derives volume-weighted development factors from a triangle', () => {
    // Simple cumulative triangle: each origin develops ×1.5 then ×1.2.
    const tri = [
      [100, 150, 180],
      [200, 300, 360],
      [400, 600],
      [800],
    ];
    const f = developmentFactors(tri);
    expect(f.length).toBe(2);
    // age0→1: (150+300+600)/(100+200+400)=1050/700=1.5
    expect(f[0]).toBe(1.5);
    // age1→2: (180+360)/(150+300)=540/450=1.2
    expect(f[1]).toBe(1.2);
  });

  it('projects ultimates and IBNR', () => {
    const tri = [
      [100, 150, 180],
      [200, 300, 360],
      [400, 600],
      [800],
    ];
    const f = developmentFactors(tri); // [1.5, 1.2]
    const u = projectUltimate(tri, f);
    // origin0 fully developed → 180; origin1 → 360; origin2: 600×1.2=720; origin3: 800×1.5×1.2=1440
    expect(u.ultimates).toEqual([180, 360, 720, 1440]);
    expect(u.totalUltimateMinor).toBe(180 + 360 + 720 + 1440);
    expect(u.latestMinor).toBe(180 + 360 + 600 + 800);
    expect(u.ibnrMinor).toBe(u.totalUltimateMinor - u.latestMinor);
    expect(u.ibnrMinor).toBeGreaterThan(0);
  });

  it('builds a technical account with ratios and result', () => {
    const ta = technicalAccount({ premiumMinor: M(1_000_000), commissionMinor: M(200_000), claimsMinor: M(600_000), expensesMinor: M(50_000) });
    expect(ta.lossRatioPct).toBe(60);
    expect(ta.commissionRatioPct).toBe(20);
    expect(ta.expenseRatioPct).toBe(5);
    expect(ta.combinedRatioPct).toBe(85);
    expect(ta.technicalResultMinor).toBe(M(150_000));
  });
});
