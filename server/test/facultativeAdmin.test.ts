/**
 * Facultative Administration workspace tests. dbUp guard + demo token.
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

describe('Facultative Administration', () => {
  it('lists the register and prices placement + quotes on a risk', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const reg = await app.inject({ method: 'GET', url: '/api/facultative-admin', headers: auth });
    expect(reg.statusCode).toBe(200);
    expect(Array.isArray(reg.json().risks)).toBe(true);
    expect(reg.json().totals).toHaveProperty('placementRatePct');

    const risks = reg.json().risks;
    if (!risks.length) return;
    const id = risks[0].id as string;

    // Add a quote, a placement line and an engineering report.
    const quote = await app.inject({ method: 'POST', url: `/api/facultative-admin/${id}/quotes`, headers: auth, payload: { reinsurerName: 'Test Re', sharePct: 25, premium: 100000, ratePct: 1.5 } });
    expect(quote.statusCode).toBe(200);
    const line = await app.inject({ method: 'POST', url: `/api/facultative-admin/${id}/placement`, headers: auth, payload: { reinsurerName: 'Test Re', kind: 'LEAD', writtenPct: 30, signedPct: 25, premium: 90000 } });
    expect(line.statusCode).toBe(200);
    const eng = await app.inject({ method: 'POST', url: `/api/facultative-admin/${id}/engineering`, headers: auth, payload: { kind: 'INSPECTION', inspector: 'QA', riskGrade: 'HIGH', findings: 'ok' } });
    expect(eng.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/facultative-admin/${id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().placement).toHaveProperty('signedPct');
    expect(detail.json().quotes.length).toBeGreaterThanOrEqual(1);
    expect(detail.json().engineering.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects writes from a read-only role (403)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('acct@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/facultative-admin/00000000-0000-0000-0000-000000000000/quotes', headers: auth, payload: { sharePct: 10, premium: 1 } });
    expect(res.statusCode).toBe(403);
  });
});
