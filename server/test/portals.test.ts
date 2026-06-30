/**
 * External portals (brief §9.15). Proves that a portal user sees only their own
 * party's projection of the core data, that the read is permission-gated, and
 * that an admin can impersonate any portal grant. Skips cleanly without a DB.
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

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('Portals', () => {
  it('exposes the broker portal user only their own party projection', async () => {
    if (!dbUp) return;
    const tkn = await loginToken('broker@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // The grant the UI uses to render the picker.
    const grants = await app.inject({ method: 'GET', url: '/api/portal/grants', headers: auth });
    expect(grants.statusCode).toBe(200);
    expect(grants.json().grants).toHaveLength(1);
    expect(grants.json().grants[0].portalType).toBe('broker');

    // Overview resolves the single grant without query params.
    const overview = await app.inject({ method: 'GET', url: '/api/portal/overview', headers: auth });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().portal.portalType).toBe('broker');
    expect(overview.json().portal.partyName).toBe('Meridian Brokers');
    expect(typeof overview.json().summary.contracts).toBe('number');

    // Contracts are limited to ones this broker placed (the seeded CAT XL).
    const contracts = await app.inject({ method: 'GET', url: '/api/portal/contracts', headers: auth });
    expect(contracts.statusCode).toBe(200);
    for (const c of contracts.json().contracts) {
      expect(c.brokerName).toBe('Meridian Brokers');
    }
    expect(contracts.json().contracts.length).toBeGreaterThan(0);
  });

  it('refuses portal endpoints to a user with no grant', async () => {
    if (!dbUp) return;
    // The accountant holds no portal:read permission at all → 403.
    const tkn = await loginToken('acct@demo.rios');
    const res = await app.inject({ method: 'GET', url: '/api/portal/overview', headers: { authorization: `Bearer ${tkn}` } });
    expect(res.statusCode).toBe(403);
  });

  it('lets an admin impersonate any portal grant', async () => {
    if (!dbUp) return;
    const tkn = await loginToken('admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Find the cedent party id.
    const cedentTkn = await loginToken('cedent@demo.rios');
    const grant = await app.inject({ method: 'GET', url: '/api/portal/grants', headers: { authorization: `Bearer ${cedentTkn}` } });
    const partyId = grant.json().grants[0].partyId as string;

    const overview = await app.inject({
      method: 'GET',
      url: `/api/portal/overview?partyId=${partyId}&portalType=cedent`,
      headers: auth,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().portal.portalType).toBe('cedent');
    expect(overview.json().portal.partyName).toBe('Atlantic Mutual');
  });
});
