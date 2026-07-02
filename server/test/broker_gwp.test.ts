/**
 * Broker GWP attribution tie-out tests (G-10).
 *
 * Verifies that broker GWP reported by GET /api/brokers now comes from
 * financial_event.amount_minor (via contract.broker_party_id) and NOT from
 * submission.est_premium_minor, which is always $0 on a fresh demo DB.
 *
 * Requires a migrated + seeded database (npm run db:reset first).
 * Skips cleanly when Postgres is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerPool, closePools } from '../src/db.js';

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

describe('broker GWP attribution', () => {
  it('GWP comes from financial_event not submission — at least one broker has gwpMinor > 0', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const res = await app.inject({ method: 'GET', url: '/api/brokers', headers: auth });
    expect(res.statusCode).toBe(200);

    const { brokers } = res.json() as { brokers: Array<{ gwpMinor: number; legalName: string }> };
    expect(Array.isArray(brokers)).toBe(true);

    // At least one demo broker should have non-zero GWP from the seeded financial events
    const withGwp = brokers.filter((b) => b.gwpMinor > 0);
    expect(withGwp.length).toBeGreaterThan(0);
  });

  it('broker list GWP matches sum of financial_event premium amounts for that broker', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // Get the broker list
    const listRes = await app.inject({ method: 'GET', url: '/api/brokers', headers: auth });
    expect(listRes.statusCode).toBe(200);
    const { brokers } = listRes.json() as { brokers: Array<{ id: string; legalName: string; gwpMinor: number }> };

    // Pick the broker with the highest reported GWP as the tie-out subject
    const topBroker = brokers.sort((a, b) => b.gwpMinor - a.gwpMinor)[0];
    if (!topBroker || topBroker.gwpMinor === 0) return; // no seeded data visible, skip

    // Query the DB directly for the same aggregate
    const dbResult = await ownerPool.query<{ gwp: string }>(
      `select coalesce(sum(fe.amount_minor) filter (where fe.event_type ilike '%premium%'), 0)::bigint as gwp
         from contract ct
         join financial_event fe on fe.contract_id = ct.id
        where ct.broker_party_id = $1 and not ct.is_deleted`,
      [topBroker.id],
    );

    const expectedGwp = Number(dbResult.rows[0]!.gwp);
    expect(topBroker.gwpMinor).toBe(expectedGwp);
  });

  it('broker analytics endpoint reports non-zero totalGwpMinor after seeding', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const res = await app.inject({ method: 'GET', url: '/api/brokers/analytics', headers: auth });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { totalGwpMinor: number; topBrokers: Array<{ gwpMinor: number }> };
    expect(body.totalGwpMinor).toBeGreaterThan(0);
    expect(body.topBrokers.length).toBeGreaterThan(0);
    // Top broker in analytics must also show non-zero GWP
    expect(body.topBrokers[0]!.gwpMinor).toBeGreaterThan(0);
  });
});
