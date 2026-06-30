/**
 * Business rules engine (brief §10.3 - metadata-driven decisioning).
 *
 * A rule set is metadata (a config document of `kind: 'rule'`): an ordered list
 * of rules, each a boolean condition over a flat context object plus the effects
 * to emit when it matches. This is the *pure* evaluator - a small, safe
 * expression interpreter (NOT JavaScript `eval`) so untrusted, user-authored
 * rules can never execute arbitrary code. The server loads the definition,
 * builds a context from the entity, evaluates, and acts on the effects
 * (validation errors, field defaults, routing, flags).
 */

export type Comparator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'exists' | 'empty';

export interface Condition {
  /** Dot-path into the context, e.g. 'contract.premiumMinor'. */
  field: string;
  op: Comparator;
  value?: unknown;
}

export interface ConditionGroup {
  /** Combine the children with AND (all) or OR (any). */
  all?: Array<Condition | ConditionGroup>;
  any?: Array<Condition | ConditionGroup>;
  not?: Condition | ConditionGroup;
}

export type Predicate = Condition | ConditionGroup;

export interface RuleEffect {
  /** 'error' blocks, 'warn' advises, 'set' defaults a field, 'flag'/'route' annotate. */
  type: 'error' | 'warn' | 'set' | 'flag' | 'route';
  /** For 'set': the field to default. For 'route': the queue/target. */
  target?: string;
  /** For 'set': the value to assign. */
  value?: unknown;
  message?: string;
}

export interface Rule {
  id: string;
  name?: string;
  when: Predicate;
  then: RuleEffect[];
  /** Stop evaluating further rules once this one matches. */
  stop?: boolean;
  enabled?: boolean;
}

export interface RuleSet {
  key: string;
  name?: string;
  rules: Rule[];
}

export type Context = Record<string, unknown>;

/** Resolve a dot-path against the context. Returns undefined when absent. */
export function resolvePath(ctx: Context, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc != null && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, ctx);
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function compare(actual: unknown, op: Comparator, expected: unknown): boolean {
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt': return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in': return Array.isArray(expected) && expected.includes(actual as never);
    case 'nin': return Array.isArray(expected) && !expected.includes(actual as never);
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(expected as never);
      if (typeof actual === 'string') return actual.includes(String(expected));
      return false;
    case 'exists': return !isEmpty(actual);
    case 'empty': return isEmpty(actual);
    default: return false;
  }
}

function isGroup(p: Predicate): p is ConditionGroup {
  return 'all' in p || 'any' in p || 'not' in p;
}

/** Evaluate a predicate (single condition or nested group) against the context. */
export function evaluatePredicate(ctx: Context, p: Predicate): boolean {
  if (isGroup(p)) {
    if (p.all) return p.all.every((c) => evaluatePredicate(ctx, c));
    if (p.any) return p.any.some((c) => evaluatePredicate(ctx, c));
    if (p.not) return !evaluatePredicate(ctx, p.not);
    return true; // empty group matches
  }
  return compare(resolvePath(ctx, p.field), p.op, p.value);
}

export interface RuleOutcome {
  matched: string[];
  errors: string[];
  warnings: string[];
  /** Field defaults to apply, last-write-wins in rule order. */
  set: Record<string, unknown>;
  flags: string[];
  routes: string[];
  /** True when no rule emitted a blocking 'error' effect. */
  ok: boolean;
}

/**
 * Evaluate a rule set against a context. Rules run in order; `stop` short-circuits.
 * Pure and total - never throws on a malformed rule, it simply skips effects it
 * cannot apply.
 */
export function evaluateRuleSet(set: RuleSet, ctx: Context): RuleOutcome {
  const out: RuleOutcome = { matched: [], errors: [], warnings: [], set: {}, flags: [], routes: [], ok: true };
  for (const rule of set.rules ?? []) {
    if (rule.enabled === false) continue;
    let matched = false;
    try {
      matched = evaluatePredicate(ctx, rule.when);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    out.matched.push(rule.id);
    for (const eff of rule.then ?? []) {
      switch (eff.type) {
        case 'error': out.errors.push(eff.message ?? `Rule ${rule.id} failed.`); out.ok = false; break;
        case 'warn': out.warnings.push(eff.message ?? `Rule ${rule.id}.`); break;
        case 'set': if (eff.target) out.set[eff.target] = eff.value; break;
        case 'flag': if (eff.target) out.flags.push(eff.target); break;
        case 'route': if (eff.target) out.routes.push(eff.target); break;
      }
    }
    if (rule.stop) break;
  }
  return out;
}
