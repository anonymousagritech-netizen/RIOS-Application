import { describe, it, expect } from 'vitest';
import { PRODUCT_LIFECYCLE } from '../src/product.js';
import { validateWorkflow, applyEvent, isFinalState } from '../src/workflow.js';

describe('product lifecycle', () => {
  it('is a structurally valid workflow', () => {
    expect(validateWorkflow(PRODUCT_LIFECYCLE)).toEqual([]);
  });

  it('drives DRAFT → ACTIVE → SUSPENDED → ACTIVE → RETIRED with product:write', () => {
    const perms = ['product:write'];
    expect(applyEvent(PRODUCT_LIFECYCLE, 'DRAFT', 'approve', perms).state).toBe('ACTIVE');
    expect(applyEvent(PRODUCT_LIFECYCLE, 'ACTIVE', 'suspend', perms).state).toBe('SUSPENDED');
    expect(applyEvent(PRODUCT_LIFECYCLE, 'SUSPENDED', 'resume', perms).state).toBe('ACTIVE');
    expect(applyEvent(PRODUCT_LIFECYCLE, 'ACTIVE', 'retire', perms).state).toBe('RETIRED');
    expect(isFinalState(PRODUCT_LIFECYCLE, 'RETIRED')).toBe(true);
  });

  it('refuses an illegal transition and enforces the permission', () => {
    expect(applyEvent(PRODUCT_LIFECYCLE, 'DRAFT', 'retire', ['product:write']).ok).toBe(false); // no DRAFT→retire(RETIRED)? discard yes, retire no
    expect(applyEvent(PRODUCT_LIFECYCLE, 'DRAFT', 'approve', []).ok).toBe(false); // missing permission
  });
});
