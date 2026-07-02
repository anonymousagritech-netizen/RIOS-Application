/**
 * Accumulation control at bind time (industry-gap-analysis Tier-3 item 14).
 *
 * Pure "what-if" projection of zonal aggregates: given the tenant's configured
 * zone limits, the currently bound aggregate per zone, and the exposure a
 * candidate contract would add, compute the projected aggregate per limited
 * zone and a verdict - PASS (within limit), WARN (soft-limit breach) or BLOCK
 * (hard-limit breach). Also the deterministic RDS portfolio loss: a damage
 * ratio applied to zonal exposure. Money is integer minor units; no I/O.
 *
 * Matching rules (documented, deliberately simple):
 * - zone / peril / currency comparisons are trimmed + case-insensitive;
 * - a limit with `peril = null` aggregates every peril in its zone;
 *   a peril-specific limit only matches exposures tagged with that peril;
 * - a limit only applies to exposures in its own currency (cross-currency
 *   accumulation goes through FX upstream and is out of scope here).
 */

export type ZoneLimitMode = 'HARD' | 'SOFT';
export type ZoneVerdict = 'PASS' | 'WARN' | 'BLOCK';

export interface ZoneLimitInput {
  id?: string;
  zone: string;
  /** null/undefined = the limit covers all perils in the zone. */
  peril?: string | null;
  currency: string;
  limitMinor: number;
  mode: ZoneLimitMode;
}

export interface ZoneExposureInput {
  zone: string;
  peril?: string | null;
  currency: string;
  exposureMinor: number;
}

export interface ZoneProjection {
  zone: string;
  peril: string | null;
  currency: string;
  mode: ZoneLimitMode;
  limitMinor: number;
  /** Aggregate already bound in the zone (excluding the candidate contract). */
  currentMinor: number;
  /** What the candidate contract would add. */
  additionMinor: number;
  /** currentMinor + additionMinor - "if we bind this, the aggregate becomes X". */
  projectedMinor: number;
  /** limitMinor − projectedMinor; negative = breach. */
  headroomMinor: number;
  verdict: ZoneVerdict;
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();

function limitMatches(limit: ZoneLimitInput, e: ZoneExposureInput): boolean {
  if (norm(e.zone) !== norm(limit.zone)) return false;
  if (norm(e.currency) !== norm(limit.currency)) return false;
  const lp = norm(limit.peril);
  if (lp === '') return true; // limit covers all perils in the zone
  return norm(e.peril) === lp;
}

function sumMatching(limit: ZoneLimitInput, exposures: ZoneExposureInput[]): number {
  return exposures.reduce((acc, e) => (limitMatches(limit, e) ? acc + e.exposureMinor : acc), 0);
}

/**
 * Project the post-bind aggregate for every limit the candidate contract
 * touches (i.e. where it adds exposure). Limits the contract does not touch
 * are omitted - binding cannot breach a zone it adds nothing to. A projected
 * aggregate strictly above the limit is a breach: BLOCK for HARD limits,
 * WARN for SOFT; exactly at the limit is still PASS (headroom 0).
 */
export function projectZoneAggregates(
  limits: ZoneLimitInput[],
  currentExposures: ZoneExposureInput[],
  additions: ZoneExposureInput[],
): ZoneProjection[] {
  const projections: ZoneProjection[] = [];
  for (const limit of limits ?? []) {
    const additionMinor = sumMatching(limit, additions ?? []);
    if (additionMinor <= 0) continue;
    const currentMinor = sumMatching(limit, currentExposures ?? []);
    const projectedMinor = currentMinor + additionMinor;
    const breached = projectedMinor > limit.limitMinor;
    projections.push({
      zone: limit.zone,
      peril: limit.peril ?? null,
      currency: limit.currency,
      mode: limit.mode,
      limitMinor: limit.limitMinor,
      currentMinor,
      additionMinor,
      projectedMinor,
      headroomMinor: limit.limitMinor - projectedMinor,
      verdict: breached ? (limit.mode === 'HARD' ? 'BLOCK' : 'WARN') : 'PASS',
    });
  }
  return projections;
}

export interface AccumulationSummary {
  verdict: ZoneVerdict;
  blocked: ZoneProjection[];
  warnings: ZoneProjection[];
}

/** Overall verdict over a set of zone projections: any BLOCK wins, else any WARN, else PASS. */
export function accumulationSummary(zones: ZoneProjection[]): AccumulationSummary {
  const blocked = (zones ?? []).filter((z) => z.verdict === 'BLOCK');
  const warnings = (zones ?? []).filter((z) => z.verdict === 'WARN');
  return { verdict: blocked.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARN' : 'PASS', blocked, warnings };
}

export interface RdsZoneLoss {
  zone: string;
  peril: string | null;
  currency: string;
  exposureMinor: number;
  grossLossMinor: number;
}

export interface RdsLossResult {
  damageRatio: number;
  zones: RdsZoneLoss[];
  totalGrossLossMinor: number;
}

/**
 * Deterministic RDS portfolio loss: apply a damage ratio (clamped to [0, 1])
 * to each zone's exposure and sum. Per-zone losses are rounded to whole minor
 * units; the total is the sum of the rounded per-zone losses so the breakdown
 * always reconciles to the total.
 */
export function rdsGrossLoss(exposures: ZoneExposureInput[], damageRatio: number): RdsLossResult {
  const ratio = Math.min(1, Math.max(0, damageRatio));
  const zones = (exposures ?? []).map((e) => ({
    zone: e.zone,
    peril: e.peril ?? null,
    currency: e.currency,
    exposureMinor: e.exposureMinor,
    grossLossMinor: Math.round(e.exposureMinor * ratio),
  }));
  return {
    damageRatio: ratio,
    zones,
    totalGrossLossMinor: zones.reduce((a, z) => a + z.grossLossMinor, 0),
  };
}
