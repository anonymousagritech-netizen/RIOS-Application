/**
 * Retrocession allocation engine (industry-gap-analysis Tier-2 #10, brief §7.5, §29.3).
 *
 * Rule-driven allocation of every inward premium/claim financial event to the
 * outward retrocession program. A rule targets one retro contract, applies to
 * PREMIUM, CLAIM or BOTH, may filter by line of business / currency / event-date
 * window, and cedes a share of the gross event amount under one of three methods:
 *
 *   - QUOTA_SHARE : cede `cessionPct`% of the gross.
 *   - SURPLUS     : cede the surplus above a retention line, capped by max lines
 *                   of capacity (reuses proportional.ts `surplusCession`).
 *   - XL          : cede the layer between `attachment` and `attachment + limit`
 *                   of the gross (reuses nonproportional.ts `layerRecovery`).
 *
 * Multiple matching rules allocate independently - each cedes its own share of
 * the gross - but the integer minor-unit split is done with the largest-remainder
 * method against the combined exact total, capped at the source amount, so the
 * sum of allocations can never exceed the source event (reconcilability, §7.6).
 *
 * Pure: no I/O, no DB, no clock. The server persists; this file computes. The
 * reinsurance math is not re-derived here - SURPLUS and XL delegate to the
 * proportional/non-proportional cores so correctness stays in one place.
 */

import { Money, MoneyError, money, subtract } from './money.js';
import { surplusCession } from './proportional.js';
import { layerRecovery, type Layer } from './nonproportional.js';

export type RetroEventKind = 'PREMIUM' | 'CLAIM';
export type RetroAppliesTo = 'PREMIUM' | 'CLAIM' | 'BOTH';
/** Cession methods the allocation engine can apply to a source event. */
export type RetroMethod = 'QUOTA_SHARE' | 'SURPLUS' | 'XL';

export interface RetroRuleFilter {
  /** Match only events on contracts with this line of business (exact, case-sensitive as supplied). */
  lineOfBusiness?: string | null;
  /** Match only events in this ISO-4217 currency. */
  currency?: string | null;
  /** Match only events booked on/after this ISO date (YYYY-MM-DD), inclusive. */
  periodStart?: string | null;
  /** Match only events booked on/before this ISO date (YYYY-MM-DD), inclusive. */
  periodEnd?: string | null;
}

export interface RetroAllocationRule {
  /** Rule identity (used for deterministic tie-breaking and traceability). */
  id: string;
  /** The outward retrocession contract that receives the ceded amount. */
  retroContractId: string;
  appliesTo: RetroAppliesTo;
  filter?: RetroRuleFilter;
  /** Cession method (see RetroMethod). Each method reads its own params below. */
  method: RetroMethod;
  /** QUOTA_SHARE: cession percentage of the gross event amount, in (0, 100]. */
  cessionPct?: number;
  /** SURPLUS: the retained line in integer minor units (> 0). */
  retentionMinor?: number;
  /** SURPLUS: number of surplus lines of capacity (>= 0); capacity = retention × maxLines. */
  maxLines?: number;
  /** XL: attachment point in integer minor units (>= 0); losses below this are retained. */
  attachmentMinor?: number;
  /** XL: layer limit in integer minor units (> 0); the most the layer cedes for one event. */
  limitMinor?: number;
  /** Lower runs first; purely an ordering/tie-break concern for the remainder distribution. */
  priority: number;
}

export interface RetroSourceEvent {
  kind: RetroEventKind;
  /** Gross event amount (non-negative, integer minor units). */
  amount: Money;
  /** Line of business of the inward contract the event was booked on. */
  lineOfBusiness?: string | null;
  /** Event booking date, ISO YYYY-MM-DD. */
  eventDate?: string | null;
}

export interface RetroAllocationLine {
  ruleId: string;
  retroContractId: string;
  /** The method that produced this line. */
  method: RetroMethod;
  /** Effective ceded share of the gross, as a percentage (rounded to 4 dp). For
   *  QUOTA_SHARE this is the rule's requested pct; for SURPLUS/XL it is the
   *  realised share the method resolved to for this event. */
  cessionPct: number;
  /** Ceded amount in integer minor units, same currency as the source. */
  amount: Money;
}

