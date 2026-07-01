/**
 * Task management & SLA integration tests. dbUp guard + demo token.
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

describe('Task management', () => {
  it('creates, lists, summarises and completes tasks with SLA', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };

    const create = await app.inject({
      method: 'POST', url: '/api/tasks', headers: auth,
      payload: { title: 'Review CAT XL slip', kind: 'REVIEW', priority: 'HIGH', dueAt: '2020-01-01T00:00:00Z' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;

    const list = await app.inject({ method: 'GET', url: '/api/tasks', headers: auth });
    expect(list.statusCode).toBe(200);
    const task = list.json().tasks.find((t: { id: string }) => t.id === id);
    expect(task).toBeTruthy();
    expect(task.sla).toBe('OVERDUE'); // due 2020 is in the past

    const summary = await app.inject({ method: 'GET', url: '/api/tasks/summary', headers: auth });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toHaveProperty('overdue');
    expect(summary.json().overdue).toBeGreaterThanOrEqual(1);

    const done = await app.inject({ method: 'POST', url: `/api/tasks/${id}/status`, headers: auth, payload: { status: 'DONE' } });
    expect(done.statusCode).toBe(200);
    const list2 = await app.inject({ method: 'GET', url: '/api/tasks?status=DONE', headers: auth });
    expect(list2.json().tasks.some((t: { id: string; sla: string }) => t.id === id && t.sla === 'DONE')).toBe(true);
  });

  it('gates writes on ops:write (403 for a non-ops user)', async () => {
    if (!dbUp) return;
    // uw@demo has treaty perms but not ops:write.
    const uw = { authorization: `Bearer ${await token('uw@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: uw, payload: { title: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});
