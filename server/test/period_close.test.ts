/**
 * Period-close & FX-revaluation integration test (brief §9.8, §7.6).
 *
 * Opens a period, closes it (and proves the re-close guard), then runs an FX
 * revaluation of a EUR balance and asserts the gain in USD minor units. Skips
 * cleanly if Postgres is unreachable.
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

describe('period close & FX revaluation', () => {
  it('opens then closes a period; a re-close is a 409', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/finance/periods',
      headers: auth,
      payload: { code: `PC-${Date.now()}`, startDate: '2026-06-01', endDate: '2026-06-30' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const closed = await app.inject({
      method: 'POST',
      url: `/api/finance/periods/${id}/close`,
      headers: auth,
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('closed');

    const reClose = await app.inject({
      method: 'POST',
      url: `/api/finance/periods/${id}/close`,
      headers: auth,
    });
    expect(reClose.statusCode).toBe(409);
  });

  it('revalues a EUR balance and books the USD gain', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/finance/fx-revalue',
      headers: auth,
      payload: {
        baseCurrency: 'USD',
        balances: [{ currency: 'EUR', amount: 1000, bookedRate: 1.08, currentRate: 1.12 }],
      },
    });
    expect(res.statusCode).toBe(201);
    // EUR 1,000 @ 1.12 − @ 1.08 = USD 40.00 = 4000 minor.
    expect(res.json().gainLossMinor).toBe(4000);
    expect(res.json().detail.length).toBe(1);
  });
});