export interface RetroAllocationResult {
  /** One line per matching rule, in (priority, ruleId) order. May contain zero-amount lines. */
  allocations: RetroAllocationLine[];
  totalCeded: Money;
  retained: Money;
}

/** cessionPct is applied at 1/10,000th-of-a-percent resolution (numeric(7,4) in the DB). */
const PCT_SCALE = 10_000n;
const DENOMINATOR = 100n * PCT_SCALE;

function assertValidRule(rule: RetroAllocationRule): void {
  switch (rule.method) {
    case 'QUOTA_SHARE':
      if (!Number.isFinite(rule.cessionPct) || (rule.cessionPct ?? 0) <= 0 || (rule.cessionPct ?? 0) > 100) {
        throw new RangeError(`QUOTA_SHARE cessionPct must be in (0, 100], got ${rule.cessionPct}`);
      }
      return;
    case 'SURPLUS':
      if (!Number.isFinite(rule.retentionMinor) || (rule.retentionMinor ?? 0) <= 0) {
        throw new RangeError(`SURPLUS retentionMinor must be > 0, got ${rule.retentionMinor}`);
      }
      if (!Number.isFinite(rule.maxLines) || (rule.maxLines ?? -1) < 0) {
        throw new RangeError(`SURPLUS maxLines must be >= 0, got ${rule.maxLines}`);
      }
      return;
    case 'XL':
      if (!Number.isFinite(rule.attachmentMinor) || (rule.attachmentMinor ?? -1) < 0) {
        throw new RangeError(`XL attachmentMinor must be >= 0, got ${rule.attachmentMinor}`);
      }
      if (!Number.isFinite(rule.limitMinor) || (rule.limitMinor ?? 0) <= 0) {
        throw new RangeError(`XL limitMinor must be > 0, got ${rule.limitMinor}`);
      }
      return;
    default:
      throw new RangeError(`Unsupported allocation method: ${String((rule as { method: unknown }).method)}`);
  }
}

/** Does a rule apply to the given inward event? Pure predicate, exported for testability. */
export function matchesRetroRule(event: RetroSourceEvent, rule: RetroAllocationRule): boolean {
  if (rule.appliesTo !== 'BOTH' && rule.appliesTo !== event.kind) return false;
  const f = rule.filter;
  if (!f) return true;
  if (f.lineOfBusiness != null && f.lineOfBusiness !== (event.lineOfBusiness ?? null)) return false;
  if (f.currency != null && f.currency.toUpperCase() !== event.amount.currency) return false;
  // ISO YYYY-MM-DD strings compare correctly lexicographically.
  if (f.periodStart != null && (event.eventDate == null || event.eventDate < f.periodStart)) return false;
  if (f.periodEnd != null && (event.eventDate == null || event.eventDate > f.periodEnd)) return false;
  return true;
}

const round4 = (pct: number): number => Math.round(pct * 10_000) / 10_000;

/**
 * The exact cession a single rule would make against `event`, before the
 * cross-rule remainder distribution and source cap.
 *
 *   numerator / DENOMINATOR = the exact ceded amount in minor units.
 *
 * QUOTA_SHARE carries a genuine fractional numerator (so several QS rules share
 * the sub-minor-unit remainder fairly); SURPLUS and XL delegate to the domain
 * cores, which already yield an integer amount, so their numerator is that
 * integer × DENOMINATOR (no remainder to distribute).
 */
