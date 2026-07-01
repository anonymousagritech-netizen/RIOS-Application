/**
 * Formula Engine. Evaluates the seed technical-premium formula (value > 0 with a
 * gross_premium step in the breakdown), records a reasoned override that
 * persists, then restores the system value. Skips cleanly without a DB.
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

describe('Formula engine', () => {
  it('evaluates the technical premium formula with a stepwise breakdown', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/formulas/underwriting.technical_premium/evaluate', headers: auth,
      payload: {
        inputs: {
          sumInsured: 100_000_000, rate: 0.05, lossRatio: 0.6, expenseRatio: 0.1,
          brokerageRate: 0.02, commissionRate: 0.05, riskMarginRate: 0.1,
          profitMarginRate: 0.05, catLoadRate: 0.03, taxRate: 0.02,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.value).toBeGreaterThan(0);
    expect(body.version).toBe(1);
    expect(body.steps.map((s: { name: string }) => s.name)).toContain('gross_premium');
  });

  it('lists formulas, falling back to the seed library when the tenant has none', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/formulas?category=Underwriting', headers: auth });
    expect(res.statusCode).toBe(200);
    const keys = res.json().formulas.map((f: { key: string }) => f.key);
    expect(keys).toContain('underwriting.technical_premium');
  });

  it('records a reasoned override and then restores the system value', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const entityId = `test-${Date.now()}`;

    const created = await app.inject({
      method: 'POST', url: '/api/formulas/override', headers: auth,
      payload: {
        entityType: 'contract', entityId, field: 'technicalPremiumMinor',
        formulaKey: 'underwriting.technical_premium',
        originalMinor: 5_000_000, overrideMinor: 5_500_000,
        reason: 'Negotiated premium adjustment',
      },
    });
    expect(created.statusCode).toBe(201);
    const overrideId = created.json().id as string;
    expect(created.json().overrideMinor).toBe(5_500_000);
    expect(created.json().overridden).toBe(true);

    const listed = await app.inject({
      method: 'GET', url: `/api/formulas/overrides?entityType=contract&entityId=${entityId}`, headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    const found = listed.json().overrides.find((o: { id: string }) => o.id === overrideId);
    expect(found).toBeTruthy();
    expect(found.status).toBe('ACTIVE');
    expect(found.originalMinor).toBe(5_000_000);

    const restored = await app.inject({
      method: 'POST', url: `/api/formulas/overrides/${overrideId}/restore`, headers: auth,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe('RESTORED');
  });

  it('rejects an override with an empty reason', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/formulas/override', headers: auth,
      payload: {
        entityType: 'contract', entityId: 'x', field: 'f',
        originalMinor: 1, overrideMinor: 2, reason: '   ',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
