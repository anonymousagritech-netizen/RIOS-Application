/**
 * Performance management (brief §14). Reads the seeded review and creates one,
 * checking the overall rating is computed from the weighted goals, plus the
 * permission gate. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;
let acctEmpId = '';

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
  const r = await ownerQuery<{ id: string }>(`select id from employee where employee_no = 'EMP-90002'`);
  acctEmpId = r.rows[0]!.id;
});
afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('Performance management', () => {
  it('lists the seeded review with its computed overall', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/performance/reviews', headers: auth });
    expect(res.statusCode).toBe(200);
    const fy = res.json().reviews.find((r: { period: string }) => r.period === 'FY2026');
    expect(Number(fy.overallScore)).toBeCloseTo(3.83, 2);
    expect(fy.band).toBe('meets');
  });

  it('computes the overall rating from weighted goals on create', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/performance/reviews', headers: auth,
      payload: {
        employeeId: acctEmpId, period: 'FY2026-TEST', status: 'draft',
        goals: [{ title: 'A', weight: 2, score: 4 }, { title: 'B', weight: 1, score: 1 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().overallScore).toBe(3); // (8+1)/3
    expect(res.json().band).toBe('meets');
    await ownerQuery(`delete from performance_review where period = 'FY2026-TEST'`);
  });

  it('forbids authoring without hr:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/performance/reviews', headers: auth,
      payload: { employeeId: acctEmpId, period: 'X', goals: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
