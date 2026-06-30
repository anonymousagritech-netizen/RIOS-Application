/**
 * Treasury, investments & tax (brief §9, §13). Exercises the portfolio summary,
 * the levy computation over the seeded levy stack, and the permission gate.
 * Skips cleanly without a DB.
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

describe('Treasury & investments', () => {
  it('lists holdings with a per-currency portfolio summary', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/treasury/holdings', headers: auth });
    expect(res.statusCode).toBe(200);
    const usd = res.json().summaries.find((s: { currency: string }) => s.currency === 'USD');
    expect(usd).toBeTruthy();
    // Seeded book values: 498m + 300m + 199m + 150m = 1,147,000,000
    expect(usd.bookValueMinor).toBe(1147000000);
    expect(usd.count).toBe(4);
  });
});

describe('Taxes & levies', () => {
  it('computes the seeded levy stack on a premium base, lines reconciling to the total', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/treasury/levies/compute', headers: auth,
      payload: { baseMinor: 100000000 }, // 1,000,000.00
    });
    expect(res.statusCode).toBe(200);
    const r = res.json().result;
    // PREM_TAX 5% + FET 1% + STAMP 0.5% = 6.5% → 6,500,000 minor
    expect(r.totalLevyMinor).toBe(6500000);
    expect(r.grossInclusiveMinor).toBe(106500000);
    const sum = r.lines.reduce((a: number, l: { amountMinor: number }) => a + l.amountMinor, 0);
    expect(sum).toBe(r.totalLevyMinor);
  });

  it('forbids levy authoring without treasury:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/treasury/levies', headers: auth,
      payload: { code: 'NOPE', name: 'No', rate: 0.01 },
    });
    expect(res.statusCode).toBe(403);
  });
});
