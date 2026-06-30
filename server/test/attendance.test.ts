/**
 * Attendance (HRMS): punch in, break, punch out for the signed-in user, the
 * live worked-minutes computation, and the auth gate. Skips cleanly without a DB.
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

  it('geofences punches once an office is configured, and exports CSV', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };

    // Create an office at London; admin has admin:manage so hr:write passes.
    const office = await app.inject({
      method: 'POST', url: '/api/attendance/offices', headers: auth,
      payload: { name: 'Test HQ', latitude: 51.5, longitude: -0.12, radiusMeters: 150, bufferMeters: 50 },
    });
    expect(office.statusCode).toBe(201);

    // A punch ~1.1 km away is outside radius+buffer -> rejected.
    const far = await app.inject({
      method: 'POST', url: '/api/attendance/punch-in', headers: auth,
      payload: { lat: 51.51, lng: -0.12 },
    });
    expect(far.statusCode).toBe(403);

    // A punch within the buffer is accepted and flagged geofence_ok.
    const near = await app.inject({
      method: 'POST', url: '/api/attendance/punch-in', headers: auth,
      payload: { lat: 51.5005, lng: -0.12 },
    });
    expect(near.statusCode).toBe(200);
    expect(near.json().record.geofenceOk).toBe(true);

    // CSV export returns text with a header row.
    const csv = await app.inject({ method: 'GET', url: '/api/attendance/export', headers: auth });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toContain('Employee');

    // Clean up so other tests/punches are not geofenced.
    await ownerQuery('delete from office_location');
  });
});
