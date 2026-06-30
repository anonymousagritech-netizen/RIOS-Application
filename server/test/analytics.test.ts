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

  it('saves a report definition and runs it', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const save = await app.inject({
      method: 'POST', url: '/api/analytics/reports', headers: auth,
      payload: {
        key: 'claims-by-status', name: 'Claims by status', source: 'claim',
        dimensions: ['status'], measures: [{ field: 'grossLossMinor', agg: 'sum', as: 'gross' }, { agg: 'count' }],
      },
    });
    expect(save.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/analytics/reports', headers: auth });
    expect(list.json().reports.some((r: { key: string }) => r.key === 'claims-by-status')).toBe(true);

    const run = await app.inject({ method: 'POST', url: '/api/analytics/reports/claims-by-status/run', headers: auth });
    expect(run.statusCode).toBe(200);
    expect(run.json().cells.length).toBeGreaterThan(0);
    expect(run.json().source).toBe('claim');
  });

  it('saves a dashboard of report widgets and renders headline figures', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    // Ensure the referenced report exists.
    await app.inject({
      method: 'POST', url: '/api/analytics/reports', headers: auth,
      payload: { key: 'claims-by-status', name: 'Claims by status', source: 'claim', dimensions: ['status'], measures: [{ field: 'grossLossMinor', agg: 'sum', as: 'total' }] },
    });
    const save = await app.inject({
      method: 'POST', url: '/api/analytics/dashboards', headers: auth,
      payload: { key: 'claims-overview', name: 'Claims overview', widgets: [{ title: 'Gross by status', reportKey: 'claims-by-status' }] },
    });
    expect(save.statusCode).toBe(201);

    const render = await app.inject({ method: 'POST', url: '/api/analytics/dashboards/claims-overview/render', headers: auth });
    expect(render.statusCode).toBe(200);
    expect(render.json().widgets).toHaveLength(1);
    expect(render.json().widgets[0].title).toBe('Gross by status');
    expect(render.json().widgets[0].groups).toBeGreaterThan(0);
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

  it('forecasts a metric series with a linear trend', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/analytics/forecast', headers: auth,
      payload: { series: [10, 20, 30, 40], periods: 2, method: 'linear' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fit.slope).toBeCloseTo(10, 6);
    expect(res.json().forecast).toEqual([
      { index: 4, value: 50 },
      { index: 5, value: 60 },
    ]);
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
