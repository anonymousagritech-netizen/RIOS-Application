/**
 * Treaty Administration + Organization integration tests. dbUp guard + demo token.
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

describe('Treaty Administration', () => {
  it('registers treaties, prices layers, versions, clauses, endorsements', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const reg = await app.inject({ method: 'GET', url: '/api/treaty-admin/register', headers: auth });
    expect(reg.statusCode).toBe(200);
    expect(Array.isArray(reg.json().treaties)).toBe(true);

    const analytics = await app.inject({ method: 'GET', url: '/api/treaty-admin/analytics', headers: auth });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json()).toHaveProperty('totalLimitMinor');

    const treaties = reg.json().treaties;
    if (treaties.length) {
      const id = treaties[0].id as string;
      // Add a layer, snapshot a version, add a clause + endorsement.
      const layer = await app.inject({ method: 'POST', url: `/api/treaty-admin/${id}/layers`, headers: auth, payload: { name: 'Layer test', attachment: 10_000_000, limit: 20_000_000, rateOnLine: 15, reinstatements: 1 } });
      expect(layer.statusCode).toBe(200);
      const detail = await app.inject({ method: 'GET', url: `/api/treaty-admin/${id}`, headers: auth });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().layerBook).toHaveProperty('weightedRolPct');
      expect(detail.json()).toHaveProperty('technicalAccount');
      expect(detail.json().layers.length).toBeGreaterThanOrEqual(1);

      const ver = await app.inject({ method: 'POST', url: `/api/treaty-admin/${id}/version`, headers: auth, payload: { note: 'Initial placement' } });
      expect(ver.statusCode).toBe(200);
      expect(ver.json().versionNo).toBeGreaterThanOrEqual(1);

      const clause = await app.inject({ method: 'POST', url: `/api/treaty-admin/${id}/clauses`, headers: auth, payload: { title: 'Hours Clause', category: 'CONDITION', body: '168 hours for earthquake.' } });
      expect(clause.statusCode).toBe(200);

      const endo = await app.inject({ method: 'POST', url: `/api/treaty-admin/${id}/endorsements`, headers: auth, payload: { description: 'Add named insured' } });
      expect(endo.statusCode).toBe(200);
      expect(endo.json().endorsementNo).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('Organization Management', () => {
  it('returns the org directory and creates a unit', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const org = await app.inject({ method: 'GET', url: '/api/organization', headers: auth });
    expect(org.statusCode).toBe(200);
    expect(Array.isArray(org.json().units)).toBe(true);
    expect(org.json().totals).toHaveProperty('employees');

    const create = await app.inject({ method: 'POST', url: '/api/organization', headers: auth, payload: { code: `BR-${Date.now()}`, name: 'Test Branch', kind: 'branch' } });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;
    const detail = await app.inject({ method: 'GET', url: `/api/organization/${id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().kind).toBe('branch');
  });
});
