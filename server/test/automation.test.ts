/**
 * Automation module integration test (brief §9.3, §14.1).
 *
 * Exercises the approval maker-checker flow (with requester notification) and the
 * workflow instance/task runtime through the authenticated HTTP path. Skips
 * cleanly when Postgres is unreachable.
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

describe('automation: approvals & workflow', () => {
  it('creates and approves an approval, notifying the requester', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/approvals',
      headers: auth,
      payload: { entityType: 'contract', action: 'bind', payload: { note: 'please review' } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const decided = await app.inject({
      method: 'POST',
      url: `/api/approvals/${id}/decide`,
      headers: auth,
      payload: { decision: 'approved', note: 'ok' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('approved');

    // A second decision must conflict.
    const again = await app.inject({
      method: 'POST',
      url: `/api/approvals/${id}/decide`,
      headers: auth,
      payload: { decision: 'rejected' },
    });
    expect(again.statusCode).toBe(409);

    // The requester (admin) received an in-app notification of the decision.
    const notifs = await app.inject({ method: 'GET', url: '/api/notifications', headers: auth });
    const list = notifs.json().notifications as Array<{ subject: string }>;
    expect(list.some((n) => n.subject === 'Approval approved')).toBe(true);
  });

  it('runs a workflow instance with a task to completion', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const inst = await app.inject({
      method: 'POST',
      url: '/api/workflow/instances',
      headers: auth,
      payload: { workflowKey: 'binding', entityType: 'contract', currentState: 'review' },
    });
    expect(inst.statusCode).toBe(201);
    const instanceId = inst.json().id as string;

    const task = await app.inject({
      method: 'POST',
      url: `/api/workflow/instances/${instanceId}/tasks`,
      headers: auth,
      payload: { name: 'Underwriter review' },
    });
    expect(task.statusCode).toBe(201);
    const taskId = task.json().id as string;

    const done = await app.inject({
      method: 'POST',
      url: `/api/workflow/tasks/${taskId}/complete`,
      headers: auth,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('done');

    const list = await app.inject({
      method: 'GET',
      url: `/api/workflow/instances?entityType=contract`,
      headers: auth,
    });
    const found = (list.json().instances as Array<{ id: string; tasks: Array<{ id: string; status: string }> }>).find(
      (i) => i.id === instanceId,
    );
    expect(found?.tasks.find((t) => t.id === taskId)?.status).toBe('done');
  });
});
