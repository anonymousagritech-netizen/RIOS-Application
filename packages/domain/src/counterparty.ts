/**
 * Counterparty analytics - broker & cedent relationship, performance and
 * profitability. Pure, deterministic, framework-free.
 *
 * Brokers and cedents are the two sides of the placement relationship. An
 * underwriter judges each on the same axes: how much business they bring, how
 * profitable it is, how well they renew, and how long/strong the relationship is.
 * This module turns the raw book (premium, claims, commission, counts) into those
 * scores and KPIs. No I/O.
 */

export interface CounterpartyBookInput {
  gwpMinor: number;           // gross written premium placed via / ceded by them
  incurredMinor: number;      // incurred losses on that business
  commissionMinor: number;    // commission / brokerage paid
  contractsBound: number;     // deals bound
  contractsQuoted: number;    // deals quoted (for hit ratio)
  renewedCount: number;       // renewals kept
  upForRenewalCount: number;  // renewals available
  yearsActive: number;        // relationship length
}

export interface CounterpartyProfitability {
  gwpMinor: number;
  incurredMinor: number;
  commissionMinor: number;
  lossRatioPct: number;
  commissionRatioPct: number;
  combinedRatioPct: number;
  underwritingResultMinor: number;   // gwp - incurred - commission
  marginPct: number;
}

/** Loss + commission ratios and the underwriting result on a book. */
export function counterpartyProfitability(b: CounterpartyBookInput): CounterpartyProfitability {
  const gwp = Math.max(0, b.gwpMinor);
  const lossRatio = gwp > 0 ? (b.incurredMinor / gwp) * 100 : 0;
  const commissionRatio = gwp > 0 ? (b.commissionMinor / gwp) * 100 : 0;
  const combined = round1(lossRatio + commissionRatio);
  const uwResult = gwp - b.incurredMinor - b.commissionMinor;
  return {
    gwpMinor: gwp,
    incurredMinor: b.incurredMinor,
    commissionMinor: b.commissionMinor,
    lossRatioPct: round1(lossRatio),
    commissionRatioPct: round1(commissionRatio),
    combinedRatioPct: combined,
    underwritingResultMinor: uwResult,
    marginPct: gwp > 0 ? round1((uwResult / gwp) * 100) : 0,
  };
}

export interface CounterpartyScore {
  score: number;              // 0..100 relationship / quality score
  band: 'PLATINUM' | 'GOLD' | 'SILVER' | 'BRONZE';
  hitRatioPct: number;
  retentionPct: number;
  contributions: { factor: string; points: number; detail: string }[];
}

/**
 * A transparent relationship score (0..100): rewards volume, profitability,
 * conversion, retention and tenure. Every factor's contribution is returned so
 * the score is explainable to an auditor and the counterparty.
 */
export function counterpartyScore(b: CounterpartyBookInput): CounterpartyScore {
  const prof = counterpartyProfitability(b);
  const contributions: { factor: string; points: number; detail: string }[] = [];

  // Profitability — up to 35 pts. A combined ratio ≤ 80% saturates; ≥ 120% zero.
  const cr = prof.combinedRatioPct || 100;
  const profPts = clamp(((120 - cr) / 40) * 35, 0, 35);
  contributions.push({ factor: 'Profitability', points: round1(profPts), detail: `Combined ratio ${cr}%` });

  // Volume — up to 25 pts on a log scale (10m GWP ≈ full marks).
  const gwpMajor = b.gwpMinor / 100;
  const volPts = clamp((Math.log10(Math.max(1, gwpMajor)) / 7) * 25, 0, 25);
  contributions.push({ factor: 'Volume', points: round1(volPts), detail: fmtMoney(b.gwpMinor) + ' GWP' });

  // Conversion — up to 15 pts from the quote→bind hit ratio.
  const hit = b.contractsQuoted > 0 ? (b.contractsBound / b.contractsQuoted) * 100 : 0;
  contributions.push({ factor: 'Conversion', points: round1(clamp(hit / 100 * 15, 0, 15)), detail: `${round1(hit)}% hit ratio` });

  // Retention — up to 15 pts from renewal retention.
  const ret = b.upForRenewalCount > 0 ? (b.renewedCount / b.upForRenewalCount) * 100 : 0;
  contributions.push({ factor: 'Retention', points: round1(clamp(ret / 100 * 15, 0, 15)), detail: `${round1(ret)}% retention` });

  // Tenure — up to 10 pts for a 10+ year relationship.
  contributions.push({ factor: 'Tenure', points: round1(clamp(b.yearsActive, 0, 10)), detail: `${b.yearsActive} year(s)` });

  const score = Math.round(clamp(contributions.reduce((a, c) => a + c.points, 0), 0, 100));
  return { score, band: scoreBand(score), hitRatioPct: round1(hit), retentionPct: round1(ret), contributions };
}

export function scoreBand(score: number): CounterpartyScore['band'] {
  if (score >= 80) return 'PLATINUM';
  if (score >= 60) return 'GOLD';
  if (score >= 40) return 'SILVER';
  return 'BRONZE';
}

/** Broker tier from placed volume (a simple, overridable classification). */
export function brokerTierForVolume(gwpMinor: number): 'GLOBAL' | 'REGIONAL' | 'STANDARD' | 'BOUTIQUE' {
  const m = gwpMinor / 100;
  if (m >= 50_000_000) return 'GLOBAL';
  if (m >= 10_000_000) return 'REGIONAL';
  if (m >= 1_000_000) return 'STANDARD';
  return 'BOUTIQUE';
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function round1(v: number): number { return Math.round(v * 10) / 10; }
function fmtMoney(minor: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(minor / 100);
}
