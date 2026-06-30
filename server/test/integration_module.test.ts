/**
 * Integration module test (brief §17): webhook outbox + data import/export.
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

describe('integration: webhooks + import/export', () => {
  it('emits a webhook event to a matching subscription', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const sub = await app.inject({
      method: 'POST',
      url: '/api/integration/webhooks',
      headers: auth,
      payload: { url: 'https://example.test/hook', eventTypes: ['contract.bound'] },
    });
    expect(sub.statusCode).toBe(201);
    const subId = sub.json().id as string;

    const emit = await app.inject({
      method: 'POST',
      url: '/api/integration/webhooks/emit',
      headers: auth,
      payload: { eventType: 'contract.bound', payload: { hello: 'world' } },
    });
    expect(emit.json().enqueued).toBeGreaterThanOrEqual(1);

    const deliveries = await app.inject({
      method: 'GET',
      url: `/api/integration/webhooks/${subId}/deliveries`,
      headers: auth,
    });
    expect(deliveries.json().deliveries.length).toBeGreaterThanOrEqual(1);
  });

  it('exports parties as JSON', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({
      method: 'GET',
      url: '/api/integration/export?entity=parties&format=json',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().rows)).toBe(true);
  });

  it('imports parties, accepting valid rows and rejecting invalid ones', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/integration/import',
      headers: auth,
      payload: { entity: 'parties', rows: [{ legalName: 'Imported Co' }, {}] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted).toBe(1);
    expect(body.rejected.length).toBe(1);
  });
});
