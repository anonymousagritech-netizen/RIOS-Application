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
  /** When true this levy is charged on the base plus all prior levy lines (cascading). */
  compound?: boolean;
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
  const lines: LevyLine[] = [];
  let accumulated = 0;
  for (const l of levies ?? []) {
    // Cascading levies (e.g. stamp duty on a tax-inclusive amount) charge on the
    // base plus prior lines; the default charges each levy on the base alone.
    const chargeBase = l.compound ? baseMinor + accumulated : baseMinor;
    const amountMinor = Math.round(chargeBase * l.rate);
    lines.push({ code: l.code, name: l.name, rate: l.rate, amountMinor });
    accumulated += amountMinor;
  }
  return { baseMinor, lines, totalLevyMinor: accumulated, grossInclusiveMinor: baseMinor + accumulated };
}

export interface FetInput {
  /** Reinsurance premium ceded to a foreign reinsurer. */
  premiumMinor: number;
  /** FET rate as a fraction; US default is 1% on reinsurance premiums. */
  ratePct?: number;
  /** Portion of the premium exempt under an income-tax treaty (0..1), e.g. 1 = fully waived. */
  treatyExemptFraction?: number;
}

export interface FetResult {
  taxableMinor: number;
  fetMinor: number;
}

/**
 * US Federal Excise Tax on reinsurance premiums ceded to a foreign reinsurer.
 * The taxable base is the premium net of any income-tax-treaty exemption; FET is
 * `round(taxable x rate)` (default 1% for reinsurance). Cascading FET on further
 * foreign retrocession is handled by applying this per cession.
 */
export function federalExciseTax(input: FetInput): FetResult {
  const exempt = Math.min(1, Math.max(0, input.treatyExemptFraction ?? 0));
  const rate = (input.ratePct ?? 1) / 100;
  const taxableMinor = Math.round(input.premiumMinor * (1 - exempt));
  return { taxableMinor, fetMinor: Math.round(taxableMinor * rate) };
}

/**
 * Gross up a net amount for a tax deducted at source: find the gross such that
 * `net = gross - round(gross x rate)`. Returns the gross and the tax so that
 * gross - tax === net exactly.
 */
export function grossUp(netMinor: number, rate: number): { grossMinor: number; taxMinor: number } {
  const r = Math.max(0, Math.min(0.999999, rate));
  const grossMinor = Math.round(netMinor / (1 - r));
  const taxMinor = grossMinor - netMinor;
  return { grossMinor, taxMinor };
}

/**
 * Withholding tax deducted at source from an amount payable to a counterparty:
 * returns the tax withheld and the net remitted. `round(gross · rate)` withheld.
 */
export function withholdingTax(grossMinor: number, rate: number): { taxMinor: number; netMinor: number } {
  const taxMinor = Math.round(grossMinor * Math.max(0, rate));
  return { taxMinor, netMinor: grossMinor - taxMinor };
}
