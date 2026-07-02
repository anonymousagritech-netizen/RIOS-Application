/**
 * Treasury dealing sub-ledger, market data & cash-flow forecast integration test
 * (brief §13, §16). Proves the vertical slice:
 *   capture BUY -> confirm -> settle (books a balanced GL journal; the trial
 *   balance stays balanced) -> double-settle is rejected 409; the mock
 *   market-data provider writes a MOCK price for a held/traded instrument; a
 *   cash-flow forecast returns bucketed net cash.
 *
 * Requires a migrated + seeded database (through 0067). Skips cleanly if no PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerPool, closePools } from '../src/db.js';

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

describe('treasury dealing sub-ledger', () => {
  it('captures a BUY, confirms and settles it into a balanced journal', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const captured = await app.inject({
      method: 'POST',
      url: '/api/treasury/trades',
      headers: auth,
      payload: {
        instrument: 'US Treasury 2.5% 2029',
        tradeType: 'BUY',
        quantity: 1000,
        priceMinor: 9850, // $98.50 clean price
        feesMinor: 5000, // $50 fee
        currency: 'USD',
      },
    });
    expect(captured.statusCode).toBe(201);
    expect(captured.json().status).toBe('CAPTURED');
    // gross = 1000 * 9850 + 5000 = 9,855,000 minor
    expect(captured.json().grossMinor).toBe(9_855_000);
    const tradeId = captured.json().id as string;

    // Settling before confirmation is an illegal transition.
    const earlySettle = await app.inject({ method: 'POST', url: `/api/treasury/trades/${tradeId}/settle`, headers: auth });
    expect(earlySettle.statusCode).toBe(409);

    const confirmed = await app.inject({ method: 'POST', url: `/api/treasury/trades/${tradeId}/confirm`, headers: auth });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe('CONFIRMED');

    const settled = await app.inject({ method: 'POST', url: `/api/treasury/trades/${tradeId}/settle`, headers: auth });
    expect(settled.statusCode).toBe(200);
    expect(settled.json().status).toBe('SETTLED');
    const journalId = settled.json().journalId as string;
    expect(journalId).toBeTruthy();

    // The settlement journal is balanced (sum of debits == sum of credits).
    const bal = await ownerPool.query<{ debit: string; credit: string }>(
      `select coalesce(sum(debit_minor),0) as debit, coalesce(sum(credit_minor),0) as credit
         from ledger_posting where journal_id = $1`,
      [journalId],
    );
    expect(Number(bal.rows[0]!.debit)).toBe(9_855_000);
    expect(Number(bal.rows[0]!.credit)).toBe(9_855_000);
    expect(bal.rows[0]!.debit).toBe(bal.rows[0]!.credit);

    // Double-settle is rejected.
    const again = await app.inject({ method: 'POST', url: `/api/treasury/trades/${tradeId}/settle`, headers: auth });
    expect(again.statusCode).toBe(409);

    // The trade is retrievable and carries the journal linkage.
    const detail = await app.inject({ method: 'GET', url: `/api/treasury/trades/${tradeId}`, headers: auth });
    expect(detail.json().status).toBe('SETTLED');
    expect(detail.json().journalId).toBe(journalId);
  });

  it('keeps the whole GL trial balance balanced after a settlement', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const captured = await app.inject({
      method: 'POST',
      url: '/api/treasury/trades',
      headers: auth,
      payload: { instrument: 'Corporate Bond AA 4.2% 2031', tradeType: 'SELL', quantity: 500, priceMinor: 10100, currency: 'USD' },
    });
    const tradeId = captured.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treasury/trades/${tradeId}/confirm`, headers: auth });
    await app.inject({ method: 'POST', url: `/api/treasury/trades/${tradeId}/settle`, headers: auth });

    const tb = await ownerPool.query<{ debit: string; credit: string }>(
      `select coalesce(sum(debit_minor),0) as debit, coalesce(sum(credit_minor),0) as credit from ledger_posting`,
    );
    expect(tb.rows[0]!.debit).toBe(tb.rows[0]!.credit);
  });
});

describe('treasury market data (mock provider)', () => {
  it('refreshes and writes a MOCK price for a held/traded instrument', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const refresh = await app.inject({ method: 'POST', url: '/api/treasury/market-data/refresh', headers: auth, payload: {} });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().source).toBe('MOCK');
    expect(refresh.json().refreshed).toBeGreaterThan(0);

    const list = await app.inject({
      method: 'GET',
      url: '/api/treasury/market-data?instrument=US%20Treasury%202.5%25%202029',
      headers: auth,
    });
    expect(list.statusCode).toBe(200);
    const prices = list.json().prices as Array<{ source: string; priceMinor: number }>;
    expect(prices.length).toBeGreaterThan(0);
    expect(prices[0]!.source).toBe('MOCK');
    expect(prices[0]!.priceMinor).toBeGreaterThan(0);
  });
});

describe('treasury cash-flow forecast', () => {
  it('buckets scheduled cash items (premium + trade settlements) into net cash', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // A future-dated settling BUY contributes an outflow into the horizon.
    const captured = await app.inject({
      method: 'POST',
      url: '/api/treasury/trades',
      headers: auth,
      payload: {
        instrument: '3-month T-Bill',
        tradeType: 'BUY',
        quantity: 1000,
        priceMinor: 10000,
        currency: 'USD',
        settleDate: '2026-07-15',
      },
    });
    const tradeId = captured.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treasury/trades/${tradeId}/confirm`, headers: auth });

    const forecast = await app.inject({
      method: 'POST',
      url: '/api/treasury/cash-flow-forecast',
      headers: auth,
      payload: { asOf: '2026-01-01', horizonDays: 365, bucketDays: 30, currency: 'USD' },
    });
    expect(forecast.statusCode).toBe(201);
    const body = forecast.json();
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(body.buckets.length).toBeGreaterThan(0);
    // The trade settlement (10,000,000 minor outflow) is captured in the totals.
    expect(body.totalOutflowMinor).toBeGreaterThanOrEqual(10_000_000);
    // net = inflows - outflows, and each bucket nets its own legs.
    expect(body.netMinor).toBe(body.totalInflowMinor - body.totalOutflowMinor);
    const forecastId = body.id as string;

    const fetched = await app.inject({ method: 'GET', url: `/api/treasury/cash-flow-forecast/${forecastId}`, headers: auth });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().buckets.length).toBe(body.buckets.length);
    expect(fetched.json().netMinor).toBe(body.netMinor);
  });
});
