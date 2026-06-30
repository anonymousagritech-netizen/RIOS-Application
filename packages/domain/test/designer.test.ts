import { describe, it, expect } from 'vitest';
import {
  validateWorkflow,
  isValidWorkflow,
  availableTransitions,
  applyEvent,
  isFinalState,
  type WorkflowDefinition,
} from '../src/workflow.js';
import {
  evaluateRuleSet,
  evaluatePredicate,
  resolvePath,
  type RuleSet,
} from '../src/rules.js';

const treatyFlow: WorkflowDefinition = {
  key: 'treaty.lifecycle',
  name: 'Treaty lifecycle',
  initial: 'DRAFT',
  states: ['DRAFT', 'QUOTED', 'BOUND', 'ACTIVE', 'CANCELLED'],
  finalStates: ['CANCELLED'],
  transitions: [
    { event: 'quote', from: 'DRAFT', to: 'QUOTED' },
    { event: 'bind', from: 'QUOTED', to: 'BOUND', permission: 'treaty:bind' },
    { event: 'activate', from: 'BOUND', to: 'ACTIVE' },
    { event: 'cancel', from: 'DRAFT', to: 'CANCELLED' },
    { event: 'cancel', from: 'QUOTED', to: 'CANCELLED' },
  ],
};

describe('workflow interpreter', () => {
  it('accepts a well-formed definition', () => {
    expect(validateWorkflow(treatyFlow)).toEqual([]);
    expect(isValidWorkflow(treatyFlow)).toBe(true);
  });

  it('flags a bad initial state, unknown transition targets and dead ends', () => {
    const broken: WorkflowDefinition = {
      key: 'x', initial: 'NOPE', states: ['A', 'B'],
      transitions: [{ event: 'go', from: 'A', to: 'Z' }],
    };
    const codes = validateWorkflow(broken).map((i) => i.code);
    expect(codes).toContain('bad_initial');
    expect(codes).toContain('bad_to');
    expect(codes).toContain('orphan_state'); // B is unreachable: no incoming or outgoing transition
  });

  it('lists the transitions available from a state', () => {
    expect(availableTransitions(treatyFlow, 'DRAFT').map((t) => t.event).sort()).toEqual(['cancel', 'quote']);
    expect(availableTransitions(treatyFlow, 'ACTIVE')).toEqual([]);
  });

  it('applies a legal event and rejects an illegal one', () => {
    expect(applyEvent(treatyFlow, 'DRAFT', 'quote').state).toBe('QUOTED');
    const bad = applyEvent(treatyFlow, 'DRAFT', 'activate');
    expect(bad.ok).toBe(false);
    expect(bad.state).toBe('DRAFT');
  });

  it('enforces a transition permission unless admin', () => {
    expect(applyEvent(treatyFlow, 'QUOTED', 'bind', []).ok).toBe(false);
    expect(applyEvent(treatyFlow, 'QUOTED', 'bind', ['treaty:bind']).state).toBe('BOUND');
    expect(applyEvent(treatyFlow, 'QUOTED', 'bind', ['admin:manage']).state).toBe('BOUND');
  });

  it('recognises terminal states', () => {
    expect(isFinalState(treatyFlow, 'CANCELLED')).toBe(true);
    expect(isFinalState(treatyFlow, 'ACTIVE')).toBe(true); // no outgoing transitions
    expect(isFinalState(treatyFlow, 'DRAFT')).toBe(false);
  });
});

const ruleSet: RuleSet = {
  key: 'treaty.bind.guards',
  rules: [
    {
      id: 'premium-required',
      when: { field: 'premiumMinor', op: 'empty' },
      then: [{ type: 'error', message: 'Premium is required before binding.' }],
    },
    {
      id: 'large-line-referral',
      when: { all: [{ field: 'premiumMinor', op: 'gte', value: 100_000_00 }, { field: 'lob', op: 'in', value: ['PROPERTY', 'MARINE'] }] },
      then: [{ type: 'route', target: 'senior-uw' }, { type: 'flag', target: 'large-line' }],
    },
    {
      id: 'default-brokerage',
      when: { field: 'brokeragePct', op: 'empty' },
      then: [{ type: 'set', target: 'brokeragePct', value: 10 }],
    },
  ],
};

describe('rules engine', () => {
  it('resolves dot-paths and evaluates predicates safely', () => {
    expect(resolvePath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(resolvePath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(evaluatePredicate({ x: 5 }, { field: 'x', op: 'gt', value: 3 })).toBe(true);
    expect(evaluatePredicate({ x: 5 }, { any: [{ field: 'x', op: 'eq', value: 1 }, { field: 'x', op: 'eq', value: 5 }] })).toBe(true);
    expect(evaluatePredicate({ x: 5 }, { not: { field: 'x', op: 'eq', value: 5 } })).toBe(false);
  });

  it('blocks when a required field is missing and applies a default', () => {
    const r = evaluateRuleSet(ruleSet, { lob: 'CASUALTY' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('Premium is required before binding.');
    expect(r.set.brokeragePct).toBe(10);
  });

  it('routes and flags a large property line, and passes a clean small line', () => {
    const big = evaluateRuleSet(ruleSet, { premiumMinor: 250_000_00, lob: 'PROPERTY', brokeragePct: 12 });
    expect(big.ok).toBe(true);
    expect(big.routes).toContain('senior-uw');
    expect(big.flags).toContain('large-line');
    expect(big.matched).toContain('large-line-referral');

    const small = evaluateRuleSet(ruleSet, { premiumMinor: 5_000_00, lob: 'MOTOR', brokeragePct: 8 });
    expect(small.ok).toBe(true);
    expect(small.routes).toEqual([]);
    expect(small.matched).toEqual([]);
  });
});
