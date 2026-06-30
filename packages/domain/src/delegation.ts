/**
 * Approval delegation (brief §3 — approval & delegation engine). Pure resolution
 * of who may act on whose behalf: a delegation grants a delegate the delegator's
 * approval authority for a time window, optionally scoped to one permission. The
 * server records delegations and asks this module, at decision time, whether a
 * delegate is currently entitled to act. Clock-free — `now` is passed in.
 */

export interface Delegation {
  delegatorUserId: string;
  delegateUserId: string;
  /** When set, the delegation only covers this permission; absent = all approvals. */
  scopePermission?: string | null;
  startsAtMs?: number | null;
  endsAtMs?: number | null;
  active: boolean;
}

/** Is the delegation active and within its (optional) window at `nowMs`? */
export function isActiveDelegation(d: Delegation, nowMs: number): boolean {
  if (!d.active) return false;
  if (d.startsAtMs != null && nowMs < d.startsAtMs) return false;
  if (d.endsAtMs != null && nowMs > d.endsAtMs) return false;
  return true;
}

/**
 * May `delegateUserId` act for `delegatorUserId` at `nowMs`? When `permission`
 * is given, an unscoped delegation matches any permission; a scoped one matches
 * only that permission.
 */
export function canActAs(
  delegations: Delegation[],
  delegateUserId: string,
  delegatorUserId: string,
  nowMs: number,
  permission?: string,
): boolean {
  return (delegations ?? []).some((d) => {
    if (d.delegateUserId !== delegateUserId || d.delegatorUserId !== delegatorUserId) return false;
    if (!isActiveDelegation(d, nowMs)) return false;
    if (permission && d.scopePermission && d.scopePermission !== permission) return false;
    return true;
  });
}

/** The distinct delegators a delegate may currently act for. */
export function actingFor(delegations: Delegation[], delegateUserId: string, nowMs: number): string[] {
  const set = new Set<string>();
  for (const d of delegations ?? []) {
    if (d.delegateUserId === delegateUserId && isActiveDelegation(d, nowMs)) set.add(d.delegatorUserId);
  }
  return [...set];
}
