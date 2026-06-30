/**
 * Attendance (HRMS): punch in, break, punch out for the signed-in user, the
 * live worked-minutes computation, and the auth gate. Skips cleanly without a DB.
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

describe('Attendance', () => {
  it('runs a punch in -> break -> resume -> punch out cycle', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };

    const inRes = await app.inject({ method: 'POST', url: '/api/attendance/punch-in', headers: auth });
    expect(inRes.statusCode).toBe(200);
    expect(inRes.json().record.status).toBe('present');
    expect(inRes.json().record.punchInAt).toBeTruthy();

    const brk = await app.inject({ method: 'POST', url: '/api/attendance/break/start', headers: auth });
    expect(brk.json().record.onBreak).toBe(true);
    expect(brk.json().record.status).toBe('on_break');

    const resume = await app.inject({ method: 'POST', url: '/api/attendance/break/end', headers: auth });
    expect(resume.json().record.onBreak).toBe(false);
    expect(resume.json().record.status).toBe('present');

    const out = await app.inject({ method: 'POST', url: '/api/attendance/punch-out', headers: auth });
    expect(out.json().record.status).toBe('checked_out');
    expect(out.json().record.punchOutAt).toBeTruthy();
  });

  it('returns today and history for the signed-in user', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/attendance/me', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.today).toBeTruthy();
    expect(typeof body.today.workedMinutes).toBe('number');
    expect(Array.isArray(body.history)).toBe(true);
  });

  it('rejects an unauthenticated punch', async () => {
    if (!dbUp) return;
    const res = await app.inject({ method: 'POST', url: '/api/attendance/punch-in' });
    expect(res.statusCode).toBe(401);
  });
});
