/**
 * Taxes & levies (brief §9 - premium taxes / FET / stamp duty / withholding).
 *
 * Reinsurance premiums attract a configurable stack of jurisdiction levies, each
 * a rate on a base. This module computes the stack deterministically over
 * integer minor units (each line rounded independently, then summed, so the
 * total always equals the sum of the displayed lines). Pure and unit-tested.
 */

export interface Levy {
  code: string;
  name?: string;
  /** Rate as a fraction, e.g. 0.05 = 5%. */
  rate: number;
  jurisdiction?: string;
}

export interface LevyLine {
  code: string;
  name?: string;
  rate: number;
  amountMinor: number;
}

export interface LevyResult {
  baseMinor: number;
  lines: LevyLine[];
  totalLevyMinor: number;
  /** base + total levies (premium shown tax-inclusive). */
  grossInclusiveMinor: number;
}

/**
 * Apply a stack of levies to a base amount. Each line is `round(base · rate)`;
 * the total is the sum of the rounded lines (not `round(base · Σrate)`), so the
 * lines and total reconcile exactly.
 */
export function computeLevies(baseMinor: number, levies: Levy[]): LevyResult {
  const lines: LevyLine[] = (levies ?? []).map((l) => ({
    code: l.code,
    name: l.name,
    rate: l.rate,
    amountMinor: Math.round(baseMinor * l.rate),
  }));
  const totalLevyMinor = lines.reduce((acc, l) => acc + l.amountMinor, 0);
  return { baseMinor, lines, totalLevyMinor, grossInclusiveMinor: baseMinor + totalLevyMinor };
}

/**
 * Withholding tax deducted at source from an amount payable to a counterparty:
 * returns the tax withheld and the net remitted. `round(gross · rate)` withheld.
 */
export function withholdingTax(grossMinor: number, rate: number): { taxMinor: number; netMinor: number } {
  const taxMinor = Math.round(grossMinor * Math.max(0, rate));
  return { taxMinor, netMinor: grossMinor - taxMinor };
}
