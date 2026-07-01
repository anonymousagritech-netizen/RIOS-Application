/**
 * Claims recoveries, inuring order and event aggregation (brief §7.7).
 *
 * Pure calculators over a claim's gross loss, paid amount and recovery ledger.
 * Recoveries (reinsurance, salvage, subrogation, ...) reduce the net incurred
 * loss; recoveries still outstanding (EXPECTED) are distinguished from cash in
 * hand (RECEIVED). Inuring reinsurance is applied before the protected layer
 * sees the loss, and event losses can be aggregated to the occurrence level.
 * No I/O; the server persists and the accounting chain books the movements.
 */

import { Money, add, subtract, sum, zero, max } from './money.js';

export type RecoveryType = 'REINSURANCE' | 'SALVAGE' | 'SUBROGATION' | 'DEDUCTIBLE' | 'OTHER';
export type RecoveryStatus = 'EXPECTED' | 'RECEIVED';

export interface RecoveryEntry {
  type: RecoveryType;
  amount: Money;
  /** RECEIVED = cash collected; EXPECTED (default) = anticipated but not yet in. */
  status?: RecoveryStatus;
}

export interface RecoveryPosition {
  currency: string;
  grossLoss: Money;
  paid: Money;
  receivedRecovered: Money;
  expectedRecovered: Money;
  totalRecovered: Money;
  /** Recovered amount bucketed by recovery type. */
  byType: Record<string, Money>;
  /** grossLoss - totalRecovered, floored at zero. */
  netIncurred: Money;
  /** paid - receivedRecovered, floored at zero. */
  netPaid: Money;
  /** netIncurred - netPaid: reserve still to settle, floored at zero. */
  outstanding: Money;
}

/**
 * Net a claim down through its recovery ledger. Expected recoveries reduce the
 * net *incurred* position; only received recoveries reduce the net *paid* cash
 * position. All amounts are floored at zero (a claim's net loss is never
 * negative even if subrogation over-recovers).
 */
export function recoveryPosition(grossLoss: Money, paid: Money, recoveries: RecoveryEntry[]): RecoveryPosition {
  const ccy = grossLoss.currency;
  let received = zero(ccy);
  let expected = zero(ccy);
  const byType: Record<string, Money> = {};

  for (const r of recoveries) {
    const status = r.status ?? 'EXPECTED';
    if (status === 'RECEIVED') received = add(received, r.amount);
    else expected = add(expected, r.amount);
    const prev = byType[r.type];
    byType[r.type] = prev ? add(prev, r.amount) : r.amount;
  }

  const total = add(received, expected);
  const netIncurred = max(zero(ccy), subtract(grossLoss, total));
  const netPaid = max(zero(ccy), subtract(paid, received));
  const outstanding = max(zero(ccy), subtract(netIncurred, netPaid));

  return {
    currency: ccy,
    grossLoss,
    paid,
    receivedRecovered: received,
    expectedRecovered: expected,
    totalRecovered: total,
    byType,
    netIncurred,
    netPaid,
    outstanding,
  };
}

export interface InuringResult {
  grossLoss: Money;
  inuringTotal: Money;
  /** Loss net of inuring reinsurance, which the protected layer then sees. */
  netToProtected: Money;
}

/**
 * Apply inuring reinsurance recoveries before the protected cover. Inuring
 * benefits reduce the ground-up loss the protected layer is exposed to.
 */
export function applyInuring(grossLoss: Money, inuringRecoveries: Money[]): InuringResult {
  const ccy = grossLoss.currency;
  const inuringTotal = inuringRecoveries.length ? sum(inuringRecoveries, ccy) : zero(ccy);
  return {
    grossLoss,
    inuringTotal,
    netToProtected: max(zero(ccy), subtract(grossLoss, inuringTotal)),
  };
}

export interface EventLoss {
  event: string;
  loss: Money;
}

export interface EventAggregate {
  event: string;
  total: Money;
  count: number;
}

/**
 * Aggregate individual claim losses to the occurrence/event level (for cat XL
 * where many claims share one event), sorted by total descending. Each event's
 * total can then be fed to programmeRecovery as a single occurrence loss.
 */
export function aggregateByEvent(losses: EventLoss[]): EventAggregate[] {
  const map = new Map<string, { total: Money; count: number; ccy: string }>();
  for (const l of losses) {
    const cur = map.get(l.event);
    if (cur) {
      cur.total = add(cur.total, l.loss);
      cur.count += 1;
    } else {
      map.set(l.event, { total: l.loss, count: 1, ccy: l.loss.currency });
    }
  }
  return [...map.entries()]
    .map(([event, v]) => ({ event, total: v.total, count: v.count }))
    .sort((a, b) => b.total.amount - a.total.amount);
}
