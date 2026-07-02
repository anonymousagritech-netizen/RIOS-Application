/**
 * SOA verification engine integration test (industry-gap-analysis §2.2 item 8).
 *
 * Full flow: create + bind a proportional treaty with explicit commission terms
 * (binding books the deposit premium), stage the cedent-reported ceding
 * commission as a financial event, generate the statement, then verify it -
 * VERIFIED when the reported commission matches the terms-recomputed figure,
 * DEVIATIONS when the cedent under-reports, plus the history endpoint, the 404,
 * the 400 and the permission gate.
 *
 * RIOS has no public endpoint that books a CEDING_COMMISSION financial event
 * (statements are built from whatever events exist), so the cedent-reported
 * commission is staged directly via the owner connection - the same pattern
 * other integration tests use for fixture data (e.g. counterparty_security).
 *
 * Requires a migrated + seeded database; skips cleanly if Postgres is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

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

/**
 * Create and bind a proportional treaty with explicit commission terms, then
 * stage the cedent-reported ceding commission as a CR financial event so the
 * generated statement carries both the premium and the commission line.
 */
async function boundTreatyWithCommission(
  app: FastifyInstance,
  auth: { authorization: string },
  name: string,
  reportedCommissionMinor: number,
): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/api/treaties', headers: auth,
    payload: {
      name,
      basis: 'PROPORTIONAL',
      proportionalType: 'QUOTA_SHARE',
      currency: 'USD',
      terms: {
        currency: 'USD',
        cessionPct: 30,
        depositPremium: 1_000_000, // major units -> 100,000,000 minor
        cedingCommissionPct: 25,
        commissionMinPct: 20,
        commissionMaxPct: 30,
      },
    },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;

  // DRAFT -> QUOTED -> BOUND books the deposit premium (100,000,000 minor DR).
  await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
  const bound = await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
  expect(bound.json().status).toBe('BOUND');

  // Stage the cedent-reported ceding commission (owner connection, test fixture).
  await ownerQuery(
    `insert into financial_event (tenant_id, contract_id, event_type, direction, amount_minor, currency, narrative)
     select tenant_id, id, 'CEDING_COMMISSION', 'CR', $2, currency, 'Cedent-reported ceding commission'
       from contract where id = $1`,
    [id, reportedCommissionMinor],
  );
  return id;
}

async function generateStatement(
  app: FastifyInstance,
  auth: { authorization: string },
  contractId: string,
): Promise<string> {
  const gen = await app.inject({
    method: 'POST', url: '/api/statements/generate', headers: auth,
    payload: { contractId },
  });
  expect(gen.statusCode).toBe(201);
  return gen.json().id as string;
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

describe('SOA verification engine', () => {
  it('verifies a statement whose commission matches the treaty terms (VERIFIED)', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Terms: 25% ceding commission on 100,000,000 minor premium -> 25,000,000
    // expected. The cedent reports exactly that.
    const contractId = await boundTreatyWithCommission(app, auth, 'SOA Verify Treaty (clean)', 25_000_000);
    const statementId = await generateStatement(app, auth, contractId);

    const res = await app.inject({
      method: 'POST', url: `/api/statements/${statementId}/verify`, headers: auth, payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('VERIFIED');
    expect(body.tolerancePct).toBe(1); // default
    expect(body.currency).toBe('USD');

    const commission = (body.items as Array<Record<string, unknown>>)
      .find((i) => i.itemKey === 'CEDING_COMMISSION');
    expect(commission).toBeDefined();
    expect(commission!.expectedMinor).toBe(25_000_000);
    expect(commission!.actualMinor).toBe(25_000_000);
    expect(commission!.deviationMinor).toBe(0);
    expect(commission!.withinTolerance).toBe(true);
  });

  it('flags a cedent-under-reported commission beyond tolerance (DEVIATIONS)', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // The cedent reports 20% (20,000,000) against terms of 25% (25,000,000):
    // a -20% deviation, far beyond the 1% tolerance.
    const contractId = await boundTreatyWithCommission(app, auth, 'SOA Verify Treaty (deviating)', 20_000_000);
    const statementId = await generateStatement(app, auth, contractId);

    const res = await app.inject({
      method: 'POST', url: `/api/statements/${statementId}/verify`, headers: auth,
      payload: { tolerancePct: 1 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('DEVIATIONS');

    const commission = (body.items as Array<Record<string, unknown>>)
      .find((i) => i.itemKey === 'CEDING_COMMISSION');
    expect(commission).toBeDefined();
    expect(commission!.expectedMinor).toBe(25_000_000);
    expect(commission!.actualMinor).toBe(20_000_000);
    expect(commission!.deviationMinor).toBe(-5_000_000);
    expect(commission!.withinTolerance).toBe(false);

    // The history endpoint returns the persisted run with its items.
    const history = await app.inject({
      method: 'GET', url: `/api/statements/${statementId}/verifications`, headers: auth,
    });
    expect(history.statusCode).toBe(200);
    const verifications = history.json().verifications as Array<Record<string, unknown>>;
    expect(verifications.length).toBe(1);
    expect(verifications[0]!.status).toBe('DEVIATIONS');
    expect(verifications[0]!.tolerancePct).toBe(1);
    const items = verifications[0]!.items as Array<Record<string, unknown>>;
    expect(items.some((i) => i.itemKey === 'CEDING_COMMISSION' && i.withinTolerance === false)).toBe(true);
  });

  it('returns 404 for a missing statement and 400 for an invalid tolerance', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const missing = await app.inject({
      method: 'POST', url: '/api/statements/00000000-0000-0000-0000-000000000000/verify',
      headers: auth, payload: {},
    });
    expect(missing.statusCode).toBe(404);

    const missingHistory = await app.inject({
      method: 'GET', url: '/api/statements/00000000-0000-0000-0000-000000000000/verifications',
      headers: auth,
    });
    expect(missingHistory.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'POST', url: '/api/statements/00000000-0000-0000-0000-000000000000/verify',
      headers: auth, payload: { tolerancePct: -1 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('gates verification behind statement:write (403 for the claims role)', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'claims@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({
      method: 'POST', url: '/api/statements/00000000-0000-0000-0000-000000000000/verify',
      headers: auth, payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
