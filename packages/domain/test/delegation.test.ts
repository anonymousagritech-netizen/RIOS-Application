import { describe, it, expect } from 'vitest';
import { isActiveDelegation, canActAs, actingFor, type Delegation } from '../src/delegation.js';

const T = 1_000_000_000_000; // a fixed "now"

describe('isActiveDelegation', () => {
  it('honours active flag and the time window', () => {
    expect(isActiveDelegation({ delegatorUserId: 'a', delegateUserId: 'b', active: true }, T)).toBe(true);
    expect(isActiveDelegation({ delegatorUserId: 'a', delegateUserId: 'b', active: false }, T)).toBe(false);
    expect(isActiveDelegation({ delegatorUserId: 'a', delegateUserId: 'b', active: true, startsAtMs: T + 1 }, T)).toBe(false);
    expect(isActiveDelegation({ delegatorUserId: 'a', delegateUserId: 'b', active: true, endsAtMs: T - 1 }, T)).toBe(false);
  });
});

describe('canActAs', () => {
  const delegations: Delegation[] = [
    { delegatorUserId: 'alice', delegateUserId: 'bob', active: true },                                  // all approvals
    { delegatorUserId: 'carol', delegateUserId: 'bob', scopePermission: 'accounting:post', active: true }, // scoped
    { delegatorUserId: 'dave', delegateUserId: 'bob', active: false },                                  // inactive
  ];

  it('allows an unscoped delegation for any permission', () => {
    expect(canActAs(delegations, 'bob', 'alice', T)).toBe(true);
    expect(canActAs(delegations, 'bob', 'alice', T, 'treaty:bind')).toBe(true);
  });

  it('limits a scoped delegation to its permission', () => {
    expect(canActAs(delegations, 'bob', 'carol', T, 'accounting:post')).toBe(true);
    expect(canActAs(delegations, 'bob', 'carol', T, 'treaty:bind')).toBe(false);
  });

  it('rejects inactive delegations and unknown pairs', () => {
    expect(canActAs(delegations, 'bob', 'dave', T)).toBe(false);
    expect(canActAs(delegations, 'bob', 'erin', T)).toBe(false);
  });
});

describe('actingFor', () => {
  it('lists the distinct delegators a delegate can currently act for', () => {
    const delegations: Delegation[] = [
      { delegatorUserId: 'alice', delegateUserId: 'bob', active: true },
      { delegatorUserId: 'carol', delegateUserId: 'bob', active: true },
      { delegatorUserId: 'dave', delegateUserId: 'bob', active: false },
    ];
    expect(actingFor(delegations, 'bob', T).sort()).toEqual(['alice', 'carol']);
  });
});
