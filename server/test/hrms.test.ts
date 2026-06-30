/**
 * HRMS module integration test (brief §9.14).
 * Mirrors integration.test.ts: dbUp guard, admin token, buildApp/closePools.
 * Flow: create department → create employee → file leave → approve →
 * assert employee status flips to 'on_leave' and department employeeCount ≥ 1.
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

describe('HRMS: departments, employees, leave', () => {
  it('creates a department, employee, leave request and approves it', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const suffix = Date.now().toString(36);

    // Department
    const deptRes = await app.inject({
      method: 'POST',
      url: '/api/hr/departments',
      headers: auth,
      payload: { code: `DEPT-${suffix}`, name: 'Claims Operations', costCentre: 'CC-100' },
    });
    expect(deptRes.statusCode).toBe(201);
    const departmentId = deptRes.json().id as string;

    // Employee in that department
    const empRes = await app.inject({
      method: 'POST',
      url: '/api/hr/employees',
      headers: auth,
      payload: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: `ada-${suffix}@demo.rios`,
        departmentId,
        position: 'Analyst',
        baseSalary: 90000,
        currency: 'USD',
      },
    });
    expect(empRes.statusCode).toBe(201);
    const employeeId = empRes.json().id as string;

    // File a leave request
    const leaveRes = await app.inject({
      method: 'POST',
      url: '/api/hr/leave',
      headers: auth,
      payload: {
        employeeId,
        kind: 'annual',
        startDate: '2026-07-01',
        endDate: '2026-07-05',
        days: 5,
        reason: 'Vacation',
      },
    });
    expect(leaveRes.statusCode).toBe(201);
    expect(leaveRes.json().status).toBe('pending');
    const leaveId = leaveRes.json().id as string;

    // Approve it
    const decideRes = await app.inject({
      method: 'POST',
      url: `/api/hr/leave/${leaveId}/decide`,
      headers: auth,
      payload: { decision: 'approved' },
    });
    expect(decideRes.statusCode).toBe(200);
    expect(decideRes.json().status).toBe('approved');

    // Employee status should now be 'on_leave'
    const detail = await app.inject({
      method: 'GET',
      url: `/api/hr/employees/${employeeId}`,
      headers: auth,
    });
    expect(detail.json().status).toBe('on_leave');

    // Department employeeCount should be at least 1
    const depts = await app.inject({ method: 'GET', url: '/api/hr/departments', headers: auth });
    const dept = depts.json().departments.find((d: { id: string }) => d.id === departmentId);
    expect(Number(dept.employeeCount)).toBeGreaterThanOrEqual(1);
  });

  it('rejects deciding a non-pending leave request', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const suffix = Date.now().toString(36) + 'b';

    const dept = await app.inject({
      method: 'POST', url: '/api/hr/departments', headers: auth,
      payload: { code: `DEPT-${suffix}`, name: 'Underwriting' },
    });
    const emp = await app.inject({
      method: 'POST', url: '/api/hr/employees', headers: auth,
      payload: { firstName: 'Grace', lastName: 'Hopper', departmentId: dept.json().id },
    });
    const leave = await app.inject({
      method: 'POST', url: '/api/hr/leave', headers: auth,
      payload: { employeeId: emp.json().id, kind: 'sick', startDate: '2026-08-01', endDate: '2026-08-02', days: 2 },
    });
    const leaveId = leave.json().id as string;

    await app.inject({ method: 'POST', url: `/api/hr/leave/${leaveId}/decide`, headers: auth, payload: { decision: 'approved' } });
    const again = await app.inject({ method: 'POST', url: `/api/hr/leave/${leaveId}/decide`, headers: auth, payload: { decision: 'rejected' } });
    expect(again.statusCode).toBe(409);
  });
});
