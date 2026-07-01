/**
 * Broker / Cedent / Capacity / Exposure management integration tests.
 * dbUp guard + demo token, mirroring underwriting.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('Broker & Cedent management', () => {
  it('lists brokers with derived KPIs and returns a detail workspace', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/brokers', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().brokers)).toBe(true);
    if (list.json().brokers.length) {
      const id = list.json().brokers[0].id as string;
      const detail = await app.inject({ method: 'GET', url: `/api/brokers/${id}`, headers: auth });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toHaveProperty('score');
      expect(detail.json()).toHaveProperty('profitability');
      expect(detail.json().score).toHaveProperty('band');
      // Save a profile + a contract + a communication.
      const prof = await app.inject({ method: 'POST', url: `/api/brokers/${id}/profile`, headers: auth, payload: { tier: 'GLOBAL', region: 'EMEA', relationshipScore: 82 } });
      expect(prof.statusCode).toBe(200);
      const c = await app.inject({ method: 'POST', url: `/api/brokers/${id}/contracts`, headers: auth, payload: { kind: 'TOBA', commissionPct: 12.5 } });
      expect(c.statusCode).toBe(200);
      const comm = await app.inject({ method: 'POST', url: `/api/brokers/${id}/communications`, headers: auth, payload: { kind: 'CALL', subject: 'Renewal chat' } });
      expect(comm.statusCode).toBe(200);
    }
    const analytics = await app.inject({ method: 'GET', url: '/api/brokers/analytics', headers: auth });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json()).toHaveProperty('byTier');
  });

  it('lists cedents and returns a workspace with loss history', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/cedents', headers: auth });
    expect(list.statusCode).toBe(200);
    if (list.json().cedents.length) {
      const id = list.json().cedents[0].id as string;
      const detail = await app.inject({ method: 'GET', url: `/api/cedents/${id}`, headers: auth });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toHaveProperty('lossHistory');
      expect(detail.json()).toHaveProperty('treaties');
      const prof = await app.inject({ method: 'POST', url: `/api/cedents/${id}/profile`, headers: auth, payload: { rating: 'A+', ratingAgency: 'AM Best', relationshipScore: 75 } });
      expect(prof.statusCode).toBe(200);
    }
    const analytics = await app.inject({ method: 'GET', url: '/api/cedents/analytics', headers: auth });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json()).toHaveProperty('bookLossRatioPct');
  });
});

describe('Capacity management', () => {
  it('creates lines and reports utilisation, alerts and forecast', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    await app.inject({ method: 'POST', url: '/api/underwriting/capacity/lines', headers: auth, payload: { dimension: 'PERIL', dimKey: 'WINDSTORM', label: 'US Wind', available: 100_000_000, consumed: 95_000_000, warnPct: 80 } });
    await app.inject({ method: 'POST', url: '/api/underwriting/capacity/lines', headers: auth, payload: { dimension: 'PERIL', dimKey: 'EARTHQUAKE', label: 'JP Quake', available: 50_000_000, consumed: 10_000_000 } });
    const book = await app.inject({ method: 'GET', url: '/api/underwriting/capacity', headers: auth });
    expect(book.statusCode).toBe(200);
    expect(book.json().book).toHaveProperty('utilisationPct');
    expect(book.json()).toHaveProperty('forecast');
    // The 95% US Wind line should raise a warning/breach alert.
    expect(book.json().alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Exposure management', () => {
  it('registers items and summarises accumulation + heatmap', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    await app.inject({ method: 'POST', url: '/api/underwriting/exposure/items', headers: auth, payload: { name: 'Miami tower', country: 'US', admin1: 'FL', cresta: 'US-FL', peril: 'Windstorm', lineOfBusiness: 'PROPERTY', tiv: 100_000_000, pml: 20_000_000 } });
    await app.inject({ method: 'POST', url: '/api/underwriting/exposure/items', headers: auth, payload: { name: 'Tokyo plant', country: 'JP', cresta: 'JP-TK', peril: 'Earthquake', lineOfBusiness: 'PROPERTY', tiv: 80_000_000, pml: 30_000_000 } });
    const sum = await app.inject({ method: 'GET', url: '/api/underwriting/exposure/summary', headers: auth });
    expect(sum.statusCode).toBe(200);
    expect(sum.json().summary).toHaveProperty('peakZone');
    expect(sum.json().summary).toHaveProperty('concentrationPct');
    expect(sum.json().heatmap).toHaveProperty('cells');
    const items = await app.inject({ method: 'GET', url: '/api/underwriting/exposure/items', headers: auth });
    expect(items.json().items.length).toBeGreaterThanOrEqual(2);
  });
});
