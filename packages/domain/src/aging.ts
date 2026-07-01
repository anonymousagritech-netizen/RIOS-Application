/**
 * AR/AP aging and cash-receipt application (brief §9.8).
 *
 * Pure sub-ledger calculators over open invoices. Aging buckets outstanding
 * balances by days past due; applyReceipt allocates a cash receipt across open
 * items (oldest-first by default) with integer-exact minor units and no invented
 * pennies. Date maths is done on plain YYYY-MM-DD strings via a deterministic
 * epoch-day conversion, so the domain core stays clock-free and reproducible.
 */

/** Days since 1970-01-01 for a civil date, via Howard Hinnant's algorithm. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Convert a YYYY-MM-DD (or ISO datetime) string to an epoch day number. */
export function epochDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new RangeError(`Expected an ISO date (YYYY-MM-DD), got ${iso}`);
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
}

export interface AgingItem {
  ref?: string;
  outstandingMinor: number;
  dueDate: string;
}

export interface AgingBucket {
  label: string;
  fromDay: number;
  toDay: number | null; // null = open-ended (90+)
  totalMinor: number;
  count: number;
}

export interface AgingReport {
  asOf: string;
  buckets: AgingBucket[];
  totalMinor: number;
  overdueMinor: number;
  /** Outstanding-weighted average days past due (floored at 0 per item). */
  weightedAvgDaysPastDue: number;
}

/**
 * Age a set of open items as of `asOf`. Boundaries default to 30/60/90 giving
 * Current / 1-30 / 31-60 / 61-90 / 90+ buckets. Items not yet due (days past due
 * <= 0) land in Current.
 */
export function agingReport(items: AgingItem[], asOf: string, boundaries: number[] = [30, 60, 90]): AgingReport {
  const asOfDay = epochDay(asOf);
  const bounds = [...boundaries].sort((a, b) => a - b);
  const buckets: AgingBucket[] = [{ label: 'Current', fromDay: -Infinity, toDay: 0, totalMinor: 0, count: 0 }];
  let prev = 0;
  for (const b of bounds) {
    buckets.push({ label: `${prev + 1}-${b}`, fromDay: prev + 1, toDay: b, totalMinor: 0, count: 0 });
    prev = b;
  }
  buckets.push({ label: `${prev + 1}+`, fromDay: prev + 1, toDay: null, totalMinor: 0, count: 0 });

  let total = 0;
  let overdue = 0;
  let weightNum = 0;

  for (const it of items) {
    if (it.outstandingMinor === 0) continue;
    const dpd = asOfDay - epochDay(it.dueDate);
    total += it.outstandingMinor;
    const pastDue = Math.max(0, dpd);
    weightNum += pastDue * it.outstandingMinor;
    if (dpd > 0) overdue += it.outstandingMinor;
    const bucket =
      buckets.find((b) => dpd >= (b.fromDay === -Infinity ? -Infinity : b.fromDay) && (b.toDay === null || dpd <= b.toDay)) ??
      buckets[buckets.length - 1]!;
    bucket.totalMinor += it.outstandingMinor;
    bucket.count += 1;
  }

  return {
    asOf,
    buckets,
    totalMinor: total,
    overdueMinor: overdue,
    weightedAvgDaysPastDue: total > 0 ? Math.round(weightNum / total) : 0,
  };
}

export interface OpenItem {
  ref: string;
  outstandingMinor: number;
  dueDate?: string;
}

export interface Allocation {
  ref: string;
  appliedMinor: number;
  remainingMinor: number;
  fullyPaid: boolean;
}

export interface ReceiptApplication {
  allocations: Allocation[];
  appliedMinor: number;
  /** Receipt left over after every open item is settled (overpayment). */
  unappliedMinor: number;
}

/**
 * Allocate a cash receipt across open items. `oldest` (default) applies to the
 * earliest due date first; `largest` to the biggest balance first; `as-is`
 * preserves input order. Integer-exact: applied + unapplied === receiptMinor.
 */
export function applyReceipt(
  items: OpenItem[],
  receiptMinor: number,
  order: 'oldest' | 'largest' | 'as-is' = 'oldest',
): ReceiptApplication {
  if (!Number.isInteger(receiptMinor) || receiptMinor < 0) {
    throw new RangeError(`receiptMinor must be a non-negative integer, got ${receiptMinor}`);
  }
  const ordered = [...items];
  if (order === 'oldest') {
    ordered.sort((a, b) => {
      const da = a.dueDate ? epochDay(a.dueDate) : Number.POSITIVE_INFINITY;
      const db = b.dueDate ? epochDay(b.dueDate) : Number.POSITIVE_INFINITY;
      return da - db;
    });
  } else if (order === 'largest') {
    ordered.sort((a, b) => b.outstandingMinor - a.outstandingMinor);
  }

  let remaining = receiptMinor;
  const allocations: Allocation[] = [];
  for (const it of ordered) {
    const due = Math.max(0, it.outstandingMinor);
    const applied = Math.min(remaining, due);
    remaining -= applied;
    const rem = due - applied;
    allocations.push({ ref: it.ref, appliedMinor: applied, remainingMinor: rem, fullyPaid: rem === 0 && due > 0 });
  }
  return { allocations, appliedMinor: receiptMinor - remaining, unappliedMinor: remaining };
}

/** Resolve an invoice status from its settled/outstanding position and due date. */
export function invoiceStatus(
  amountMinor: number,
  settledMinor: number,
  dueDate: string | undefined,
  asOf: string,
): 'SETTLED' | 'PART_PAID' | 'OVERDUE' | 'OPEN' {
  if (settledMinor >= amountMinor) return 'SETTLED';
  if (dueDate && epochDay(asOf) > epochDay(dueDate)) return 'OVERDUE';
  if (settledMinor > 0) return 'PART_PAID';
  return 'OPEN';
}
