/**
 * Product lifecycle management (brief §14). Lists products with their available
 * lifecycle actions, drives a legal transition, refuses an illegal one (409) and
 * an unauthorised one (403). Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}
async function productId(token: string, code: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/products', headers: { authorization: `Bearer ${token}` } });
  return res.json().products.find((p: { code: string }) => p.code === code).id as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (app) {
    // Restore the seeded Marine product status if a test moved it.
    await ownerQuery(`update insurance_product set status='DRAFT' where code='MARINE-QS'`).catch(() => {});
    await app.close();
  }
  await closePools();
});

describe('Product lifecycle', () => {
  it('lists products with the actions available from their state', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/products', headers: auth });
    expect(res.statusCode).toBe(200);
    const active = res.json().products.find((p: { code: string }) => p.code === 'PROP-CAT-XL');
    expect(active.status).toBe('ACTIVE');
    expect(active.actions.map((a: { event: string }) => a.event).sort()).toEqual(['retire', 'suspend']);
  });

  it('approves a DRAFT product to ACTIVE (legal transition)', async () => {
    if (!dbUp) return;
    const adminTkn = await loginToken('admin@demo.rios');
    const id = await productId(adminTkn, 'MARINE-QS');
    const res = await app.inject({ method: 'POST', url: `/api/products/${id}/transition`, headers: { authorization: `Bearer ${adminTkn}` }, payload: { event: 'approve' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ACTIVE');
  });

  it('refuses an illegal transition with 409', async () => {
    if (!dbUp) return;
    const adminTkn = await loginToken('admin@demo.rios');
    const id = await productId(adminTkn, 'PROP-CAT-XL'); // ACTIVE
    const res = await app.inject({ method: 'POST', url: `/api/products/${id}/transition`, headers: { authorization: `Bearer ${adminTkn}` }, payload: { event: 'resume' } });
    expect(res.statusCode).toBe(409);
  });

  it('refuses an unauthorised transition with 403', async () => {
    if (!dbUp) return;
    const adminTkn = await loginToken('admin@demo.rios');
    const id = await productId(adminTkn, 'CAS-XL'); // SUSPENDED
    // claims user has no product:write
    const claimsTkn = await loginToken('claims@demo.rios');
    const res = await app.inject({ method: 'POST', url: `/api/products/${id}/transition`, headers: { authorization: `Bearer ${claimsTkn}` }, payload: { event: 'resume' } });
    expect(res.statusCode).toBe(403);
  });
});