function ruleCession(
  event: RetroSourceEvent,
  rule: RetroAllocationRule,
  source: bigint,
): { numerator: bigint; displayPct: number } {
  switch (rule.method) {
    case 'QUOTA_SHARE': {
      const numerator = source * BigInt(Math.round((rule.cessionPct ?? 0) * Number(PCT_SCALE)));
      return { numerator, displayPct: round4(rule.cessionPct ?? 0) };
    }
    case 'SURPLUS': {
      // Reuse the proportional surplus core: the source amount is the exposure
      // basis; the ceded amount is source × cededShare in integer minor units.
      const res = surplusCession(Number(source), event.amount, {
        retentionLine: rule.retentionMinor ?? 0,
        numberOfLines: rule.maxLines ?? 0,
      });
      return { numerator: BigInt(res.cededPremium.amount) * DENOMINATOR, displayPct: round4(res.cededShare * 100) };
    }
    case 'XL': {
      // Reuse the XL layer-recovery core: cede the slice of the source between
      // attachment and attachment + limit.
      const layer: Layer = {
        attachment: money(rule.attachmentMinor ?? 0, event.amount.currency),
        limit: money(rule.limitMinor ?? 0, event.amount.currency),
        reinstatements: 0,
      };
      const ceded = layerRecovery(event.amount, layer);
      const src = Number(source);
      return {
        numerator: BigInt(ceded.amount) * DENOMINATOR,
        displayPct: src > 0 ? round4((ceded.amount / src) * 100) : 0,
      };
    }
    default:
      // assertValidRule has already rejected unknown methods.
      return { numerator: 0n, displayPct: 0 };
  }
}

/**
 * Allocate one inward event across the matching rules.
 *
 * Each matching rule cedes its method's share of the gross amount. Integer minor
 * units are split by largest remainder: every line gets the floor of its exact
 * share, then the leftover units (up to the floor of the combined exact total,
 * and never beyond the source amount) go one at a time to the largest fractional
 * remainders (ties broken by rule order). If the combined shares run past the
 * source, the total is capped by trimming the lowest-priority lines, so the
 * allocation can never invent money.
 */
export function allocateRetrocession(
  event: RetroSourceEvent,
  rules: RetroAllocationRule[],
): RetroAllocationResult {
  const currency = event.amount.currency;
  if (event.amount.amount < 0) {
    throw new MoneyError(`Cannot allocate a negative source amount: ${event.amount.amount}`);
  }
  for (const rule of rules) assertValidRule(rule);

  const matched = rules
    .filter((r) => matchesRetroRule(event, r))
    .sort((a, b) => (a.priority - b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const source = BigInt(event.amount.amount);
  const cessions = matched.map((r) => ruleCession(event, r, source));
  const numerators = cessions.map((c) => c.numerator);
  const bases = numerators.map((n) => n / DENOMINATOR);
  const remainders = numerators.map((n) => n % DENOMINATOR);

  // Target integer total: floor of the combined exact cession, capped at source.
  const exactTotal = numerators.reduce((a, b) => a + b, 0n);
  const target = minBig(exactTotal / DENOMINATOR, source);

  const parts = [...bases];
  let allocated = bases.reduce((a, b) => a + b, 0n);

  if (allocated < target) {
    // Largest-remainder: hand out one minor unit per line, biggest fraction first.
    const order = remainders
      .map((rem, i) => ({ rem, i }))
      .sort((a, b) => (a.rem === b.rem ? a.i - b.i : b.rem > a.rem ? 1 : -1))
      .map((x) => x.i);
    let idx = 0;
    while (allocated < target && order.length > 0) {
      const i = order[idx % order.length]!;
      parts[i] = parts[i]! + 1n;
      allocated += 1n;
      idx += 1;
    }
  } else if (allocated > target) {
    // Shares summed past the source: trim from the lowest-priority lines.
    for (let i = parts.length - 1; i >= 0 && allocated > target; i--) {
      const cut = minBig(parts[i]!, allocated - target);
      parts[i] = parts[i]! - cut;
      allocated -= cut;
    }
  }

  const allocations: RetroAllocationLine[] = matched.map((rule, i) => ({
    ruleId: rule.id,
    retroContractId: rule.retroContractId,
    method: rule.method,
    cessionPct: cessions[i]!.displayPct,
    amount: money(Number(parts[i]!), currency),
  }));
  const totalCeded = money(Number(allocated), currency);
  return { allocations, totalCeded, retained: subtract(event.amount, totalCeded) };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
