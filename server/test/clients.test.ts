/**
 * Client 360 + notifications integration tests. dbUp guard + demo token.
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

describe('Client 360', () => {
  it('lists clients with roles and returns a 360 with a contact write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/clients', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().clients)).toBe(true);
    expect(Array.isArray(list.json().roles)).toBe(true);
    const id = list.json().clients[0]?.id as string | undefined;
    if (id) {
      const detail = await app.inject({ method: 'GET', url: `/api/clients/${id}`, headers: auth });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toHaveProperty('roles');
      expect(detail.json()).toHaveProperty('submissions');
      const c = await app.inject({ method: 'POST', url: `/api/clients/${id}/contacts`, headers: auth, payload: { kind: 'email', value: 'ops@example.com', label: 'Ops' } });
      expect(c.statusCode).toBe(200);
    }
  });
});

describe('Notifications', () => {
  it('surfaces a referral notification and supports unread-count + read-all', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    // Create a HIGH-risk submission and raise a referral → notification.
    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: { title: 'Notify referral cat', structure: 'CAT_XL', lossRatioPct: 95, catExposed: true, classHazard: 5, priorClaims: 4 },
    });
    const sid = create.json().id as string;
    await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${sid}/approvals`, headers: auth, payload: {} });

    const count = await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: auth });
    expect(count.statusCode).toBe(200);
    expect(count.json().count).toBeGreaterThanOrEqual(1);

    const list = await app.inject({ method: 'GET', url: '/api/notifications', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().notifications.some((n: { kind: string }) => n.kind === 'REFERRAL')).toBe(true);

    const readAll = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: auth, payload: {} });
    expect(readAll.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: auth });
    expect(after.json().count).toBe(0);
  });
});
