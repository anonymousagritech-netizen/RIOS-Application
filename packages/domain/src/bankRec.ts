/**
 * Bank reconciliation (brief §9.8).
 *
 * Match bank-statement lines against the book (ledger cash) lines and surface
 * the timing differences - deposits in transit / outstanding cheques (in the
 * book, not yet on the bank) and bank-only items (interest, charges not yet in
 * the book). Proves the reconciliation identity:
 *   bank balance + unmatched book items === book balance + unmatched bank items.
 * Pure, integer-exact; amounts are signed (positive = money in, negative = out).
 */

export interface BankLine {
  id: string;
  amountMinor: number;
  /** ISO date (YYYY-MM-DD), optional. */
  date?: string;
  reference?: string;
}

export interface BankRecInput {
  /** Cash balance per the ledger. */
  bookBalanceMinor: number;
  /** Closing balance per the bank statement. */
  bankBalanceMinor: number;
  bookLines: BankLine[];
  bankLines: BankLine[];
  /** Max days between a book and bank line to still match on date (default 5). */
  dateToleranceDays?: number;
}

export interface RecMatch {
  bookId: string;
  bankId: string;
  amountMinor: number;
}

export interface BankRecResult {
  matches: RecMatch[];
  /** Book entries not on the bank yet (deposits in transit / outstanding cheques). */
  unmatchedBook: BankLine[];
  /** Bank entries not in the book yet (interest, charges). */
  unmatchedBank: BankLine[];
  /** adjustedBank - adjustedBook; zero when reconciled. */
  differenceMinor: number;
  reconciled: boolean;
}

function daysBetween(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.abs(da - db) / 86_400_000;
}

/**
 * Reconcile a book cash ledger against a bank statement. Lines match when the
 * amounts are equal and (when both carry a reference) the references agree and
 * (when both carry a date) the dates are within the tolerance. Matching is
 * greedy one-to-one, preferring a reference match.
 */
export function reconcileBank(input: BankRecInput): BankRecResult {
  const tol = input.dateToleranceDays ?? 5;
  const usedBank = new Set<number>();
  const matches: RecMatch[] = [];
  const matchedBook = new Set<string>();

  const find = (book: BankLine, requireRef: boolean): number => {
    for (let j = 0; j < input.bankLines.length; j++) {
      if (usedBank.has(j)) continue;
      const bank = input.bankLines[j]!;
      if (bank.amountMinor !== book.amountMinor) continue;
      const bothRef = book.reference != null && bank.reference != null;
      if (requireRef && !(bothRef && book.reference === bank.reference)) continue;
      if (!requireRef) {
        if (bothRef && book.reference !== bank.reference) continue;
        const d = daysBetween(book.date, bank.date);
        if (d != null && d > tol) continue;
      }
      return j;
    }
    return -1;
  };

  // Pass 1: reference-confirmed matches. Pass 2: amount + date-tolerance matches.
  for (const requireRef of [true, false]) {
    for (const book of input.bookLines) {
      if (matchedBook.has(book.id)) continue;
      const j = find(book, requireRef);
      if (j >= 0) {
        matches.push({ bookId: book.id, bankId: input.bankLines[j]!.id, amountMinor: book.amountMinor });
        usedBank.add(j);
        matchedBook.add(book.id);
      }
    }
  }

  const unmatchedBook = input.bookLines.filter((l) => !matchedBook.has(l.id));
  const unmatchedBank = input.bankLines.filter((_, j) => !usedBank.has(j));
  const sum = (ls: BankLine[]) => ls.reduce((a, l) => a + l.amountMinor, 0);

  const adjustedBank = input.bankBalanceMinor + sum(unmatchedBook);
  const adjustedBook = input.bookBalanceMinor + sum(unmatchedBank);
  const differenceMinor = adjustedBank - adjustedBook;

  return { matches, unmatchedBook, unmatchedBank, differenceMinor, reconciled: differenceMinor === 0 };
}
