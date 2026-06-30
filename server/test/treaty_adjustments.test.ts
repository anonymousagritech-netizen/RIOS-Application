/**
 * Treaty-adjustments integration test (brief §7.2, §28.3):
 *   create treaty (with terms) → bind → profit commission → portfolio transfer →
 *   endorsement. Proves the depth routes persist and that the money figures match
 *   the @rios/domain unit-tested calculations.
 *
 * Requires a migrated + seeded database reachable via DATABASE_URL/DATABASE_APP_URL.
 * Skips cleanly if the DB is unreachable so it never produces a false failure in an
 * environment without PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { treatyAdjustmentsModule } from '../src/modules/treatyAdjustments.js';

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

describe('treaty adjustments: profit commission, portfolio transfer, endorsement', () => {
  it('runs profit commission and books the correct profit-commission amount', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'PC Adjustment Treaty',
        basis: 'PROPORTIONAL',
        proportionalType: 'QUOTA_SHARE',
        currency: 'USD',
        terms: { cededShare: 0.3, currency: 'USD' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // DRAFT → QUOTED → BOUND.
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    const bound = await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
    expect(bound.json().status).toBe('BOUND');

    // profit = 1,000,000 − 250,000 − 50,000 (5% allowable) − 400,000 = 300,000.
    // PC = 300,000 × 20% = 60,000 → 6,000,000 minor.
    const pc = await app.inject({
      method: 'POST',
      url: `/api/treaties/${id}/profit-commission`,
      headers: auth,
      payload: { cededPremium: 1000000, commissionPaid: 250000, incurredLosses: 400000, allowableExpensesPct: 5, ratePct: 20 },
    });
    expect(pc.statusCode).toBe(200);
    expect(pc.json().profitCommissionMinor).toBe(6_000_000);

    // The run persists and is listed.
    const list = await app.inject({ method: 'GET', url: `/api/treaties/${id}/profit-commission`, headers: auth });
    expect(list.json().runs.length).toBeGreaterThan(0);
    expect(list.json().runs[0].profitCommissionMinor).toBe(6_000_000);
  });

  it('runs a portfolio-transfer entry and persists it', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Portfolio Transfer Treaty',
        basis: 'PROPORTIONAL',
        proportionalType: 'QUOTA_SHARE',
        currency: 'USD',
        terms: { cededShare: 0.3, currency: 'USD' },
      },
    });
    const id = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });

    // entry: premiumTransfer = 35% × 200,000 = 70,000; lossTransfer = 90% × 100,000 = 90,000.
    const pt = await app.inject({
      method: 'POST',
      url: `/api/treaties/${id}/portfolio-transfer`,
      headers: auth,
      payload: { direction: 'entry', unearnedPremium: 200000, outstandingLosses: 100000, premiumPct: 35, lossPct: 90 },
    });
    expect(pt.statusCode).toBe(200);
    expect(pt.json().premiumTransferMinor).toBe(7_000_000); // $70,000
    expect(pt.json().lossTransferMinor).toBe(9_000_000); // $90,000
    expect(pt.json().netTransferMinor).toBe(-2_000_000); // 70,000 − 90,000 = −20,000
    expect(pt.json().id).toBeTruthy();
  });

  it('endorses a treaty with an incrementing endorsement number', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Endorsement Treaty',
        basis: 'PROPORTIONAL',
        proportionalType: 'QUOTA_SHARE',
        currency: 'USD',
        terms: { cededShare: 0.3, currency: 'USD' },
      },
    });
    const id = created.json().id as string;

    const e1 = await app.inject({
      method: 'POST',
      url: `/api/treaties/${id}/endorse`,
      headers: auth,
      payload: { description: 'First endorsement', changes: { terms: { cededShare: 0.35 } } },
    });
    expect(e1.statusCode).toBe(200);
    expect(e1.json().endorsementNo).toBe(1);
    expect(e1.json().termSetVersion).toBe(2); // initial term_set is v1; merged amendment is v2

    const e2 = await app.inject({
      method: 'POST',
      url: `/api/treaties/${id}/endorse`,
      headers: auth,
      payload: { description: 'Second endorsement', changes: {} },
    });
    expect(e2.statusCode).toBe(200);
    expect(e2.json().endorsementNo).toBe(2);
  });
});
