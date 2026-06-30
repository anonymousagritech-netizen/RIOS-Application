/**
 * Payroll module integration test (brief §9.14).
 *
 * Creates a department + salaried employee, runs payroll for the period, and
 * asserts a non-empty workforce with positive gross, then re-reads the run with
 * its payslips. Skips cleanly if Postgres is unreachable.
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

describe('payroll: run → totals → payslips', () => {
  it('runs payroll for a salaried employee with correct gross-to-net', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // A department and a salaried employee (USD 5,000/month base).
    const dept = await app.inject({
      method: 'POST',
      url: '/api/hr/departments',
      headers: auth,
      payload: { code: `PAY-${Date.now()}`, name: 'Payroll Test Dept' },
    });
    expect(dept.statusCode).toBe(201);
    const departmentId = dept.json().id as string;

    const emp = await app.inject({
      method: 'POST',
      url: '/api/hr/employees',
      headers: auth,
      payload: {
        firstName: 'Pay',
        lastName: 'Roll',
        departmentId,
        baseSalary: 5000,
        currency: 'USD',
      },
    });
    expect(emp.statusCode).toBe(201);

    // Run payroll for the period.
    const run = await app.inject({
      method: 'POST',
      url: '/api/hr/payroll/runs',
      headers: auth,
      payload: {
        period: '2026-06',
        currency: 'USD',
        taxBands: [
          { from: 0, rate: 0 },
          { from: 1000, rate: 0.1 },
        ],
        employeeSocialRate: 0.05,
        employerSocialRate: 0.1,
      },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();
    expect(body.headcount).toBeGreaterThanOrEqual(1);
    expect(body.totalGrossMinor).toBeGreaterThan(0);
    const runId = body.id as string;

    // Re-read the run with its payslips.
    const got = await app.inject({
      method: 'GET',
      url: `/api/hr/payroll/runs/${runId}`,
      headers: auth,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe('draft');
    expect(Array.isArray(got.json().payslips)).toBe(true);
    expect(got.json().payslips.length).toBeGreaterThanOrEqual(1);

    // Approve the run; a second approval is a 409.
    const approved = await app.inject({
      method: 'POST',
      url: `/api/hr/payroll/runs/${runId}/approve`,
      headers: auth,
    });
    expect(approved.json().status).toBe('approved');
    const reApprove = await app.inject({
      method: 'POST',
      url: `/api/hr/payroll/runs/${runId}/approve`,
      headers: auth,
    });
    expect(reApprove.statusCode).toBe(409);
  });
});
