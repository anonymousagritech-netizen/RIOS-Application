/**
 * Technical & financial accounting primitives - brief §7.6.
 *
 * A Financial Event is the immutable, reinsurance-specific monetary fact
 * (premium, commission, tax, paid loss, reserve movement, reinstatement premium,
 * portfolio transfer, deposit/interest). Statements net them between parties;
 * ledger postings carry them into the GL. The chain technical event → statement
 * → posting must be reconcilable end to end, which the functions here enforce.
 */

import { Money, zero, add, subtract, negate, sum, isZero } from './money.js';

/** The vocabulary of technical-accounting events (§7.6). Stored as reference data in the platform (§10). */
export type FinancialEventType =
  | 'DEPOSIT_PREMIUM'
  | 'INSTALMENT_PREMIUM'
  | 'ADJUSTMENT_PREMIUM'
  | 'REINSTATEMENT_PREMIUM'
  | 'MINIMUM_PREMIUM'
  | 'CEDING_COMMISSION'
  | 'OVERRIDING_COMMISSION'
  | 'PROFIT_COMMISSION'
  | 'BROKERAGE'
  | 'TAX'
  | 'LEVY'
  | 'PAID_LOSS'
  | 'CASH_LOSS'
  | 'OUTSTANDING_RESERVE_MOVEMENT'
  | 'RECOVERY'
  | 'PORTFOLIO_PREMIUM_TRANSFER'
  | 'PORTFOLIO_LOSS_TRANSFER'
  | 'DEPOSIT_WITHHELD'
  | 'DEPOSIT_INTEREST';

/** Whether an event is a debit or credit from the *cedent's* perspective. */
export type Direction = 'DR' | 'CR';

export interface FinancialEvent {
  id: string;
  contractId: string;
  type: FinancialEventType;
  /** Amount, always a positive Money; direction carries the sign. */
  amount: Money;
  direction: Direction;
  /** When the event is economically effective (accounting date). */
  bookedAt: string;
}

/**
 * Signed contribution of an event to a party's net balance, from the cedent's
 * perspective. Premiums and reinstatements are receivable by the reinsurer (a
 * cedent debit); commissions, taxes paid to the cedent, paid losses and
 * recoveries move the other way.
 */
export function signedAmount(event: FinancialEvent): Money {
  return event.direction === 'DR' ? event.amount : negate(event.amount);
}

export interface StatementLine {
  type: FinancialEventType;
  count: number;
  total: Money;
}

export interface StatementOfAccount {
  currency: string;
  lines: StatementLine[];
  /** Net balance owed by the cedent to the reinsurer (positive) or vice-versa (negative). */
  balance: Money;
  eventCount: number;
}

/**
 * Net a set of financial events into a statement of account, grouped by type.
 * All events must share a currency (cross-currency netting goes through FX first).
 */
export function buildStatement(events: FinancialEvent[], currency: string): StatementOfAccount {
  for (const e of events) {
    if (e.amount.currency !== currency) {
      throw new Error(
        `Statement currency ${currency} but event ${e.id} is ${e.amount.currency}; convert via FX before netting.`,
      );
    }
  }

  const byType = new Map<FinancialEventType, { count: number; total: Money }>();
  for (const e of events) {
    const entry = byType.get(e.type) ?? { count: 0, total: zero(currency) };
    entry.count += 1;
    entry.total = add(entry.total, signedAmount(e));
    byType.set(e.type, entry);
  }

  const lines: StatementLine[] = [...byType.entries()].map(([type, v]) => ({
    type,
    count: v.count,
    total: v.total,
  }));

  const balance = sum(
    events.map(signedAmount),
    currency,
  );

  return { currency, lines, balance, eventCount: events.length };
}

// ---------------------------------------------------------------------------
// Double-entry ledger posting & reconciliation
// ---------------------------------------------------------------------------

export interface PostingLeg {
  account: string;
  /** Debit amount (>=0). Exactly one of debit/credit is non-zero. */
  debit: Money;
  /** Credit amount (>=0). */
  credit: Money;
}

export interface LedgerPosting {
  /** The financial event(s) this posting derives from - preserves lineage (§18.4). */
  sourceEventIds: string[];
  legs: PostingLeg[];
}

export class UnbalancedPostingError extends Error {}

/** A posting is valid only if total debits equal total credits (double entry). */
export function assertBalanced(posting: LedgerPosting): void {
  if (posting.legs.length === 0) throw new UnbalancedPostingError('Posting has no legs');
  const currency = posting.legs[0]!.debit.currency;
  const totalDebit = sum(posting.legs.map((l) => l.debit), currency);
  const totalCredit = sum(posting.legs.map((l) => l.credit), currency);
  if (!isZero(subtract(totalDebit, totalCredit))) {
    throw new UnbalancedPostingError(
      `Posting does not balance: debits ${totalDebit.amount} != credits ${totalCredit.amount}`,
    );
  }
}

export interface ReconciliationResult {
  reconciled: boolean;
  statementBalance: Money;
  controlAccountMovement: Money;
  /** statementBalance − controlAccountMovement; zero when reconciled. */
  difference: Money;
}

/**
 * Reconciliation check (§7.6, §27). Each financial event posts a balanced entry
 * with one leg hitting a counterparty *control account*. The net movement on
 * that control account across all postings must equal the statement balance.
 * Returns the difference (zero when the technical→financial chain reconciles).
 */
export function reconcile(
  statement: StatementOfAccount,
  postings: LedgerPosting[],
  controlAccount: string,
): ReconciliationResult {
  const currency = statement.currency;
  let movement = zero(currency);
  for (const p of postings) {
    assertBalanced(p);
    for (const leg of p.legs) {
      if (leg.account === controlAccount) {
        movement = add(movement, subtract(leg.debit, leg.credit));
      }
    }
  }
  const difference = subtract(statement.balance, movement);
  return {
    reconciled: isZero(difference),
    statementBalance: statement.balance,
    controlAccountMovement: movement,
    difference,
  };
}
