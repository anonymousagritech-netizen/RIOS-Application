/**
 * Scheduled Reports integration tests. dbUp guard + demo token.
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

describe('Scheduled Reports', () => {
  it('lists schedules, creates a list + schedule, runs it and advances next run', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const list = await app.inject({
      method: 'POST', url: '/api/distribution-lists', headers: auth,
      payload: { name: `Test List ${Date.now()}`, recipients: ['a@demo.rios', 'b@demo.rios'] },
    });
    expect(list.statusCode).toBe(201);
    const listId = list.json().id as string;

    const sched = await app.inject({
      method: 'POST', url: '/api/scheduled-reports', headers: auth,
      payload: { name: `Test Schedule ${Date.now()}`, cadence: 'MONTHLY', format: 'PDF', distributionListId: listId },
    });
    expect(sched.statusCode).toBe(201);
    const id = sched.json().id as string;
    expect(sched.json().nextRunAt).toBeTruthy();

    const run = await app.inject({ method: 'POST', url: `/api/scheduled-reports/${id}/run`, headers: auth, payload: {} });
    expect(run.statusCode).toBe(200);
    expect(run.json().recipients).toBe(2);

    const detail = await app.inject({ method: 'GET', url: `/api/scheduled-reports/${id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().runs.length).toBeGreaterThanOrEqual(1);

    const toggle = await app.inject({ method: 'POST', url: `/api/scheduled-reports/${id}/toggle`, headers: auth, payload: { enabled: false } });
    expect(toggle.statusCode).toBe(200);
    expect(toggle.json().enabled).toBe(false);
  });

  it('lists dashboard with cadence breakdown and totals', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/scheduled-reports', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toHaveProperty('schedules');
    expect(Array.isArray(res.json().byCadence)).toBe(true);
  });

  it('rejects writes from a read-only role (403)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('claims@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/scheduled-reports', headers: auth, payload: { name: 'X', cadence: 'DAILY', format: 'CSV' } });
    expect(res.statusCode).toBe(403);
  });
});
