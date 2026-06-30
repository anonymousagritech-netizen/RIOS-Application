/**
 * Analytics & data warehouse (brief §13): the whitelisted pivot surface and the
 * catastrophe metrics. Drives the seeded claims through a pivot and computes cat
 * metrics from a supplied Event Loss Table. Skips cleanly without a DB.
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

describe('Pivot / data warehouse', () => {
  it('lists sources and pivots claims by cat event', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };

    const sources = await app.inject({ method: 'GET', url: '/api/analytics/sources', headers: auth });
    expect(sources.statusCode).toBe(200);
    expect(sources.json().sources.map((s: { key: string }) => s.key)).toContain('claim');

    const pivot = await app.inject({
      method: 'POST', url: '/api/analytics/pivot', headers: auth,
      payload: {
        source: 'claim', dimensions: ['catEvent'],
        measures: [{ field: 'grossLossMinor', agg: 'sum', as: 'gross' }, { agg: 'count' }],
      },
    });
    expect(pivot.statusCode).toBe(200);
    const cells = pivot.json().cells as { key: Record<string, unknown>; values: Record<string, number> }[];
    const ws = cells.find((c) => c.key.catEvent === 'WS-2026-ATLANTIC');
    expect(ws).toBeTruthy();
    // 750m + 320m gross from the two seeded windstorm claims.
    expect(ws!.values.gross).toBe(1070000000);
  });

  it('rejects a dimension outside the source whitelist', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/analytics/pivot', headers: auth,
      payload: { source: 'claim', dimensions: ['ssn'], measures: [{ agg: 'count' }] },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('Catastrophe analytics', () => {
  it('summarises real losses per event', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/analytics/catastrophe/events', headers: auth });
    expect(res.statusCode).toBe(200);
    const ws = res.json().events.find((e: { eventCode: string }) => e.eventCode === 'WS-2026-ATLANTIC');
    expect(ws).toBeTruthy();
    expect(Number(ws.grossLossMinor)).toBe(1070000000);
    expect(ws.claimCount).toBe(2);
  });

  it('computes AAL and a PML profile from a supplied ELT', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/analytics/catastrophe/metrics', headers: auth,
      payload: {
        elt: [
          { id: 'A', rate: 0.1, lossMinor: 100 },
          { id: 'B', rate: 0.02, lossMinor: 500 },
          { id: 'C', rate: 0.01, lossMinor: 1000 },
        ],
        returnPeriods: [10, 50, 100],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().averageAnnualLossMinor).toBe(30);
    expect(res.json().pmlProfile).toEqual([
      { returnPeriod: 10, lossMinor: 100 },
      { returnPeriod: 50, lossMinor: 500 },
      { returnPeriod: 100, lossMinor: 1000 },
    ]);
  });
});
