/**
 * Platform & org batch (brief §9.1, §13): multi-company, offices, feature flags,
 * cost/capacity utilisation and performance throughput. Skips without a DB.
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

describe('Multi-company & offices', () => {
  it('lists the seeded companies with their parent and the offices', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const companies = await app.inject({ method: 'GET', url: '/api/platform/companies', headers: auth });
    expect(companies.statusCode).toBe(200);
    const eu = companies.json().companies.find((c: { code: string }) => c.code === 'CO-EU');
    expect(eu.parentName).toBe('Demo Reinsurance Group');

    const offices = await app.inject({ method: 'GET', url: '/api/platform/offices', headers: auth });
    expect(offices.json().offices.some((o: { code: string }) => o.code === 'OFF-LON')).toBe(true);
  });
});

describe('Feature & license flags', () => {
  it('reports a feature as enabled/disabled', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const on = await app.inject({ method: 'GET', url: '/api/platform/features/ai-assistant/enabled', headers: auth });
    expect(on.json().enabled).toBe(true);
    const off = await app.inject({ method: 'GET', url: '/api/platform/features/voice-assistant/enabled', headers: auth });
    expect(off.json().enabled).toBe(false);
  });

  it('forbids managing flags without platform:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/platform/features', headers: auth, payload: { key: 'x', name: 'X' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('Cost & capacity + performance', () => {
  it('annotates cost records with capacity utilisation and totals the spend', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/cost/records?period=2026-06', headers: auth });
    expect(res.statusCode).toBe(200);
    const compute = res.json().records.find((r: { category: string }) => r.category === 'compute');
    expect(compute.utilisation).toBeCloseTo(21 / 32, 6); // 0.656
    expect(compute.utilisationBand).toBe('normal');
    // 1,850,000 + 420,000 + 980,000 + 12,500,000
    expect(res.json().totalSpendMinor).toBe(15750000);
  });

  it('returns live throughput totals', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/perf/throughput', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().totals.claims).toBe('number');
    expect(res.json().totals.claims).toBeGreaterThanOrEqual(3); // seeded claims
  });
});
