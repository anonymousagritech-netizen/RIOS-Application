/**
 * Executive Intelligence integration test. dbUp guard + demo token.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('Executive Intelligence', () => {
  it('returns all eight persona packs with KPIs and charts', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/executive', headers: auth });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    const keys = d.personas.map((p: { key: string }) => p.key);
    expect(keys).toEqual(['CEO', 'CFO', 'CHIEF_UW', 'OPERATIONS', 'FINANCE', 'CLAIMS', 'PORTFOLIO', 'RISK']);
    for (const k of keys) {
      expect(d.packs[k].kpis.length).toBeGreaterThan(0);
      expect(Array.isArray(d.packs[k].charts)).toBe(true);
      // Every KPI carries a numeric value and a known format.
      for (const kpi of d.packs[k].kpis) {
        expect(typeof kpi.value).toBe('number');
        expect(['MONEY', 'INT', 'PCT']).toContain(kpi.format);
      }
    }
  });

  it('denies access without reporting:read', async () => {
    if (!dbUp) return;
    // PORTAL/broker role lacks reporting:read.
    const auth = { authorization: `Bearer ${await token('broker@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/executive', headers: auth });
    expect(res.statusCode).toBe(403);
  });
});
