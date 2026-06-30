/**
 * Employee self-service workspace: the personal-dashboard data (leave balance,
 * holidays, birthdays, announcements). Skips cleanly without a DB.
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

describe('Employee workspace', () => {
  it('returns the personal dashboard payload for the admin (linked employee)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/me/workspace', headers: auth });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.hasEmployee).toBe(true);
    expect(b.leaveBalance.entitlement).toBe(20);
    expect(b.leaveBalance.remaining).toBeLessThanOrEqual(20);
    expect(Array.isArray(b.upcomingHolidays)).toBe(true);
    expect(b.upcomingHolidays.length).toBeGreaterThan(0);
    expect(Array.isArray(b.announcements)).toBe(true);
    expect(b.announcements.length).toBeGreaterThan(0);
  });

  it('requires authentication', async () => {
    if (!dbUp) return;
    const res = await app.inject({ method: 'GET', url: '/api/me/workspace' });
    expect(res.statusCode).toBe(401);
  });
});
