/**
 * Renewal analytics - pure, deterministic, framework-free.
 *
 * At renewal an underwriter tracks two things above all: are we *keeping* the
 * business (retention) and are we getting *rate* (renewal premium vs expiring).
 * This module computes both from integer minor-unit premiums and rolls a book of
 * renewal submissions into portfolio KPIs. No I/O.
 */

/** Rate change of a renewal vs its expiring premium, as a percentage.
 *  +5 means the renewal is 5% dearer (rate up). Returns null if no expiring base. */
export function renewalRateChangePct(renewalPremiumMinor: number, expiringPremiumMinor: number): number | null {
  if (!expiringPremiumMinor || expiringPremiumMinor <= 0) return null;
  return round1(((renewalPremiumMinor - expiringPremiumMinor) / expiringPremiumMinor) * 100);
}

/** Retention rate = kept / up-for-renewal, as a percentage. */
export function retentionRatePct(renewedCount: number, upForRenewalCount: number): number {
  if (upForRenewalCount <= 0) return 0;
  return round1((renewedCount / upForRenewalCount) * 100);
}

export interface RenewalRow {
  stage: string;                 // submission stage
  expiringPremiumMinor: number;  // prior-year premium
  renewalPremiumMinor: number;   // target/est premium this year (0 if unpriced)
}

export interface RenewalBook {
  upForRenewal: number;
  renewed: number;               // BOUND
  lapsed: number;                // LAPSED / DECLINED
  inProgress: number;
  expiringPremiumMinor: number;
  renewedPremiumMinor: number;
  retentionRatePct: number;      // by count
  premiumRetentionPct: number;   // by premium (renewed vs expiring of renewed)
  avgRateChangePct: number | null;
}

const isRenewed = (s: string) => s === 'BOUND';
const isLapsed = (s: string) => s === 'LAPSED' || s === 'DECLINED';

/** Roll a set of renewal submissions into portfolio retention + rate KPIs. */
export function renewalBook(rows: RenewalRow[]): RenewalBook {
  let renewed = 0, lapsed = 0, inProgress = 0;
  let expiringPremium = 0, renewedPremium = 0, renewedExpiring = 0;
  const rateChanges: number[] = [];

  for (const r of rows) {
    expiringPremium += r.expiringPremiumMinor;
    if (isRenewed(r.stage)) {
      renewed++;
      renewedPremium += r.renewalPremiumMinor;
      renewedExpiring += r.expiringPremiumMinor;
      const rc = renewalRateChangePct(r.renewalPremiumMinor, r.expiringPremiumMinor);
      if (rc !== null) rateChanges.push(rc);
    } else if (isLapsed(r.stage)) {
      lapsed++;
    } else {
      inProgress++;
    }
  }

  const upForRenewal = rows.length;
  return {
    upForRenewal,
    renewed,
    lapsed,
    inProgress,
    expiringPremiumMinor: expiringPremium,
    renewedPremiumMinor: renewedPremium,
    retentionRatePct: retentionRatePct(renewed, upForRenewal),
    premiumRetentionPct: renewedExpiring > 0 ? round1((renewedPremium / renewedExpiring) * 100) : 0,
    avgRateChangePct: rateChanges.length ? round1(rateChanges.reduce((a, b) => a + b, 0) / rateChanges.length) : null,
  };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
