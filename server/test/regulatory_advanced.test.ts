/**
 * Regulatory (advanced) integration test (brief §18.3 / §18.4):
 *   IFRS 17 GMM measurement + CSM roll-forward on a group, and the governed
 *   regulatory-return lifecycle (prepare → retrieve → approve).
 *
 * Requires a migrated + seeded database reachable via DATABASE_URL/DATABASE_APP_URL.
 * Skips cleanly if the DB is unreachable so it never produces a false failure.
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

describe('regulatory advanced: IFRS 17 GMM/VFA + governed returns', () => {
  it('measures GMM and rolls the CSM forward on a group', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Create an IFRS 17 group via the existing endpoint.
    const group = await app.inject({
      method: 'POST',
      url: '/api/regulatory/ifrs17/groups',
      headers: auth,
      payload: { name: `GMM Group ${Date.now()}`, currency: 'USD' },
    });
    expect(group.statusCode).toBe(201);
    const groupId = group.json().id as string;

    // GMM initial measurement: PV(premiums) 1,000,000 vs PV(claims) 700,000 + RA 50,000.
    // FCF = 700,000 − 1,000,000 + 50,000 = −250,000 ⇒ profitable ⇒ CSM = 250,000.
    const gmm = await app.inject({
      method: 'POST',
      url: `/api/regulatory/ifrs17/groups/${groupId}/measure-gmm`,
      headers: auth,
      payload: { presentValueOfPremiums: 1000000, presentValueOfClaims: 700000, riskAdjustment: 50000 },
    });
    expect(gmm.statusCode).toBe(200);
    expect(gmm.json().csmMinor).toBe(25000000); // $250,000.00
    expect(gmm.json().onerous).toBe(false);

    // CSM roll-forward: opening 250,000 + 3% interest = 257,500; release 1/5 = 51,500;
    // closing = 257,500 − 51,500 = 206,000.
    const roll = await app.inject({
      method: 'POST',
      url: `/api/regulatory/ifrs17/groups/${groupId}/csm-rollforward`,
      headers: auth,
      payload: { openingCsm: 250000, interestAccretionRate: 0.03, coverageUnitsThisPeriod: 1, coverageUnitsRemaining: 5 },
    });
    expect(roll.statusCode).toBe(200);
    expect(roll.json().closingCsm).toBe(20600000); // $206,000.00

    // The group's measurements list now carries both rows.
    const list = await app.inject({
      method: 'GET',
      url: `/api/regulatory/ifrs17/groups/${groupId}/measurements`,
      headers: auth,
    });
    expect(list.json().measurements.length).toBeGreaterThanOrEqual(2);
  });

  it('prepares, retrieves and approves a Schedule F return', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const prepared = await app.inject({
      method: 'POST',
      url: '/api/regulatory/returns',
      headers: auth,
      payload: { kind: 'SCHEDULE_F', period: '2026' },
    });
    expect(prepared.statusCode).toBe(201);
    expect(prepared.json().status).toBe('prepared');
    const id = prepared.json().id as string;

    // Retrievable with its generated data.
    const fetched = await app.inject({ method: 'GET', url: `/api/regulatory/returns/${id}`, headers: auth });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().kind).toBe('SCHEDULE_F');
    expect(fetched.json().status).toBe('prepared');
    expect(fetched.json().data).toBeTruthy();

    // Sign-off (§18.4) flips the status to approved.
    const approved = await app.inject({
      method: 'POST',
      url: `/api/regulatory/returns/${id}/approve`,
      headers: auth,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');
  });
});
