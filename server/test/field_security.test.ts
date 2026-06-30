/**
 * Field-level security (brief §14). Proves a party's identifiers are masked for a
 * viewer without pii:view and raw for one with it (admin), and that policy
 * authoring is gated on fls:write. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

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
