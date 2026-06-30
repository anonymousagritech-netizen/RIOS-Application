/**
 * Procurement module integration test (brief §9.14).
 * Mirrors integration.test.ts: dbUp guard, admin token, buildApp/closePools.
 * Flow: create vendor → create PO with two lines (qty 2 @ 100, qty 1 @ 50)
 * → assert totalMinor === 25000 → transition draft→issued → illegal jump 409.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'demo1234', tenantCode: 'demo' },
  });
  return res.json().token as string;
}

beforeAll(async () => {
  try {
    await appPool.query('select 1');
  } catch {
    dbUp = false;
    return;
  }
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('Procurement: vendors, orders, lifecycle', () => {
  it('creates a vendor and a purchase order with correct totals', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const suffix = Date.now().toString(36);

    // Vendor
    const vendorRes = await app.inject({
      method: 'POST',
      url: '/api/procurement/vendors',
      headers: auth,
      payload: { code: `VEN-${suffix}`, name: 'Acme Supplies', category: 'IT', email: 'sales@acme.test' },
    });
    expect(vendorRes.statusCode).toBe(201);
    const vendorId = vendorRes.json().id as string;

    // Purchase order: 2 @ 100 + 1 @ 50 = 250 major = 25000 minor
    const orderRes = await app.inject({
      method: 'POST',
      url: '/api/procurement/orders',
      headers: auth,
      payload: {
        vendorId,
        currency: 'USD',
        lines: [
          { description: 'Widget', quantity: 2, unitPrice: 100 },
          { description: 'Gadget', quantity: 1, unitPrice: 50 },
        ],
      },
    });
    expect(orderRes.statusCode).toBe(201);
    expect(orderRes.json().totalMinor).toBe(25000);
    const orderId = orderRes.json().id as string;

    // The order detail should carry two lines.
    const detail = await app.inject({ method: 'GET', url: `/api/procurement/orders/${orderId}`, headers: auth });
    expect(detail.json().lines).toHaveLength(2);
    expect(detail.json().totalMinor).toBe(25000);

    // draft → issued is legal
    const issued = await app.inject({
      method: 'POST',
      url: `/api/procurement/orders/${orderId}/transition`,
      headers: auth,
      payload: { to: 'issued' },
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().status).toBe('issued');
  });

  it('blocks an illegal purchase-order transition', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const suffix = Date.now().toString(36) + 'b';

    const vendor = await app.inject({
      method: 'POST', url: '/api/procurement/vendors', headers: auth,
      payload: { code: `VEN-${suffix}`, name: 'Beta Corp' },
    });
    const order = await app.inject({
      method: 'POST', url: '/api/procurement/orders', headers: auth,
      payload: { vendorId: vendor.json().id, currency: 'USD', lines: [{ description: 'Thing', quantity: 1, unitPrice: 10 }] },
    });
    const orderId = order.json().id as string;

    // draft → received is illegal (must go via issued)
    const bad = await app.inject({
      method: 'POST', url: `/api/procurement/orders/${orderId}/transition`, headers: auth,
      payload: { to: 'received' },
    });
    expect(bad.statusCode).toBe(409);
  });
});
