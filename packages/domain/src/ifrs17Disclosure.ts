/**
 * IFRS 17 movement analysis (disclosure reporting) - report gap 5.7.
 *
 * Builds the liability roll-forward disclosure table an IFRS 17 note requires:
 * opening balance -> premiums received -> insurance revenue -> claims/expenses
 * incurred and paid -> finance expense -> closing balance, split by LRC
 * (liability for remaining coverage, excl./incl. loss component) and LIC
 * (liability for incurred claims). Pure, integer-exact; the caller supplies the
 * period movements from the measurement engine and the books.
 */

export interface Ifrs17Movements {
  /** Premiums received in the period (increases LRC). */
  premiumsReceivedMinor: number;
  /** Insurance revenue recognised (releases LRC). */
  insuranceRevenueMinor: number;
  /** Insurance acquisition cash flows amortised/paid (reduces LRC). */
  acquisitionCashFlowsMinor?: number;
  /** Loss component recognised (onerous) in the period. */
  lossComponentRecognisedMinor?: number;
  /** Loss component reversed/used in the period. */
  lossComponentReversedMinor?: number;
  /** Claims & expenses incurred in the period (increases LIC). */
  claimsIncurredMinor: number;
  /** Claims & expenses paid in the period (decreases LIC). */
  claimsPaidMinor: number;
  /** Insurance finance expense on LRC (discount unwind). */
  financeExpenseLrcMinor?: number;
  /** Insurance finance expense on LIC (discount unwind). */
  financeExpenseLicMinor?: number;
}

export interface RollforwardColumn {
  opening: number;
  increases: { label: string; amountMinor: number }[];
  decreases: { label: string; amountMinor: number }[];
  closing: number;
}

export interface Ifrs17Rollforward {
  lrcExclLoss: RollforwardColumn;
  lossComponent: RollforwardColumn;
  lic: RollforwardColumn;
  /** Total insurance contract liability opening/closing. */
  totalOpening: number;
  totalClosing: number;
  /** P&L view for the note: revenue, service expense, finance expense, result. */
  insuranceRevenueMinor: number;
  insuranceServiceExpenseMinor: number;
  insuranceFinanceExpenseMinor: number;
  insuranceServiceResultMinor: number;
}

function col(opening: number, incs: { label: string; amountMinor: number }[], decs: { label: string; amountMinor: number }[]): RollforwardColumn {
  const up = incs.reduce((a, x) => a + x.amountMinor, 0);
  const down = decs.reduce((a, x) => a + x.amountMinor, 0);
  return { opening, increases: incs, decreases: decs, closing: opening + up - down };
}

/**
 * Assemble the IFRS 17 liability roll-forward from opening balances and period
 * movements. Identity: totalClosing = totalOpening + all increases - all
 * decreases across the three columns; the note's insurance service result is
 * revenue - service expense (incurred claims + loss-component recognition net
 * of reversals + acquisition amortisation).
 */
export function ifrs17Rollforward(
  opening: { lrcExclLossMinor: number; lossComponentMinor: number; licMinor: number },
  m: Ifrs17Movements,
): Ifrs17Rollforward {
  const acq = m.acquisitionCashFlowsMinor ?? 0;
  const lossRec = m.lossComponentRecognisedMinor ?? 0;
  const lossRev = m.lossComponentReversedMinor ?? 0;
  const finLrc = m.financeExpenseLrcMinor ?? 0;
  const finLic = m.financeExpenseLicMinor ?? 0;

  const lrcExclLoss = col(
    opening.lrcExclLossMinor,
    [
      { label: 'Premiums received', amountMinor: m.premiumsReceivedMinor },
      ...(finLrc ? [{ label: 'Insurance finance expense', amountMinor: finLrc }] : []),
    ],
    [
      { label: 'Insurance revenue', amountMinor: m.insuranceRevenueMinor },
      ...(acq ? [{ label: 'Acquisition cash flows', amountMinor: acq }] : []),
    ],
  );

  const lossComponent = col(
    opening.lossComponentMinor,
    lossRec ? [{ label: 'Losses on onerous contracts', amountMinor: lossRec }] : [],
    lossRev ? [{ label: 'Reversal of loss component', amountMinor: lossRev }] : [],
  );

  const lic = col(
    opening.licMinor,
    [
      { label: 'Claims and expenses incurred', amountMinor: m.claimsIncurredMinor },
      ...(finLic ? [{ label: 'Insurance finance expense', amountMinor: finLic }] : []),
    ],
    [{ label: 'Claims and expenses paid', amountMinor: m.claimsPaidMinor }],
  );

  const totalOpening = opening.lrcExclLossMinor + opening.lossComponentMinor + opening.licMinor;
  const totalClosing = lrcExclLoss.closing + lossComponent.closing + lic.closing;

  const serviceExpense = m.claimsIncurredMinor + lossRec - lossRev + acq;
  return {
    lrcExclLoss,
    lossComponent,
    lic,
    totalOpening,
    totalClosing,
    insuranceRevenueMinor: m.insuranceRevenueMinor,
    insuranceServiceExpenseMinor: serviceExpense,
    insuranceFinanceExpenseMinor: finLrc + finLic,
    insuranceServiceResultMinor: m.insuranceRevenueMinor - serviceExpense,
  };
}
