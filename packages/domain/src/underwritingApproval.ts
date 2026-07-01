/**
 * Underwriting approval matrix - pure, declarative, framework-free.
 *
 * Reinsurers delegate binding authority in tiers: an underwriter can bind within
 * their limit, but larger or riskier business is *referred up* a chain -
 * underwriter → senior underwriter → chief underwriter → underwriting committee.
 * Each level carries a service-level (SLA) turnaround expectation.
 *
 * This module encodes that authority matrix as data and evaluates it: given a
 * submission's risk band and limit it returns the required sign-off level, the
 * reason, the SLA and the full escalation chain. It is the shared, testable
 * contract the server enforces and the workbench renders; it does no I/O.
 *
 * Authority levels map to permissions the RBAC layer already grants. A finer
 * per-level permission split (senior vs chief) is a designed-for extension
 * (docs/open-questions.md); today senior/chief/committee all exercise
 * `underwriting:approve`, and the *level* drives escalation + SLA + display.
 */

import type { RiskBand } from './underwriting.js';

export type ApprovalLevel = 'UNDERWRITER' | 'SENIOR_UW' | 'CHIEF_UW' | 'COMMITTEE';

/** Levels in ascending authority order. */
export const APPROVAL_LEVELS: ApprovalLevel[] = ['UNDERWRITER', 'SENIOR_UW', 'CHIEF_UW', 'COMMITTEE'];

const LEVEL_RANK: Record<ApprovalLevel, number> = { UNDERWRITER: 0, SENIOR_UW: 1, CHIEF_UW: 2, COMMITTEE: 3 };

/** The permission a level's holder must carry to sign off at that level. */
export const LEVEL_PERMISSION: Record<ApprovalLevel, string> = {
  UNDERWRITER: 'underwriting:write',
  SENIOR_UW: 'underwriting:approve',
  CHIEF_UW: 'underwriting:approve',
  COMMITTEE: 'underwriting:approve',
};

/** SLA turnaround (hours) an approval at each level is expected to clear within. */
export const LEVEL_SLA_HOURS: Record<ApprovalLevel, number> = {
  UNDERWRITER: 8, SENIOR_UW: 48, CHIEF_UW: 24, COMMITTEE: 72,
};

export interface ApprovalRule {
  /** Human-readable rule name (shown as the referral reason). */
  reason: string;
  /** Minimum bound limit (integer minor units) this rule applies from. */
  minLimitMinor?: number;
  /** Risk bands this rule applies to (omit = any band). */
  bands?: RiskBand[];
  /** Required sign-off level when the rule matches. */
  level: ApprovalLevel;
}

/**
 * The default authority matrix. Rules are evaluated in order; the *highest*
 * required level across all matching rules wins (escalation is monotone). All
 * thresholds are integer minor units (× 100). This is the metadata a fuller
 * build would move into tenant configuration.
 */
export const DEFAULT_APPROVAL_MATRIX: ApprovalRule[] = [
  { reason: 'Within delegated authority', level: 'UNDERWRITER', minLimitMinor: 0 },
  { reason: 'Elevated risk band', level: 'SENIOR_UW', bands: ['ELEVATED'] },
  { reason: 'Limit ≥ 10m', level: 'SENIOR_UW', minLimitMinor: 10_000_000 * 100 },
  { reason: 'High risk band', level: 'CHIEF_UW', bands: ['HIGH'] },
  { reason: 'Limit ≥ 25m', level: 'CHIEF_UW', minLimitMinor: 25_000_000 * 100 },
  { reason: 'Limit ≥ 100m', level: 'COMMITTEE', minLimitMinor: 100_000_000 * 100 },
];

export interface ApprovalRequirementInput {
  band?: RiskBand | null;
  limitMinor?: number | null;
  matrix?: ApprovalRule[];
}

export interface ApprovalRequirement {
  level: ApprovalLevel;
  /** True when the level is above a plain underwriter — i.e. referral needed. */
  referralRequired: boolean;
  reason: string;
  slaHours: number;
  permission: string;
  /** The ordered escalation chain from underwriter up to the required level. */
  chain: ApprovalLevel[];
}

/**
 * Evaluate the matrix for a submission. Returns the highest required level, the
 * reason that drove it, the SLA and the escalation chain. When nothing above
 * underwriter matches, the underwriter's own authority applies (no referral).
 */
export function requiredApproval(input: ApprovalRequirementInput): ApprovalRequirement {
  const matrix = input.matrix ?? DEFAULT_APPROVAL_MATRIX;
  const limit = input.limitMinor ?? 0;
  const band = input.band ?? undefined;

  let best: ApprovalRule = { reason: 'Within delegated authority', level: 'UNDERWRITER', minLimitMinor: 0 };
  for (const rule of matrix) {
    const limitOk = rule.minLimitMinor === undefined || limit >= rule.minLimitMinor;
    const bandOk = !rule.bands || (band !== undefined && rule.bands.includes(band));
    if (limitOk && bandOk && LEVEL_RANK[rule.level] >= LEVEL_RANK[best.level]) best = rule;
  }

  return {
    level: best.level,
    referralRequired: LEVEL_RANK[best.level] > 0,
    reason: best.reason,
    slaHours: LEVEL_SLA_HOURS[best.level],
    permission: LEVEL_PERMISSION[best.level],
    chain: escalationChain(best.level),
  };
}

/** The ordered chain of levels from underwriter up to (and including) `level`. */
export function escalationChain(level: ApprovalLevel): ApprovalLevel[] {
  return APPROVAL_LEVELS.slice(0, LEVEL_RANK[level] + 1);
}

/** True when `heldLevel`'s authority covers a requirement of `requiredLevel`. */
export function levelCovers(heldLevel: ApprovalLevel, requiredLevel: ApprovalLevel): boolean {
  return LEVEL_RANK[heldLevel] >= LEVEL_RANK[requiredLevel];
}

/** Compute an SLA due timestamp (ms epoch) from a raised-at time and level. */
export function slaDueAt(raisedAtMs: number, level: ApprovalLevel): number {
  return raisedAtMs + LEVEL_SLA_HOURS[level] * 3600_000;
}

/** Whether an approval raised at `raisedAtMs` is past its SLA at `nowMs`. */
export function isSlaBreached(raisedAtMs: number, level: ApprovalLevel, nowMs: number): boolean {
  return nowMs > slaDueAt(raisedAtMs, level);
}
