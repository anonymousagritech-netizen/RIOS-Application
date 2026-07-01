/**
 * Territory risk analytics - pure, deterministic, framework-free.
 *
 * A reinsurer accumulates exposure by geography and by accumulation zone
 * (CRESTA, peril, risk belts). This module turns raw per-territory exposure
 * (total insured value, modelled PML, item count) plus an underwriter's risk
 * grade into the numbers a portfolio manager watches: a PML ratio, a blended
 * 0-100 risk score, a severity band, and book-level concentration. Money is
 * integer minor units. No I/O.
 */

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type RiskGrade = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH' | 'SEVERE';

/** Base score contributed by an underwriter-assigned risk grade. */
export const RISK_GRADE_SCORE: Record<RiskGrade, number> = {
  LOW: 10, MODERATE: 30, ELEVATED: 55, HIGH: 75, SEVERE: 95,
};

const BAND_ORDER: RiskGrade[] = ['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'SEVERE'];

/** Map a 0-100 score back to a severity band. */
export function territoryBand(score: number): RiskGrade {
  const s = clamp(score, 0, 100);
  if (s >= 85) return 'SEVERE';
  if (s >= 65) return 'HIGH';
  if (s >= 45) return 'ELEVATED';
  if (s >= 25) return 'MODERATE';
  return 'LOW';
}

export interface TerritoryExposureInput {
  code: string;
  name: string;
  tivMinor: number;
  pmlMinor: number;
  itemCount: number;
  riskGrade?: RiskGrade | null;
}

export interface TerritoryExposureResult extends TerritoryExposureInput {
  pmlRatioPct: number;   // modelled PML as a % of TIV
  sharePct: number;      // this territory's share of the book's TIV
  riskScore: number;     // 0-100 blended score
  band: RiskGrade;       // severity band from the score
}

/**
 * Blend an underwriter's grade with the modelled PML intensity and the
 * territory's share of the book into a single 0-100 score. Grade is the
 * anchor (60%); PML ratio (25%) and portfolio share (15%) modulate it.
 */
export function territoryRiskScore(input: {
  riskGrade?: RiskGrade | null;
  pmlRatioPct: number;
  sharePct: number;
}): number {
  const grade = input.riskGrade ? RISK_GRADE_SCORE[input.riskGrade] : 40;
  const pml = clamp(input.pmlRatioPct, 0, 100);
  const share = clamp(input.sharePct, 0, 100);
  const score = grade * 0.6 + pml * 0.25 + Math.min(share * 2, 100) * 0.15;
  return round2(clamp(score, 0, 100));
}

export interface TerritoryBook {
  territoryCount: number;
  totalTivMinor: number;
  totalPmlMinor: number;
  totalItems: number;
  bookPmlRatioPct: number;
  peakTivCode: string | null;       // territory with the largest TIV
  peakTivSharePct: number;          // its share of the book (concentration)
  highRiskCount: number;            // territories banded HIGH or SEVERE
  rows: TerritoryExposureResult[];  // sorted by TIV desc
}

/** Roll a set of per-territory exposures into a portfolio accumulation view. */
export function territoryBook(inputs: TerritoryExposureInput[]): TerritoryBook {
  const totalTiv = inputs.reduce((a, t) => a + Math.max(0, t.tivMinor), 0);
  const totalPml = inputs.reduce((a, t) => a + Math.max(0, t.pmlMinor), 0);
  const totalItems = inputs.reduce((a, t) => a + Math.max(0, t.itemCount), 0);

  const rows = inputs
    .map((t): TerritoryExposureResult => {
      const pmlRatioPct = t.tivMinor > 0 ? round2((t.pmlMinor / t.tivMinor) * 100) : 0;
      const sharePct = totalTiv > 0 ? round2((t.tivMinor / totalTiv) * 100) : 0;
      const riskScore = territoryRiskScore({ riskGrade: t.riskGrade, pmlRatioPct, sharePct });
      return { ...t, pmlRatioPct, sharePct, riskScore, band: territoryBand(riskScore) };
    })
    .sort((a, b) => b.tivMinor - a.tivMinor);

  const peak = rows[0];
  return {
    territoryCount: rows.length,
    totalTivMinor: totalTiv,
    totalPmlMinor: totalPml,
    totalItems,
    bookPmlRatioPct: totalTiv > 0 ? round2((totalPml / totalTiv) * 100) : 0,
    peakTivCode: peak ? peak.code : null,
    peakTivSharePct: peak ? peak.sharePct : 0,
    highRiskCount: rows.filter((r) => r.band === 'HIGH' || r.band === 'SEVERE').length,
    rows,
  };
}

/** Order two grades; useful for sorting/formatting zone tables by severity. */
export function gradeRank(grade: RiskGrade | null | undefined): number {
  return grade ? BAND_ORDER.indexOf(grade) : -1;
}
