/**
 * Assets module integration test (brief §9.14 inventory + §9.1 entitlements).
 *
 * Requires a migrated + seeded database (DATABASE_URL/DATABASE_APP_URL). Skips
 * cleanly if Postgres is unreachable so it never produces a false failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'demo1234', tenantCode: 'demo' },
  });
  return res.json().token as string;
}

beforeAll(async () => {
  try {
    await appPool.query('select 1');
  } catch {
    dbUp = false;
    return;
  }
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('assets: inventory + entitlement engine', () => {
  it('creates an asset', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/assets',
      headers: auth,
      payload: { tag: `LAP-${Date.now()}`, name: 'Test Laptop', category: 'hardware', value: 1500, currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().id).toBeTruthy();
  });

  it('creates a license and computes seatsAvailable', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const name = `License ${Date.now()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/licenses',
      headers: auth,
      payload: { name, vendor: 'Acme', seatsTotal: 10, cost: 999, currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/licenses', headers: auth });
    const lic = list.json().licenses.find((l: { name: string }) => l.name === name);
    expect(lic).toBeTruthy();
    expect(lic.seatsAvailable).toBe(10); // seats_total 10 - seats_used 0
  });

  it('upserts a feature entitlement without a deploy', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const put = await app.inject({
      method: 'PUT',
      url: '/api/entitlements/ai_assistant',
      headers: auth,
      payload: { isEnabled: true, plan: 'enterprise' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().isEnabled).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/entitlements', headers: auth });
    const ent = list.json().entitlements.find((e: { featureKey: string }) => e.featureKey === 'ai_assistant');
    expect(ent).toBeTruthy();
    expect(ent.isEnabled).toBe(true);
  });
});
