/**
 * Seed formula library - the reinsurance calculations expressed as data so they
 * can be edited, versioned and effective-dated without a redeploy. Each is a
 * FormulaDefinition consumed by `computeFormula`, which returns the value plus a
 * step-by-step breakdown. Rates are fractions (0.05 = 5%); money is minor units.
 */

import type { FormulaDefinition } from './formula.js';

export const DEFAULT_FORMULAS: FormulaDefinition[] = [
  {
    key: 'underwriting.technical_premium',
    name: 'Technical Premium',
    category: 'Underwriting',
    version: 1,
    effectiveFrom: '2026-01-01',
    inputs: ['sumInsured', 'rate', 'lossRatio', 'expenseRatio', 'brokerageRate', 'commissionRate', 'riskMarginRate', 'profitMarginRate', 'catLoadRate', 'taxRate'],
    terms: [
      { name: 'gross_premium', label: 'Gross Premium', expr: 'sumInsured * rate' },
      { name: 'expected_loss', label: 'Expected Loss', expr: 'gross_premium * lossRatio' },
      { name: 'expense_load', label: 'Expense Load', expr: 'gross_premium * expenseRatio' },
      { name: 'brokerage', label: 'Brokerage', expr: 'gross_premium * brokerageRate' },
      { name: 'commission', label: 'Commission', expr: 'gross_premium * commissionRate' },
      { name: 'risk_margin', label: 'Risk Margin', expr: 'expected_loss * riskMarginRate' },
      { name: 'profit_margin', label: 'Profit Margin', expr: 'gross_premium * profitMarginRate' },
      { name: 'cat_load', label: 'CAT Load', expr: 'gross_premium * catLoadRate' },
      { name: 'subtotal', label: 'Subtotal', expr: 'expected_loss + expense_load + brokerage + commission + risk_margin + profit_margin + cat_load' },
      { name: 'taxes', label: 'Taxes', expr: 'subtotal * taxRate' },
    ],
    result: 'round(subtotal + taxes)',
    resultLabel: 'Technical Premium',
  },
  {
    key: 'underwriting.loss_ratio',
    name: 'Loss Ratio',
    category: 'Underwriting',
    version: 1,
    inputs: ['incurredLoss', 'earnedPremium'],
    terms: [],
    result: 'if(earnedPremium > 0, round(incurredLoss / earnedPremium * 1000) / 10, 0)',
    resultLabel: 'Loss Ratio %',
  },
  {
    key: 'underwriting.combined_ratio',
    name: 'Combined Ratio',
    category: 'Underwriting',
    version: 1,
    inputs: ['lossRatioPct', 'expenseRatioPct', 'commissionRatioPct'],
    terms: [],
    result: 'round((lossRatioPct + expenseRatioPct + commissionRatioPct) * 10) / 10',
    resultLabel: 'Combined Ratio %',
  },
  {
    key: 'underwriting.capacity_utilization',
    name: 'Capacity Utilization',
    category: 'Underwriting',
    version: 1,
    inputs: ['consumed', 'available'],
    terms: [],
    result: 'if(available > 0, round(consumed / available * 1000) / 10, 0)',
    resultLabel: 'Utilisation %',
  },
  {
    key: 'treaty.ceded_premium',
    name: 'Ceded Premium',
    category: 'Treaty',
    version: 1,
    inputs: ['grossPremium', 'cessionRate'],
    terms: [{ name: 'ceded', label: 'Ceded Premium', expr: 'grossPremium * cessionRate' }],
    result: 'round(ceded)',
    resultLabel: 'Ceded Premium',
  },
  {
    key: 'treaty.deposit_premium',
    name: 'Deposit Premium',
    category: 'Treaty',
    version: 1,
    inputs: ['estimatedPremium', 'depositRate'],
    terms: [],
    result: 'round(estimatedPremium * depositRate)',
    resultLabel: 'Deposit Premium',
  },
  {
    key: 'treaty.profit_commission',
    name: 'Profit Commission',
    category: 'Treaty',
    version: 1,
    inputs: ['premium', 'claims', 'expenses', 'managementExpenseRate', 'profitCommissionRate'],
    terms: [
      { name: 'mgmt_expense', label: 'Management Expense', expr: 'premium * managementExpenseRate' },
      { name: 'profit', label: 'Profit', expr: 'premium - claims - expenses - mgmt_expense' },
    ],
    result: 'round(max(0, profit) * profitCommissionRate)',
    resultLabel: 'Profit Commission',
  },
  {
    key: 'claims.net_claim',
    name: 'Net Claim',
    category: 'Claims',
    version: 1,
    inputs: ['grossLoss', 'reinsuranceRecovery', 'salvage', 'subrogation'],
    terms: [{ name: 'recoveries', label: 'Total Recoveries', expr: 'reinsuranceRecovery + salvage + subrogation' }],
    result: 'max(0, grossLoss - recoveries)',
    resultLabel: 'Net Claim',
  },
  {
    key: 'claims.outstanding_reserve',
    name: 'Outstanding Reserve',
    category: 'Claims',
    version: 1,
    inputs: ['incurred', 'paid'],
    terms: [],
    result: 'max(0, incurred - paid)',
    resultLabel: 'Outstanding Reserve',
  },
];

export function getFormula(key: string, formulas: FormulaDefinition[] = DEFAULT_FORMULAS): FormulaDefinition | undefined {
  return formulas.find((f) => f.key === key);
}
