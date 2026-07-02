/**
 * Binding / delegated authority - pure, framework-free authority checking.
 *
 * A reinsurer (or a managing agent) delegates *binding authority* to a coverholder
 * or to an internal underwriter: they may bind business within stated limits - a
 * per-risk line size, an aggregate cap, and (optionally) a line-of-business and a
 * territory scope, for a validity window. When a submission or contract would
 * exceed any of those bounds the authority is *breached* and the risk must be
 * referred up (the same maker/checker escalation the underwriting approval matrix
 * encodes). This module evaluates that authority. It does no I/O: the server
 * records grants, consumption and breaches; the math lives here so it is provable.
 *
 * All money is integer minor units. Dates are ISO `YYYY-MM-DD` strings, compared
 * lexically (safe for that format) so the check stays clock-free and deterministic.
 */

export type BreachKind = 'LINE' | 'AGGREGATE' | 'LOB' | 'TERRITORY' | 'EXPIRED';

export interface Authority {
  /** Scoped line of business; null/undefined means "any LOB". */
  lob?: string | null;
  /** Scoped territory; null/undefined means "any territory". */
  territory?: string | null;
  /** Maximum per-risk line the grantee may bind (integer minor units). */
  maxLineMinor: number;
  /** Maximum cumulative aggregate the grantee may bind (integer minor units). */
  maxAggregateMinor: number;
  /** Validity window (inclusive), ISO `YYYY-MM-DD`. */
  validFrom?: string | null;
  validTo?: string | null;
  /** Lifecycle status; anything other than ACTIVE cannot bind. */
  status?: string | null;
}

export interface CheckAuthorityInput {
  authority: Authority;
  /** The LOB of the risk being bound (checked against the grant's scope). */
  lob?: string | null;
  /** The territory of the risk being bound. */
  territory?: string | null;
  /** The line being bound now (integer minor units). */
  lineMinor: number;
  /** Aggregate already consumed under this authority (integer minor units). */
  priorAggregateMinor?: number;
  /** As-of date for the validity check, ISO `YYYY-MM-DD`. */
  asOf?: string | null;
}

export interface AuthorityCheckResult {
  /** True when no bound is breached - the grantee may bind unilaterally. */
  withinAuthority: boolean;
  /** Every bound breached, in a stable order. */
  breaches: BreachKind[];
  /** True when any breach means the risk must be referred up. */
  referralRequired: boolean;
}

/** Case-insensitive, whitespace-trimmed scope comparison. */
function sameScope(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** True when `asOf` falls outside the grant's inclusive validity window. */
function outsideWindow(asOf: string, from?: string | null, to?: string | null): boolean {
  if (from && asOf < from) return true;
  if (to && asOf > to) return true;
  return false;
}

/**
 * Evaluate a single line against a binding authority. Returns whether it is
 * within authority, the list of breached bounds, and whether a referral is
 * required. Every bound is checked independently so the caller sees the full
 * picture (e.g. an over-line, out-of-territory risk reports both).
 */
export function checkBindingAuthority(input: CheckAuthorityInput): AuthorityCheckResult {
  const { authority, lineMinor } = input;
  const prior = input.priorAggregateMinor ?? 0;
  const breaches: BreachKind[] = [];

  // Expiry / lifecycle: a suspended or expired grant, or one used outside its
  // window, cannot bind at all.
  const status = (authority.status ?? 'ACTIVE').toUpperCase();
  const expiredStatus = status === 'EXPIRED' || status === 'SUSPENDED';
  const outOfWindow = input.asOf ? outsideWindow(input.asOf, authority.validFrom, authority.validTo) : false;
  if (expiredStatus || outOfWindow) breaches.push('EXPIRED');

  // Scope: LOB and territory must match when the grant is scoped to one.
  if (authority.lob && input.lob && !sameScope(authority.lob, input.lob)) breaches.push('LOB');
  if (authority.territory && input.territory && !sameScope(authority.territory, input.territory)) breaches.push('TERRITORY');

  // Line size: the single risk may not exceed the per-risk line.
  if (lineMinor > authority.maxLineMinor) breaches.push('LINE');

  // Aggregate: consumed + this line may not exceed the aggregate cap.
  if (prior + lineMinor > authority.maxAggregateMinor) breaches.push('AGGREGATE');

  return {
    withinAuthority: breaches.length === 0,
    breaches,
    referralRequired: breaches.length > 0,
  };
}
