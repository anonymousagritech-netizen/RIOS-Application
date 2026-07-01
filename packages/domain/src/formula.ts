/**
 * Formula Engine (brief - Formula Engine & Calculation Framework).
 *
 * A safe, dependency-free expression evaluator plus a formula model that carries
 * named intermediate *terms*, so every computed value comes with a transparent
 * step-by-step breakdown (e.g. Technical Premium = Expected Loss + Expense Load
 * + Brokerage + ...). Formulas are data (variables, constants, functions,
 * conditional logic, versioning and effective dates), not hard-coded, so
 * actuarial/finance teams can change business logic without a redeploy.
 *
 * The evaluator supports:
 *   - arithmetic  + - * / %  and unary minus, parentheses
 *   - comparison  < > <= >= == !=   and logical  && || !   (booleans are 1/0)
 *   - ternary     cond ? a : b
 *   - functions   min max round ceil floor abs sqrt pow if clamp pct
 * Only whitelisted identifiers (context variables) and functions are allowed;
 * there is no access to globals, so evaluating tenant-authored formulas is safe.
 */

export type FieldStatus = 'SYSTEM' | 'OVERRIDE' | 'IMPORTED' | 'MANUAL';

// --------------------------------------------------------------------------- lexer
type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const ops = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '(', ')', ',', '<', '>', '!', '?', ':'];
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9._]/.test(src[j]!)) j++;
      const num = Number(src.slice(i, j).replace(/_/g, ''));
      if (!Number.isFinite(num)) throw new SyntaxError(`Bad number near ${src.slice(i, j)}`);
      toks.push({ t: 'num', v: num }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (ops.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (ops.includes(c)) { toks.push({ t: 'op', v: c }); i += 1; continue; }
    throw new SyntaxError(`Unexpected character '${c}' in expression`);
  }
  return toks;
}

// --------------------------------------------------------------------------- functions
const FUNCS: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  round: (a) => Math.round(a[0]!),
  ceil: (a) => Math.ceil(a[0]!),
  floor: (a) => Math.floor(a[0]!),
  abs: (a) => Math.abs(a[0]!),
  sqrt: (a) => Math.sqrt(a[0]!),
  pow: (a) => Math.pow(a[0]!, a[1]!),
  if: (a) => (a[0] !== 0 ? a[1]! : a[2]!),
  clamp: (a) => Math.min(Math.max(a[0]!, a[1]!), a[2]!),
  pct: (a) => (a[0]! * a[1]!) / 100,
};

export const FUNCTION_NAMES = Object.keys(FUNCS);

// --------------------------------------------------------------------------- parser (recursive descent)
class Parser {
  private p = 0;
  constructor(private toks: Tok[], private ctx: Record<string, number>) {}

  parse(): number {
    const v = this.ternary();
    if (this.p < this.toks.length) throw new SyntaxError('Unexpected trailing tokens in expression');
    return v;
  }
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private eatOp(v: string): boolean { const t = this.peek(); if (t && t.t === 'op' && t.v === v) { this.p++; return true; } return false; }
  private expect(v: string): void { if (!this.eatOp(v)) throw new SyntaxError(`Expected '${v}'`); }

