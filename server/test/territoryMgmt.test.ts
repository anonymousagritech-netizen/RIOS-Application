/**
 * Territory Management integration tests. dbUp guard + demo token.
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

describe('Territory Management', () => {
  it('returns the geographic hierarchy, zones and accumulation books', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/territory-management', headers: auth });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.totals).toHaveProperty('tivMinor');
    expect(Array.isArray(d.tree)).toBe(true);
    expect(d.zones).toHaveProperty('cresta');
    expect(d.countryBook).toHaveProperty('peakTivSharePct');
    // If any country carries exposure, the book must have a peak and sorted rows.
    if (d.countryBook.rows.length) {
      expect(d.countryBook.rows[0].tivMinor).toBeGreaterThanOrEqual(d.countryBook.rows[d.countryBook.rows.length - 1].tivMinor);
    }
  });

  it('creates a territory and reads it back with local exposure', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const code = `ZN-${Date.now()}`;
    const create = await app.inject({
      method: 'POST', url: '/api/territory-management', headers: auth,
      payload: { kind: 'RISK', code, name: 'Test Accumulation Belt', riskGrade: 'HIGH', perils: ['WIND'] },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;
    const detail = await app.inject({ method: 'GET', url: `/api/territory-management/${id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().code).toBe(code);
    expect(detail.json().exposure).toHaveProperty('tivMinor');
  });

  it('rejects unauthorised writes (403 for a read-only role)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('acct@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/territory-management', headers: auth,
      payload: { kind: 'RISK', code: 'ZN-X', name: 'X' },
    });
    expect(res.statusCode).toBe(403);
  });
});
