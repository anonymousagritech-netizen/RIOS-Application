/**
 * Scheduler / job orchestration (brief §3). Lists seeded jobs, runs one (which
 * records a run and advances the schedule), reads its history, and checks the
 * permission gate. Skips cleanly without a DB.
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

describe('Scheduler', () => {
  it('lists seeded jobs with due flags, then runs one and records history', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };

    const list = await app.inject({ method: 'GET', url: '/api/scheduler/jobs', headers: auth });
    expect(list.statusCode).toBe(200);
    // A disabled job is never due (stable regardless of prior runs).
    const archive = list.json().jobs.find((j: { key: string }) => j.key === 'audit-archive');
    expect(archive.enabled).toBe(false);
    expect(archive.due).toBe(false);

    const fx = list.json().jobs.find((j: { key: string }) => j.key === 'fx-refresh');
    expect(fx).toBeTruthy();

    const run = await app.inject({ method: 'POST', url: `/api/scheduler/jobs/${fx.id}/run`, headers: auth });
    expect(run.statusCode).toBe(200);
    expect(run.json().runId).toBeTruthy();

    const runs = await app.inject({ method: 'GET', url: `/api/scheduler/jobs/${fx.id}/runs`, headers: auth });
    expect(runs.json().runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.json().runs[0].status).toBe('success');
  });

  it('forbids running a job without ops:write', async () => {
    if (!dbUp) return;
    const adminAuth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/scheduler/jobs', headers: adminAuth });
    const anyId = list.json().jobs[0].id;

    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: `/api/scheduler/jobs/${anyId}/run`, headers: auth });
    expect(res.statusCode).toBe(403);
  });
});