  private ternary(): number {
    const cond = this.logicalOr();
    if (this.eatOp('?')) {
      const a = this.ternary(); this.expect(':'); const b = this.ternary();
      return cond !== 0 ? a : b;
    }
    return cond;
  }
  private logicalOr(): number { let v = this.logicalAnd(); while (this.eatOp('||')) { const r = this.logicalAnd(); v = (v !== 0 || r !== 0) ? 1 : 0; } return v; }
  private logicalAnd(): number { let v = this.equality(); while (this.eatOp('&&')) { const r = this.equality(); v = (v !== 0 && r !== 0) ? 1 : 0; } return v; }
  private equality(): number {
    let v = this.comparison();
    for (;;) { if (this.eatOp('==')) v = v === this.comparison() ? 1 : 0; else if (this.eatOp('!=')) v = v !== this.comparison() ? 1 : 0; else break; }
    return v;
  }
  private comparison(): number {
    let v = this.additive();
    for (;;) {
      if (this.eatOp('<=')) v = v <= this.additive() ? 1 : 0;
      else if (this.eatOp('>=')) v = v >= this.additive() ? 1 : 0;
      else if (this.eatOp('<')) v = v < this.additive() ? 1 : 0;
      else if (this.eatOp('>')) v = v > this.additive() ? 1 : 0;
      else break;
    }
    return v;
  }
  private additive(): number {
    let v = this.multiplicative();
    for (;;) { if (this.eatOp('+')) v += this.multiplicative(); else if (this.eatOp('-')) v -= this.multiplicative(); else break; }
    return v;
  }
  private multiplicative(): number {
    let v = this.unary();
    for (;;) {
      if (this.eatOp('*')) v *= this.unary();
      else if (this.eatOp('/')) { const d = this.unary(); if (d === 0) throw new RangeError('Division by zero'); v /= d; }
      else if (this.eatOp('%')) { const d = this.unary(); if (d === 0) throw new RangeError('Modulo by zero'); v %= d; }
      else break;
    }
    return v;
  }
  private unary(): number {
    if (this.eatOp('-')) return -this.unary();
    if (this.eatOp('!')) return this.unary() === 0 ? 1 : 0;
    return this.primary();
  }
  private primary(): number {
    const t = this.peek();
    if (!t) throw new SyntaxError('Unexpected end of expression');
    if (t.t === 'num') { this.p++; return t.v; }
    if (t.t === 'op' && t.v === '(') { this.p++; const v = this.ternary(); this.expect(')'); return v; }
    if (t.t === 'id') {
      this.p++;
      // function call?
      if (this.peek() && this.peek()!.t === 'op' && this.peek()!.v === '(') {
        this.p++;
        const args: number[] = [];
        if (!(this.peek() && this.peek()!.t === 'op' && (this.peek() as Tok & { t: 'op' }).v === ')')) {
          args.push(this.ternary());
          while (this.eatOp(',')) args.push(this.ternary());
        }
        this.expect(')');
        const fn = FUNCS[t.v];
        if (!fn) throw new SyntaxError(`Unknown function '${t.v}'`);
        return fn(args);
      }
      // Use hasOwn (not `in`) so inherited props (constructor, __proto__, ...) are rejected.
      if (!Object.prototype.hasOwnProperty.call(this.ctx, t.v)) throw new SyntaxError(`Unknown variable '${t.v}'`);
      const val = this.ctx[t.v]!;
      if (!Number.isFinite(val)) throw new RangeError(`Variable '${t.v}' is not a finite number`);
      return val;
    }
    throw new SyntaxError(`Unexpected token '${(t as { v: unknown }).v}'`);
  }
}

/** Evaluate a single expression against a variable context. Throws on bad syntax / unknown vars. */
export function evaluate(expression: string, context: Record<string, number> = {}): number {
  return new Parser(tokenize(expression), context).parse();
}

/** Static-analyse an expression: the identifiers it reads that are not functions. */
export function referencedVariables(expression: string): string[] {
  const out = new Set<string>();
  const toks = tokenize(expression);
  toks.forEach((t, i) => {
    if (t.t === 'id' && !FUNCS[t.v]) {
      const next = toks[i + 1];
      if (!(next && next.t === 'op' && next.v === '(')) out.add(t.v);
    }
  });
  return [...out];
}

/** Validate a formula definition compiles and only references known inputs/terms. */
export function validateFormula(def: FormulaDefinition): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const known = new Set<string>([...def.inputs, ...Object.keys(def.constants ?? {})]);
  for (const term of def.terms ?? []) {
    try {
      for (const v of referencedVariables(term.expr)) {
        if (!known.has(v)) errors.push(`Term '${term.name}' references unknown variable '${v}'`);
      }
      tokenize(term.expr);
    } catch (e) {
      errors.push(`Term '${term.name}': ${(e as Error).message}`);
    }
    known.add(term.name);
  }
  try {
    for (const v of referencedVariables(def.result)) {
      if (!known.has(v)) errors.push(`Result references unknown variable '${v}'`);
    }
  } catch (e) {
    errors.push(`Result: ${(e as Error).message}`);
  }
  return { ok: errors.length === 0, errors };
}

// --------------------------------------------------------------------------- formula model
export interface FormulaTerm {
  name: string;
  label?: string;
  expr: string;
}

export interface FormulaDefinition {
  key: string;
  name: string;
  category?: string;
  version: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  /** Expected input variable names. */
  inputs: string[];
  /** Named constants available to every term/result. */
  constants?: Record<string, number>;
  /** Ordered intermediate terms; each may reference inputs, constants and prior terms. */
  terms: FormulaTerm[];
  /** Final expression, referencing inputs / constants / terms. */
  result: string;
  resultLabel?: string;
}

export interface BreakdownStep {
  name: string;
  label: string;
  value: number;
}

export interface FormulaResult {
  key: string;
  value: number;
  steps: BreakdownStep[];
  version: number;
}

