/**
 * Period-close & FX-revaluation integration test (brief §9.8, §7.6).
 *
 * Opens a period, closes it (and proves the re-close guard), then runs an FX
 * revaluation of a EUR balance and asserts the gain in USD minor units. Skips
 * cleanly if Postgres is unreachable.
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

describe('period close & FX revaluation', () => {
  it('opens then closes a period; a re-close is a 409', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/finance/periods',
      headers: auth,
      payload: { code: `PC-${Date.now()}`, startDate: '2026-06-01', endDate: '2026-06-30' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const closed = await app.inject({
      method: 'POST',
      url: `/api/finance/periods/${id}/close`,
      headers: auth,
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('closed');

    const reClose = await app.inject({
      method: 'POST',
      url: `/api/finance/periods/${id}/close`,
      headers: auth,
    });
    expect(reClose.statusCode).toBe(409);
  });

  it('revalues a EUR balance and books the USD gain', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/finance/fx-revalue',
      headers: auth,
      payload: {
        baseCurrency: 'USD',
        balances: [{ currency: 'EUR', amount: 1000, bookedRate: 1.08, currentRate: 1.12 }],
      },
    });
    expect(res.statusCode).toBe(201);
    // EUR 1,000 @ 1.12 − @ 1.08 = USD 40.00 = 4000 minor.
    expect(res.json().gainLossMinor).toBe(4000);
    expect(res.json().detail.length).toBe(1);
  });
});

describe('period close: governed orchestration, checklist, lock and reopen', () => {
  it('opens a close with the standard checklist seeded PENDING', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const opened = await app.inject({
      method: 'POST',
      url: '/api/period-close',
      headers: auth,
      payload: { period: '2026-Q1', periodStart: '2026-01-01', periodEnd: '2026-03-31' },
    });
    expect(opened.statusCode).toBe(201);
    const body = opened.json();
    expect(body.status).toBe('OPEN');
    const keys = (body.steps as Array<{ stepKey: string; status: string }>).map((s) => s.stepKey);
    expect(keys).toEqual(['UPR_DAC', 'SOA_VERIFY', 'FX_REVAL', 'GL_TIE_OUT']);
    expect((body.steps as Array<{ status: string }>).every((s) => s.status === 'PENDING')).toBe(true);
  });

  it('runs the full checklist against the real engines, gates the lock, and reopens', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const opened = await app.inject({
      method: 'POST',
      url: '/api/period-close',
      headers: auth,
      payload: { period: '2026-Q2', periodStart: '2026-04-01', periodEnd: '2026-06-30' },
    });
    const closeId = opened.json().id as string;

    // Lock is refused (409) while steps are still PENDING.
    const earlyLock = await app.inject({ method: 'POST', url: `/api/period-close/${closeId}/lock`, headers: auth });
    expect(earlyLock.statusCode).toBe(409);
    expect((earlyLock.json().outstanding as unknown[]).length).toBeGreaterThan(0);

    // UPR_DAC calls the real UPR run and records its run id + summary.
    const upr = await app.inject({
      method: 'POST',
      url: `/api/period-close/${closeId}/run-step`,
      headers: auth,
      payload: { stepKey: 'UPR_DAC' },
    });
    expect(upr.statusCode).toBe(200);
    expect(upr.json().status).toBe('DONE');
    const uprDetail = upr.json().detail as { engine: string; uprRunId: string; lineCount: number };
    expect(uprDetail.engine).toBe('POST /api/accounting/upr/run');
    expect(typeof uprDetail.uprRunId).toBe('string');
    expect(typeof uprDetail.lineCount).toBe('number');

    // The recorded run id is a real UPR run fetchable from the earnings engine.
    const runFetch = await app.inject({
      method: 'GET',
      url: `/api/accounting/upr/runs/${uprDetail.uprRunId}`,
      headers: auth,
    });
    expect(runFetch.statusCode).toBe(200);
    expect(runFetch.json().id).toBe(uprDetail.uprRunId);

    // Running one step moves the close to IN_PROGRESS.
    const midView = await app.inject({ method: 'GET', url: `/api/period-close/${closeId}`, headers: auth });
    expect(midView.json().status).toBe('IN_PROGRESS');

    // SOA_VERIFY calls the real verifier for statements in the period.
    const soa = await app.inject({
      method: 'POST',
      url: `/api/period-close/${closeId}/run-step`,
      headers: auth,
      payload: { stepKey: 'SOA_VERIFY' },
    });
    expect(soa.statusCode).toBe(200);
    expect(soa.json().status).toBe('DONE');
    expect((soa.json().detail as { engine: string }).engine).toBe('POST /api/statements/:id/verify');

    // FX_REVAL is honestly SKIPPED (auto balance gathering into the close is a follow-on).
    const fx = await app.inject({
      method: 'POST',
      url: `/api/period-close/${closeId}/run-step`,
      headers: auth,
      payload: { stepKey: 'FX_REVAL' },
    });
    expect(fx.statusCode).toBe(200);
    expect(fx.json().status).toBe('SKIPPED');
    expect((fx.json().detail as { note: string }).note).toMatch(/not wired|follow-on/i);

    // Lock is still refused: GL_TIE_OUT is not done yet.
    const stillLocked = await app.inject({ method: 'POST', url: `/api/period-close/${closeId}/lock`, headers: auth });
    expect(stillLocked.statusCode).toBe(409);

    // GL_TIE_OUT calls the real trial balance and proves it balances.
    const gl = await app.inject({
      method: 'POST',
      url: `/api/period-close/${closeId}/run-step`,
      headers: auth,
      payload: { stepKey: 'GL_TIE_OUT' },
    });
    expect(gl.statusCode).toBe(200);
    expect(gl.json().status).toBe('DONE');
    expect((gl.json().detail as { balanced: boolean }).balanced).toBe(true);

    // Now every non-SKIPPED step is DONE: the lock succeeds.
    const lock = await app.inject({ method: 'POST', url: `/api/period-close/${closeId}/lock`, headers: auth });
    expect(lock.statusCode).toBe(200);
    expect(lock.json().status).toBe('LOCKED');

    // A LOCKED close cannot run further steps.
    const afterLock = await app.inject({
      method: 'POST',
      url: `/api/period-close/${closeId}/run-step`,
      headers: auth,
      payload: { stepKey: 'GL_TIE_OUT' },
    });
    expect(afterLock.statusCode).toBe(409);

    // Reopen requires a reason and moves LOCKED -> REOPENED.
    const noReason = await app.inject({ method: 'POST', url: `/api/period-close/${closeId}/reopen`, headers: auth, payload: {} });
    expect(noReason.statusCode).toBe(400);

    const reopen = await app.inject({
      method: 'POST',
      url: `/api/period-close/${closeId}/reopen`,
      headers: auth,
      payload: { reason: 'late adjustment received from cedent' },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json().status).toBe('REOPENED');

    const finalView = await app.inject({ method: 'GET', url: `/api/period-close/${closeId}`, headers: auth });
    expect(finalView.json().status).toBe('REOPENED');
    expect(finalView.json().reopenReason).toBe('late adjustment received from cedent');
  });

  it('validates input and 404s unknown closes/steps', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const bad = await app.inject({
      method: 'POST',
      url: '/api/period-close',
      headers: auth,
      payload: { period: '2026-Q3', periodStart: 'not-a-date', periodEnd: '2026-09-30' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/period-close/00000000-0000-0000-0000-000000000000/run-step',
      headers: auth,
      payload: { stepKey: 'UPR_DAC' },
    });
    expect(missing.statusCode).toBe(404);

    const opened = await app.inject({
      method: 'POST',
      url: '/api/period-close',
      headers: auth,
      payload: { period: '2026-Q4', periodStart: '2026-10-01', periodEnd: '2026-12-31' },
    });
    const closeId = opened.json().id as string;
    const unknownStep = await app.inject({
      method: 'POST',
      url: `/api/period-close/${closeId}/run-step`,
      headers: auth,
      payload: { stepKey: 'NOPE' },
    });
    expect(unknownStep.statusCode).toBe(404);
  });
});
