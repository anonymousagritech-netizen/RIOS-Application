/**
 * Payroll calculation (brief §9.14 Payroll).
 *
 * Gross-to-net for a single pay period: earnings build to gross, progressive
 * income tax and social contributions are withheld, and net pay is derived.
 * Employer on-costs are computed separately. Pure and explainable - tax bands
 * and rates are inputs (configurable per jurisdiction, §10), never hard-coded.
 */

import { Money, money, zero, add, subtract, multiply, sum } from './money.js';

export interface PayComponent {
  code: string;
  /** Positive for earnings/allowances. */
  amount: Money;
  /** Whether this earning is subject to income tax / social contributions. */
  taxable?: boolean;
}

export interface TaxBand {
  /** Lower bound of the band in major-unit-equivalent minor units (annualised or per-period - caller chooses consistently). */
  from: number;
  /** Marginal rate as a fraction (e.g. 0.20 for 20%). */
  rate: number;
}

export interface PayrollInput {
  baseSalary: Money;
  earnings?: PayComponent[];
  /** Pre-tax deductions (e.g. pension), reduce taxable pay. */
  preTaxDeductions?: PayComponent[];
  /** Post-tax deductions (e.g. loan repayment), reduce net only. */
  postTaxDeductions?: PayComponent[];
  /** Progressive income-tax bands applied to taxable pay (ordered ascending by `from`). */
  taxBands: TaxBand[];
  /** Employee social-contribution rate as a fraction of taxable pay. */
  employeeSocialRate: number;
  /** Employer social-contribution rate as a fraction of gross (an on-cost, not withheld). */
  employerSocialRate: number;
}

export interface PayslipResult {
  gross: Money;
  taxablePay: Money;
  incomeTax: Money;
  employeeSocial: Money;
  totalPreTaxDeductions: Money;
  totalPostTaxDeductions: Money;
  net: Money;
  employerSocial: Money;
  /** Total cost to employer = gross + employer on-costs. */
  employerCost: Money;
}

/** Progressive income tax over the bands. Bands are marginal: each slice taxed at its rate. */
export function progressiveTax(taxable: Money, bands: TaxBand[]): Money {
  const currency = taxable.currency;
  if (taxable.amount <= 0 || bands.length === 0) return zero(currency);
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  let taxMinor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i]!;
    const next = sorted[i + 1];
    const lower = band.from;
    if (taxable.amount <= lower) break;
    const upper = next ? next.from : Number.POSITIVE_INFINITY;
    const sliceTop = Math.min(taxable.amount, upper);
    const slice = Math.max(0, sliceTop - lower);
    taxMinor += slice * band.rate;
  }
  return money(Math.round(taxMinor), currency);
}

export function runPayslip(input: PayrollInput): PayslipResult {
  const currency = input.baseSalary.currency;
  const earnings = input.earnings ?? [];
  const preTax = input.preTaxDeductions ?? [];
  const postTax = input.postTaxDeductions ?? [];

  const gross = add(input.baseSalary, sum(earnings.map((e) => e.amount), currency));

  // Taxable pay = base + taxable earnings − pre-tax deductions.
  const taxableEarnings = sum(
    earnings.filter((e) => e.taxable !== false).map((e) => e.amount),
    currency,
  );
  const totalPreTax = sum(preTax.map((d) => d.amount), currency);
  const taxablePay = subtract(add(input.baseSalary, taxableEarnings), totalPreTax);

  const incomeTax = progressiveTax(taxablePay, input.taxBands);
  const employeeSocial = multiply(taxablePay, input.employeeSocialRate);
  const totalPostTax = sum(postTax.map((d) => d.amount), currency);

  const net = subtract(
    subtract(subtract(subtract(gross, totalPreTax), incomeTax), employeeSocial),
    totalPostTax,
  );

  const employerSocial = multiply(gross, input.employerSocialRate);

  return {
    gross,
    taxablePay,
    incomeTax,
    employeeSocial,
    totalPreTaxDeductions: totalPreTax,
    totalPostTaxDeductions: totalPostTax,
    net,
    employerSocial,
    employerCost: add(gross, employerSocial),
  };
}

/** Convenience: total employer cost and net across a workforce (e.g. a payroll run). */
export function payrollRunTotals(payslips: PayslipResult[], currency: string): {
  totalGross: Money;
  totalNet: Money;
  totalTax: Money;
  totalEmployerCost: Money;
  headcount: number;
} {
  return {
    totalGross: sum(payslips.map((p) => p.gross), currency),
    totalNet: sum(payslips.map((p) => p.net), currency),
    totalTax: sum(payslips.map((p) => p.incomeTax), currency),
    totalEmployerCost: sum(payslips.map((p) => p.employerCost), currency),
    headcount: payslips.length,
  };
}