/**
 * Compute a formula against a set of inputs, returning the final value plus the
 * ordered breakdown of every named term - the data behind a "View Calculation".
 */
export function computeFormula(def: FormulaDefinition, inputs: Record<string, number>): FormulaResult {
  const ctx: Record<string, number> = { ...(def.constants ?? {}), ...inputs };
  const steps: BreakdownStep[] = [];
  for (const term of def.terms ?? []) {
    const value = evaluate(term.expr, ctx);
    ctx[term.name] = value;
    steps.push({ name: term.name, label: term.label ?? term.name, value });
  }
  const value = evaluate(def.result, ctx);
  return { key: def.key, value, steps, version: def.version };
}

// --------------------------------------------------------------------------- field status / override
export interface OverrideInput {
  systemValue: number;
  overrideValue?: number | null;
  imported?: boolean;
  manual?: boolean;
}

export interface ResolvedField {
  value: number;
  status: FieldStatus;
  systemValue: number;
  overridden: boolean;
}

/**
 * Resolve the effective value and status of a field. An authorised override wins
 * over the system value; otherwise the value is system-calculated (or flagged as
 * imported / manually entered). The system value is always retained so it can be
 * restored.
 */
export function resolveField(input: OverrideInput): ResolvedField {
  if (input.overrideValue != null) {
    return { value: input.overrideValue, status: 'OVERRIDE', systemValue: input.systemValue, overridden: true };
  }
  const status: FieldStatus = input.manual ? 'MANUAL' : input.imported ? 'IMPORTED' : 'SYSTEM';
  return { value: input.systemValue, status, systemValue: input.systemValue, overridden: false };
}

// --------------------------------------------------------------------------- explanation (AI Formula Assistant)
export interface ExplanationLine {
  label: string;
  value: number;
  formatted: string;
}

export interface FormulaExplanation {
  title: string;
  lines: ExplanationLine[];
  total: ExplanationLine;
  narrative: string;
}

/**
 * Deterministic, grounded explanation of a computed formula - the "AI Formula
 * Assistant" without a black box. It composes the breakdown steps and the final
 * value into a titled line list and a plain-language narrative, so a user can
 * see exactly how the number was derived. `format` turns a raw number into a
 * display string (e.g. money from minor units); it defaults to a plain number.
 */
export function explainFormula(
  def: FormulaDefinition,
  result: FormulaResult,
  format: (n: number) => string = (n) => String(n),
): FormulaExplanation {
  const title = def.resultLabel ?? def.name;
  const lines: ExplanationLine[] = result.steps.map((s) => ({ label: s.label, value: s.value, formatted: format(s.value) }));
  const total: ExplanationLine = { label: title, value: result.value, formatted: format(result.value) };
  const parts = lines.length
    ? lines.map((l) => `${l.label} ${l.formatted}`).join(', ')
    : 'the supplied inputs';
  const narrative = `${title} is ${total.formatted}, derived from ${parts} (formula "${def.key}" v${result.version}).`;
  return { title, lines, total, narrative };
}

// --------------------------------------------------------------------------- field-type governance
/**
 * The three governance classes for a numeric field:
 *  - INPUT      user-entered data (e.g. sum insured, rate, share) - freely editable
 *  - CALCULATED system-computed, but an authorised user may override with an audit trail
 *  - PROTECTED  always system-generated, never editable (audit timestamps, journal ids,
 *               posting references)
 */
export type FieldClass = 'INPUT' | 'CALCULATED' | 'PROTECTED';

export interface EditDecision {
  editable: boolean;
  /** True when editing is an override that must be logged with a reason. */
  requiresOverrideAudit: boolean;
  reason: string;
}

/**
 * Decide whether a field may be edited given its governance type and whether the
 * actor holds override authority. INPUT is always editable; CALCULATED is
 * editable only as an audited override by an authorised user; PROTECTED is never
 * editable. This is the governance the UI and API both enforce.
 */
export function canEditField(fieldClass: FieldClass, hasOverrideAuthority: boolean): EditDecision {
  if (fieldClass === 'INPUT') return { editable: true, requiresOverrideAudit: false, reason: 'Input field' };
  if (fieldClass === 'PROTECTED') return { editable: false, requiresOverrideAudit: false, reason: 'System-protected field' };
  // CALCULATED
  return hasOverrideAuthority
    ? { editable: true, requiresOverrideAudit: true, reason: 'Authorised override (audited)' }
    : { editable: false, requiresOverrideAudit: false, reason: 'Override authority required' };
}
