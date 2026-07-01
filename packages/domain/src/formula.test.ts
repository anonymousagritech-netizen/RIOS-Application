import { describe, it, expect } from 'vitest';
import {
  evaluate, computeFormula, referencedVariables, validateFormula, resolveField,
  type FormulaDefinition,
} from './formula.js';
import { DEFAULT_FORMULAS, getFormula } from './formulaLibrary.js';

describe('formula.evaluate', () => {
  it('evaluates arithmetic with precedence and parentheses', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('(2 + 3) * 4')).toBe(20);
    expect(evaluate('-5 + 10')).toBe(5);
    expect(evaluate('10 % 3')).toBe(1);
  });

  it('reads variables from context and supports functions', () => {
    expect(evaluate('a * b', { a: 6, b: 7 })).toBe(42);
    expect(evaluate('round(a / b * 100)', { a: 1, b: 3 })).toBe(33);
    expect(evaluate('min(a, b, 5)', { a: 8, b: 2 })).toBe(2);
    expect(evaluate('clamp(x, 0, 100)', { x: 150 })).toBe(100);
    expect(evaluate('pct(200, 10)')).toBe(20);
  });

  it('handles comparison, logical and ternary (booleans as 1/0)', () => {
    expect(evaluate('a > b ? 1 : 0', { a: 5, b: 3 })).toBe(1);
    expect(evaluate('if(x > 0, x, 0)', { x: -4 })).toBe(0);
    expect(evaluate('a >= 10 && b < 5', { a: 10, b: 2 })).toBe(1);
  });

  it('throws on unknown variables, bad syntax and division by zero', () => {
    expect(() => evaluate('a + z', { a: 1 })).toThrow(/Unknown variable 'z'/);
    expect(() => evaluate('2 +')).toThrow();
    expect(() => evaluate('1 / 0')).toThrow(/Division by zero/);
    expect(() => evaluate('badfn(1)')).toThrow(/Unknown function/);
  });

  it('does not expose globals or allow injection', () => {
    expect(() => evaluate('constructor')).toThrow(/Unknown variable/);
    expect(() => evaluate('process')).toThrow(/Unknown variable/);
  });
});

describe('formula.referencedVariables', () => {
  it('lists read variables but not function names', () => {
    expect(referencedVariables('round(a * b) + c').sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('formula.computeFormula', () => {
  it('returns the value and an ordered breakdown of terms', () => {
    const def: FormulaDefinition = {
      key: 'demo', name: 'Demo', version: 1,
      inputs: ['loss', 'expense'],
      terms: [
        { name: 'a', label: 'Expected Loss', expr: 'loss' },
        { name: 'b', label: 'Expense Load', expr: 'expense' },
      ],
      result: 'a + b',
    };
    const r = computeFormula(def, { loss: 1_200_000, expense: 150_000 });
    expect(r.value).toBe(1_350_000);
    expect(r.steps).toEqual([
      { name: 'a', label: 'Expected Loss', value: 1_200_000 },
      { name: 'b', label: 'Expense Load', value: 150_000 },
    ]);
  });

  it('computes the seeded Technical Premium with a full breakdown', () => {
    const def = getFormula('underwriting.technical_premium')!;
    const r = computeFormula(def, {
      sumInsured: 100_000_000, rate: 0.02, lossRatio: 0.6, expenseRatio: 0.075,
      brokerageRate: 0.05, commissionRate: 0.125, riskMarginRate: 0.0833,
      profitMarginRate: 0.025, catLoadRate: 0.04, taxRate: 0,
    });
    // gross_premium = 2,000,000; each component derives from it; result is positive and rounded.
    const gross = r.steps.find((s) => s.name === 'gross_premium')!;
    expect(gross.value).toBe(2_000_000);
    expect(r.value).toBeGreaterThan(0);
    expect(Number.isInteger(r.value)).toBe(true);
    // subtotal equals the sum of the component steps
    const comps = ['expected_loss', 'expense_load', 'brokerage', 'commission', 'risk_margin', 'profit_margin', 'cat_load'];
    const sum = comps.reduce((a, n) => a + r.steps.find((s) => s.name === n)!.value, 0);
    expect(r.steps.find((s) => s.name === 'subtotal')!.value).toBeCloseTo(sum, 6);
  });

  it('every seeded formula validates and computes', () => {
    for (const def of DEFAULT_FORMULAS) {
      expect(validateFormula(def).ok, `${def.key} should validate`).toBe(true);
    }
    expect(computeFormula(getFormula('claims.net_claim')!, { grossLoss: 1000, reinsuranceRecovery: 300, salvage: 50, subrogation: 100 }).value).toBe(550);
    expect(computeFormula(getFormula('underwriting.loss_ratio')!, { incurredLoss: 600, earnedPremium: 1000 }).value).toBe(60);
  });
});

describe('formula.validateFormula', () => {
  it('flags references to unknown variables', () => {
    const bad: FormulaDefinition = { key: 'x', name: 'x', version: 1, inputs: ['a'], terms: [{ name: 't', expr: 'a + missing' }], result: 't' };
    const v = validateFormula(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/unknown variable 'missing'/);
  });
});

describe('formula.resolveField (status model)', () => {
  it('returns SYSTEM by default and keeps the system value', () => {
    expect(resolveField({ systemValue: 100 })).toEqual({ value: 100, status: 'SYSTEM', systemValue: 100, overridden: false });
  });
  it('an override wins and is flagged, retaining the system value for restore', () => {
    expect(resolveField({ systemValue: 100, overrideValue: 120 })).toEqual({ value: 120, status: 'OVERRIDE', systemValue: 100, overridden: true });
  });
  it('flags imported and manual entry', () => {
    expect(resolveField({ systemValue: 0, imported: true }).status).toBe('IMPORTED');
    expect(resolveField({ systemValue: 0, manual: true }).status).toBe('MANUAL');
  });
});

describe('formula.explainFormula (AI Formula Assistant)', () => {
  it('composes a grounded narrative and line list from the breakdown', async () => {
    const { explainFormula, computeFormula } = await import('./formula.js');
    const { getFormula } = await import('./formulaLibrary.js');
    const def = getFormula('claims.net_claim')!;
    const res = computeFormula(def, { grossLoss: 1000, reinsuranceRecovery: 300, salvage: 50, subrogation: 100 });
    const ex = explainFormula(def, res, (n) => `$${n}`);
    expect(ex.title).toBe('Net Claim');
    expect(ex.total.formatted).toBe('$550');
    expect(ex.lines[0]).toEqual({ label: 'Total Recoveries', value: 450, formatted: '$450' });
    expect(ex.narrative).toContain('Net Claim is $550');
    expect(ex.narrative).toContain('claims.net_claim');
  });
});
