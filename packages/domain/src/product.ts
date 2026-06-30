/**
 * Product lifecycle management (brief §14 - insurance-product factory). The
 * lifecycle of an insurance product is itself a workflow definition, so it reuses
 * the pure interpreter in workflow.ts (validateWorkflow / applyEvent) rather than
 * a second engine. This module exposes the canonical product lifecycle; the
 * server drives a product's status through it, re-checking permissions.
 */

import type { WorkflowDefinition } from './workflow.js';

/**
 * Canonical insurance-product lifecycle:
 *   DRAFT → ACTIVE → (SUSPENDED ↔ ACTIVE) → RETIRED
 * Activation and retirement require product:write.
 */
export const PRODUCT_LIFECYCLE: WorkflowDefinition = {
  key: 'product.lifecycle',
  name: 'Insurance product lifecycle',
  initial: 'DRAFT',
  states: ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'],
  finalStates: ['RETIRED'],
  transitions: [
    { event: 'approve', from: 'DRAFT', to: 'ACTIVE', permission: 'product:write', label: 'Approve' },
    { event: 'suspend', from: 'ACTIVE', to: 'SUSPENDED', permission: 'product:write', label: 'Suspend' },
    { event: 'resume', from: 'SUSPENDED', to: 'ACTIVE', permission: 'product:write', label: 'Resume' },
    { event: 'retire', from: 'ACTIVE', to: 'RETIRED', permission: 'product:write', label: 'Retire' },
    { event: 'retire', from: 'SUSPENDED', to: 'RETIRED', permission: 'product:write', label: 'Retire' },
    { event: 'discard', from: 'DRAFT', to: 'RETIRED', permission: 'product:write', label: 'Discard' },
  ],
};
