/**
 * Field-level security (brief §14). Proves a party's identifiers are masked for a
 * viewer without pii:view and raw for one with it (admin), and that policy
 * authoring is gated on fls:write. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { applyFieldSecurity, maskField, maskedFieldsFor, sha256Hex } from '@rios/domain';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

async function atlanticId(token: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/parties?q=Atlantic', headers: { authorization: `Bearer ${token}` } });
  return res.json().parties[0].id as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('Field-level security', () => {
  it('masks identifiers for a viewer without pii:view, raw for admin', async () => {
    if (!dbUp) return;
    const adminTkn = await loginToken('admin@demo.rios');
    const id = await atlanticId(adminTkn);

    // Admin holds pii:view (all perms) → raw object.
    const asAdmin = await app.inject({ method: 'GET', url: `/api/fls/parties/${id}`, headers: { authorization: `Bearer ${adminTkn}` } });
    expect(asAdmin.statusCode).toBe(200);
    expect(typeof asAdmin.json().party.identifiers).toBe('object');
    expect(asAdmin.json().maskedFields).toEqual([]);

    // Underwriter lacks pii:view → identifiers redacted.
    const uwTkn = await loginToken('uw@demo.rios');
    const asUw = await app.inject({ method: 'GET', url: `/api/fls/parties/${id}`, headers: { authorization: `Bearer ${uwTkn}` } });
    expect(asUw.json().party.identifiers).toBe('••••••');
    expect(asUw.json().maskedFields).toContain('identifiers');
  });

  it('forbids policy authoring without fls:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/fls/policies', headers: auth,
      payload: { entityType: 'party', field: 'country', requiredPermission: 'pii:view' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── Pure masking engine (0071) - no DB required ──────────────────────────────
describe('applyFieldSecurity masking strategies (pure)', () => {
  it('FULL replaces the whole value with a fixed mask', () => {
    expect(maskField('4111111111111234', 'FULL')).toBe('••••');
    expect(maskField({ lei: 'X' }, 'FULL')).toBe('••••'); // never leaks structure
  });

  it('PARTIAL keeps only the last 4 characters', () => {
    expect(maskField('4111111111111234', 'PARTIAL')).toBe('••••1234');
    expect(maskField('abc', 'PARTIAL')).toBe('••••'); // too short to reveal a tail
  });

  it('HASH produces a deterministic, non-reversible sha256', () => {
    // NIST vector: sha256("abc")
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(maskField('abc', 'HASH')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(maskField('abc', 'HASH')).toBe(maskField('abc', 'HASH')); // deterministic
  });

  it('REDACT removes the value entirely (null)', () => {
    expect(maskField('secret', 'REDACT')).toBeNull();
  });

  it('preserves null/undefined regardless of strategy', () => {
    expect(maskField(null, 'FULL')).toBeNull();
    expect(maskField(undefined, 'HASH')).toBeUndefined();
  });

  it('masks a row only for uncleared viewers; admin:manage always clears', () => {
    const policies = [
      { entity: 'party', field: 'bankAccount', maskStrategy: 'PARTIAL' as const, minPermission: 'pii:view' },
    ];
    const row = { id: '1', legalName: 'Atlantic Re', bankAccount: '4111111111111234' };

    const masked = applyFieldSecurity('party', row, policies, ['party:read']);
    expect(masked.bankAccount).toBe('••••1234');
    expect(masked.legalName).toBe('Atlantic Re'); // unconfigured field untouched

    const cleared = applyFieldSecurity('party', row, policies, ['pii:view']);
    expect(cleared.bankAccount).toBe('4111111111111234');
    const admin = applyFieldSecurity('party', row, policies, ['admin:manage']);
    expect(admin.bankAccount).toBe('4111111111111234');
  });

  it('is behaviour-preserving with no matching active policy (returns row unchanged)', () => {
    const row = { id: '1', bankAccount: '4111111111111234' };
    expect(applyFieldSecurity('party', row, [], ['party:read'])).toBe(row); // same reference
    const inactive = [{ entity: 'party', field: 'bankAccount', maskStrategy: 'FULL' as const, minPermission: 'pii:view', active: false }];
    expect(applyFieldSecurity('party', row, inactive, ['party:read'])).toBe(row);
    const otherEntity = [{ entity: 'treaty', field: 'bankAccount', maskStrategy: 'FULL' as const, minPermission: 'pii:view' }];
    expect(applyFieldSecurity('party', row, otherEntity, ['party:read'])).toBe(row);
  });

  it('masks across an array of rows', () => {
    const policies = [{ entity: 'party', field: 'bankAccount', maskStrategy: 'REDACT' as const, minPermission: 'pii:view' }];
    const rows = [{ id: '1', bankAccount: 'AAA' }, { id: '2', bankAccount: 'BBB' }];
    const out = applyFieldSecurity('party', rows, policies, ['party:read']);
    expect(out.map((r) => r.bankAccount)).toEqual([null, null]);
  });

  it('maskedFieldsFor reports what a viewer would lose', () => {
    const policies = [{ entity: 'party', field: 'bankAccount', maskStrategy: 'FULL' as const, minPermission: 'pii:view' }];
    expect(maskedFieldsFor('party', policies, ['party:read']).map((m) => m.field)).toEqual(['bankAccount']);
    expect(maskedFieldsFor('party', policies, ['pii:view'])).toEqual([]);
  });
});

// ── Enforcement on the real party detail read (0071) ─────────────────────────
describe('field-security enforcement on GET /api/parties/:id', () => {
  it('masks a configured field for uncleared roles, raw for cleared, and no-ops with no policy', async () => {
    if (!dbUp) return;
    const adminTkn = await loginToken('admin@demo.rios');
    const uwTkn = await loginToken('uw@demo.rios');
    const id = await atlanticId(adminTkn);

    // Behaviour-preserving baseline: with no policy, uw sees identifiers unchanged.
    const before = await app.inject({ method: 'GET', url: `/api/parties/${id}`, headers: { authorization: `Bearer ${uwTkn}` } });
    expect(before.statusCode).toBe(200);
    expect(typeof before.json().identifiers).toBe('object');

    // Author a policy: mask party.identifiers unless the viewer holds pii:view.
    const created = await app.inject({
      method: 'POST', url: '/api/field-security/policies', headers: { authorization: `Bearer ${adminTkn}` },
      payload: { entity: 'party', field: 'identifiers', maskStrategy: 'FULL', minPermission: 'pii:view' },
    });
    expect(created.statusCode).toBe(201);
    const policyId = created.json().id as string;

    try {
      // Uncleared underwriter → masked.
      const asUw = await app.inject({ method: 'GET', url: `/api/parties/${id}`, headers: { authorization: `Bearer ${uwTkn}` } });
      expect(asUw.json().identifiers).toBe('••••');
      // Cleared admin (admin:manage) → raw object.
      const asAdmin = await app.inject({ method: 'GET', url: `/api/parties/${id}`, headers: { authorization: `Bearer ${adminTkn}` } });
      expect(typeof asAdmin.json().identifiers).toBe('object');

      // Effective view reflects the caller's clearance.
      const effUw = await app.inject({ method: 'GET', url: '/api/field-security/effective?entity=party', headers: { authorization: `Bearer ${uwTkn}` } });
      expect(effUw.json().maskedFields.map((m: { field: string }) => m.field)).toContain('identifiers');
      const effAdmin = await app.inject({ method: 'GET', url: '/api/field-security/effective?entity=party', headers: { authorization: `Bearer ${adminTkn}` } });
      expect(effAdmin.json().maskedFields).toEqual([]);
    } finally {
      // Deactivate so the enforcement is opt-in and other tests see the raw read.
      await app.inject({ method: 'POST', url: `/api/field-security/policies/${policyId}/deactivate`, headers: { authorization: `Bearer ${adminTkn}` } });
    }

    // After deactivation the response is byte-identical to the baseline again.
    const after = await app.inject({ method: 'GET', url: `/api/parties/${id}`, headers: { authorization: `Bearer ${uwTkn}` } });
    expect(typeof after.json().identifiers).toBe('object');
  });

  it('forbids authoring an enforced policy without fls:write', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST', url: '/api/field-security/policies',
      headers: { authorization: `Bearer ${await loginToken('claims@demo.rios')}` },
      payload: { entity: 'party', field: 'identifiers', maskStrategy: 'FULL', minPermission: 'pii:view' },
    });
    expect(res.statusCode).toBe(403);
  });
});
