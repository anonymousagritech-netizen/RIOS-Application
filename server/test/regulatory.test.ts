/**
 * Regulatory module integration test (brief §18.1 IFRS 17 PAA, §18.2 Solvency II).
 *
 * Proves the IFRS 17 PAA measurement and the Solvency II SCR aggregation return
 * the same numbers the @rios/domain unit tests prove correct, through the full
 * authenticated HTTP path. Skips cleanly when Postgres is unreachable.
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

describe('regulatory: IFRS 17 PAA & Solvency II', () => {
  it('measures an IFRS 17 PAA group with the proven domain numbers', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/regulatory/ifrs17/groups',
      headers: auth,
      payload: { name: `IFRS17 ${Date.now()}`, currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const measured = await app.inject({
      method: 'POST',
      url: `/api/regulatory/ifrs17/groups/${id}/measure`,
      headers: auth,
      payload: {
        premiumReceived: 1000000,
        acquisitionCashFlows: 100000,
        coverageElapsed: 0.25,
        expectedClaims: 1000000,
        discountFactor: 0.95,
        riskAdjustmentPct: 0.06,
      },
    });
    const body = measured.json();
    expect(body.lrc).toBe(67500000);
    expect(body.lic).toBe(100700000);

    const fetched = await app.inject({ method: 'GET', url: `/api/regulatory/ifrs17/groups/${id}`, headers: auth });
    expect(fetched.json().measurements.length).toBeGreaterThanOrEqual(1);
  });

  it('aggregates a Solvency II SCR from two uncorrelated modules', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const run = await app.inject({
      method: 'POST',
      url: '/api/regulatory/solvency2/run',
      headers: auth,
      payload: {
        currency: 'USD',
        modules: [
          { name: 'market', scr: 30 },
          { name: 'underwriting', scr: 40 },
        ],
        correlation: [
          [1, 0],
          [0, 1],
        ],
        operationalRisk: 10,
        linearMcr: 20,
        absoluteFloor: 4,
        ownFunds: 120,
      },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();
    expect(body.basicScr).toBeCloseTo(50, 6); // sqrt(30^2 + 40^2)
    expect(body.scr).toBeCloseTo(60, 6); // basic 50 + operational 10

    const runs = await app.inject({ method: 'GET', url: '/api/regulatory/solvency2/runs', headers: auth });
    expect(runs.json().runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.json().runs[0].modules.length).toBe(2);
  });
});
