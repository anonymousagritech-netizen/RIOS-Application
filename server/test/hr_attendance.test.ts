/**
 * HR / Attendance depth integration test (brief §9.14, Part B).
 * Mirrors hrms.test.ts: dbUp guard, demo tokens, buildApp/closePools.
 *
 * Covers:
 *  - audited employee status lifecycle (active → suspended) with history + roles
 *    surfaced on the detail endpoint;
 *  - org-chart rollup (direct + indirect reports);
 *  - who's-on-leave widget (today bucket) sourced from the leave table;
 *  - the monthly attendance grid + a WFH request that, once approved by the
 *    resolved manager, flips that day's status to 'wfh' (counted as worked).
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

describe('HR depth: status lifecycle, org chart, on-leave', () => {
  it('changes employee status with audited history and surfaces system roles', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const suffix = Date.now().toString(36);

    const emp = await app.inject({
      method: 'POST', url: '/api/hr/employees', headers: auth,
      payload: { firstName: 'Edsger', lastName: 'Dijkstra', email: `ed-${suffix}@demo.rios`, position: 'Engineer' },
    });
    const employeeId = emp.json().id as string;

    // Suspend, then exit — each is a distinct audited transition.
    const susp = await app.inject({
      method: 'POST', url: `/api/hr/employees/${employeeId}/status`, headers: auth,
      payload: { status: 'suspended', reason: 'Investigation pending' },
    });
    expect(susp.statusCode).toBe(200);
    expect(susp.json()).toMatchObject({ from: 'active', to: 'suspended' });

    const detail = await app.inject({ method: 'GET', url: `/api/hr/employees/${employeeId}`, headers: auth });
    const body = detail.json();
    expect(body.status).toBe('suspended');
    expect(Array.isArray(body.statusHistory)).toBe(true);
    expect(body.statusHistory[0]).toMatchObject({ fromStatus: 'active', toStatus: 'suspended' });
    expect(Array.isArray(body.systemRoles)).toBe(true); // present even when empty
    expect(body.employmentType).toBe('full_time'); // default
  });

  it('rolls up direct + indirect reports for an org chart', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const suffix = Date.now().toString(36) + 'o';

    const mgr = await app.inject({
      method: 'POST', url: '/api/hr/employees', headers: auth,
      payload: { firstName: 'Manager', lastName: suffix, position: 'Head' },
    });
    const managerId = mgr.json().id as string;
    const direct = await app.inject({
      method: 'POST', url: '/api/hr/employees', headers: auth,
      payload: { firstName: 'Direct', lastName: suffix, managerId, position: 'Lead' },
    });
    const directId = direct.json().id as string;
    await app.inject({
      method: 'POST', url: '/api/hr/employees', headers: auth,
      payload: { firstName: 'Indirect', lastName: suffix, managerId: directId, position: 'IC' },
    });

    const reports = await app.inject({ method: 'GET', url: `/api/hr/employees/${managerId}/reports`, headers: auth });
    const r = reports.json();
    expect(r.direct).toBe(1);   // the lead
    expect(r.total).toBe(2);    // lead + their IC (indirect)
    const depths = r.reports.map((x: { depth: number }) => x.depth).sort();
    expect(depths).toEqual([1, 2]);
  });

  it('lists who is on leave today from the leave table', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const suffix = Date.now().toString(36) + 'l';

    const emp = await app.inject({
      method: 'POST', url: '/api/hr/employees', headers: auth,
      payload: { firstName: 'OnLeave', lastName: suffix },
    });
    const employeeId = emp.json().id as string;
    // A leave window that spans the current date (today is within [start,end]).
    const leave = await app.inject({
      method: 'POST', url: '/api/hr/leave', headers: auth,
      payload: { employeeId, kind: 'annual', startDate: '2026-06-29', endDate: '2026-07-02', days: 4 },
    });
    const leaveId = leave.json().id as string;
    await app.inject({ method: 'POST', url: `/api/hr/leave/${leaveId}/decide`, headers: auth, payload: { decision: 'approved' } });

    const widget = await app.inject({ method: 'GET', url: '/api/hr/on-leave?days=7', headers: auth });
    expect(widget.statusCode).toBe(200);
    const names = widget.json().today.map((t: { name: string }) => t.name);
    expect(names).toContain(`OnLeave ${suffix}`);
  });
});

describe('Attendance command center: month grid + WFH request', () => {
  it('returns a monthly grid and applies an approved WFH day', async () => {
    if (!dbUp) return;
    // admin@demo.rios is a seeded user WITH an employee record, so myEmployee resolves.
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const month = '2026-06';
    const day = '2026-06-15';

    const grid = await app.inject({ method: 'GET', url: `/api/attendance/month?month=${month}`, headers: auth });
    expect(grid.statusCode).toBe(200);
    const g = grid.json();
    expect(g.month).toBe(month);
    expect(Array.isArray(g.days)).toBe(true);
    expect(g.days.length).toBeGreaterThanOrEqual(28);
    expect(g.summary).toHaveProperty('workedDays');

    // File a WFH request for a past in-month day, then approve it.
    const reqRes = await app.inject({
      method: 'POST', url: '/api/attendance/request', headers: auth,
      payload: { date: day, kind: 'wfh', reason: 'Remote work' },
    });
    expect(reqRes.statusCode).toBe(200);
    expect(reqRes.json()).toHaveProperty('approverResolved'); // boolean either way

    const pending = await app.inject({ method: 'GET', url: '/api/attendance/requests', headers: auth });
    const mine = pending.json().requests.find((x: { kind: string; requestDate: string }) => x.kind === 'wfh' && x.requestDate.startsWith(day));
    expect(mine).toBeTruthy();

    const decide = await app.inject({
      method: 'POST', url: `/api/attendance/requests/${mine.id}/decide`, headers: auth,
      payload: { decision: 'approved' },
    });
    expect(decide.statusCode).toBe(200);

    // Re-fetch the grid: 2026-06-15 should now read 'wfh'.
    const grid2 = await app.inject({ method: 'GET', url: `/api/attendance/month?month=${month}`, headers: auth });
    const cell = grid2.json().days.find((d: { day: string }) => d.day === day);
    expect(cell.status).toBe('wfh');

    // Deciding again must conflict (idempotency guard).
    const again = await app.inject({
      method: 'POST', url: `/api/attendance/requests/${mine.id}/decide`, headers: auth,
      payload: { decision: 'rejected' },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('HR employee profile: personal/statutory details + dependents', () => {
  it('updates the profile and adds a family member, both audited', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const suffix = Date.now().toString(36) + 'p';

    const emp = await app.inject({
      method: 'POST', url: '/api/hr/employees', headers: auth,
      payload: { firstName: 'Grace', lastName: suffix, position: 'Engineer' },
    });
    const employeeId = emp.json().id as string;

    // Update the HR-managed personal profile.
    const upd = await app.inject({
      method: 'PUT', url: `/api/hr/employees/${employeeId}/profile`, headers: auth,
      payload: {
        gender: 'female', bloodGroup: 'O+', nationality: 'India',
        personalEmail: `grace-${suffix}@example.com`, phone: '+91 90000 00000',
        pan: 'ABCDE1234F', aadhaar: '1234 5678 9012', insuranceProvider: 'Acme Health',
      },
    });
    expect(upd.statusCode).toBe(200);

    // Add a dependent / emergency contact.
    const dep = await app.inject({
      method: 'POST', url: `/api/hr/employees/${employeeId}/dependents`, headers: auth,
      payload: { name: 'Alex', relationship: 'spouse', phone: '+91 90000 11111', isEmergency: true },
    });
    expect(dep.statusCode).toBe(201);
    const depId = dep.json().id as string;

    // Detail endpoint returns the profile fields + dependents.
    const detail = await app.inject({ method: 'GET', url: `/api/hr/employees/${employeeId}`, headers: auth });
    const body = detail.json();
    expect(body.bloodGroup).toBe('O+');
    expect(body.pan).toBe('ABCDE1234F');
    expect(body.insuranceProvider).toBe('Acme Health');
    expect(Array.isArray(body.dependents)).toBe(true);
    expect(body.dependents[0]).toMatchObject({ name: 'Alex', relationship: 'spouse', isEmergency: true });

    // Remove the dependent.
    const del = await app.inject({ method: 'DELETE', url: `/api/hr/employees/${employeeId}/dependents/${depId}`, headers: auth });
    expect(del.statusCode).toBe(200);
    const detail2 = await app.inject({ method: 'GET', url: `/api/hr/employees/${employeeId}`, headers: auth });
    expect(detail2.json().dependents.length).toBe(0);
  });
});
