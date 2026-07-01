/**
 * Treaty clauses that reshape XL recoveries (brief §7.4).
 *
 * - Index / stability clauses re-express an excess layer's attachment and limit
 *   in settlement-date money so the reinsurer is not eroded by claims inflation
 *   between inception and settlement (full index clause, franchise, and the
 *   severe-inflation variant that only indexes inflation above a threshold).
 * - The hours clause aggregates dated losses from a catastrophe into occurrences
 *   bounded by a time window (e.g. 72 hours for windstorm).
 *
 * Pure calculators; rates/indices/timestamps are supplied by the caller.
 */

import { Money, multiply, subtract, clamp, zero, add } from './money.js';

export type IndexClause = 'FULL' | 'FRANCHISE' | 'SEVERE_INFLATION';

export interface IndexedLayerInput {
  attachment: Money;
  limit: Money;
  /** Index value at inception (the base). */
  baseIndex: number;
  /** Index value at loss settlement. */
  settlementIndex: number;
  /** FULL (default), FRANCHISE (index only once inflation exceeds the threshold), or SEVERE_INFLATION. */
  clause?: IndexClause;
  /** Threshold as a percentage for FRANCHISE / SEVERE_INFLATION (e.g. 10 = 10%). */
  franchisePct?: number;
}

export interface IndexedLayer {
  indexFactor: number;
  indexedAttachment: Money;
  indexedLimit: Money;
}

/** Compute the settlement-indexed attachment and limit for an excess layer. */
export function indexLayer(input: IndexedLayerInput): IndexedLayer {
  if (!(input.baseIndex > 0)) throw new RangeError('baseIndex must be positive');
  if (!(input.settlementIndex > 0)) throw new RangeError('settlementIndex must be positive');
  const raw = input.settlementIndex / input.baseIndex;
  const clause = input.clause ?? 'FULL';
  const franchise = (input.franchisePct ?? 0) / 100;
  let factor = raw;
  if (clause === 'FRANCHISE') {
    // No indexation until cumulative inflation breaches the franchise; then full.
    factor = raw - 1 >= franchise ? raw : 1;
  } else if (clause === 'SEVERE_INFLATION') {
    // Only inflation above the franchise is indexed (the layer and cedent share the first slice).
    factor = 1 + Math.max(0, raw - 1 - franchise);
  }
  return {
    indexFactor: Math.round(factor * 1e6) / 1e6,
    indexedAttachment: multiply(input.attachment, factor),
    indexedLimit: multiply(input.limit, factor),
  };
}

/** Recovery from an index-linked excess layer for a settlement-date gross loss. */
export function indexedRecovery(grossLoss: Money, input: IndexedLayerInput): { indexed: IndexedLayer; recovery: Money } {
  const indexed = indexLayer(input);
  const ccy = grossLoss.currency;
  const excess = subtract(grossLoss, indexed.indexedAttachment);
  return { indexed, recovery: clamp(excess, zero(ccy), indexed.indexedLimit) };
}

export interface DatedLoss {
  /** Time of the loss, in hours since a common epoch. */
  at: number;
  amount: Money;
}

export interface OccurrenceWindow {
  startAt: number;
  endAt: number;
  total: Money;
  lossCount: number;
}

/**
 * Aggregate dated losses into occurrences under an hours clause. Losses are
 * grouped by a sliding window of `windowHours`: starting from the earliest
 * unassigned loss, every loss within [start, start + windowHours] joins that
 * occurrence. This earliest-start grouping is deterministic; optimising the
 * window placement to maximise a single occurrence is a documented refinement.
 */
export function hoursClauseOccurrences(losses: DatedLoss[], windowHours: number): OccurrenceWindow[] {
  if (!(windowHours > 0)) throw new RangeError('windowHours must be positive');
  if (losses.length === 0) return [];
  const sorted = [...losses].sort((a, b) => a.at - b.at);
  const ccy = sorted[0]!.amount.currency;
  const out: OccurrenceWindow[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!.at;
    let total = zero(ccy);
    let end = start;
    let count = 0;
    let j = i;
    while (j < sorted.length && sorted[j]!.at <= start + windowHours) {
      total = add(total, sorted[j]!.amount);
      end = sorted[j]!.at;
      count += 1;
      j += 1;
    }
    out.push({ startAt: start, endAt: end, total, lossCount: count });
    i = j;
  }
  return out;
}
