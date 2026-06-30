/**
 * Claims-advanced integration test (brief §7.7):
 *   create treaty → bind → create claim → cash call (books CASH_LOSS) →
 *   recovery (updates net position). Proves the depth routes persist and book the
 *   right financial events.
 *
 * Requires a migrated + seeded database reachable via DATABASE_URL/DATABASE_APP_URL.
 * Skips cleanly if the DB is unreachable so it never produces a false failure in an
 * environment without PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { claimsAdvancedModule } from '../src/modules/claimsAdvanced.js';

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

async function boundTreaty(app: FastifyInstance, auth: { authorization: string }): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/treaties',
    headers: auth,
    payload: {
      name: 'Claims Advanced Treaty',
      basis: 'NON_PROPORTIONAL',
      npType: 'CAT_XL',
      currency: 'USD',
      terms: { currency: 'USD' },
    },
  });
  const id = created.json().id as string;
  await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
  await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
  return id;
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

describe('claims advanced: cash call, recovery, net position', () => {
  it('files a cash call and books a CASH_LOSS financial event', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const contractId = await boundTreaty(app, auth);
    const claim = await app.inject({
      method: 'POST',
      url: '/api/claims',
      headers: auth,
      payload: { contractId, currency: 'USD', grossLoss: 500000, description: 'Cash call claim' },
    });
    expect(claim.statusCode).toBe(201);
    const claimId = claim.json().id as string;

    const call = await app.inject({
      method: 'POST',
      url: `/api/claims/${claimId}/cash-call`,
      headers: auth,
      payload: { amount: 100000 },
    });
    expect(call.statusCode).toBe(200);
    expect(call.json().status).toBe('requested');
    expect(call.json().amountMinor).toBe(10_000_000); // $100,000

    // The CASH_LOSS event is visible on the contract's financial-events feed.
    const events = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/financial-events`, headers: auth });
    const cashLoss = (events.json().events as Array<{ eventType: string; amountMinor: number }>).find(
      (e) => e.eventType === 'CASH_LOSS',
    );
    expect(cashLoss).toBeTruthy();
    expect(cashLoss!.amountMinor).toBe(10_000_000);

    // Paying the cash call flips its status.
    const callId = call.json().id as string;
    const paid = await app.inject({ method: 'POST', url: `/api/claims/${claimId}/cash-call/${callId}/pay`, headers: auth });
    expect(paid.json().status).toBe('paid');
  });

  it('records a SALVAGE recovery and reflects it in the net position', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const contractId = await boundTreaty(app, auth);
    const claim = await app.inject({
      method: 'POST',
      url: '/api/claims',
      headers: auth,
      payload: { contractId, currency: 'USD', grossLoss: 500000, description: 'Recovery claim' },
    });
    const claimId = claim.json().id as string;

    const rec = await app.inject({
      method: 'POST',
      url: `/api/claims/${claimId}/recovery`,
      headers: auth,
      payload: { recoveryType: 'SALVAGE', amount: 100000 },
    });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().amountMinor).toBe(10_000_000); // $100,000

    const recoveries = await app.inject({ method: 'GET', url: `/api/claims/${claimId}/recoveries`, headers: auth });
    expect(recoveries.json().recoveries.length).toBe(1);

    const net = await app.inject({ method: 'GET', url: `/api/claims/${claimId}/net-position`, headers: auth });
    expect(net.statusCode).toBe(200);
    expect(net.json().recoveredMinor).toBe(10_000_000); // $100,000
    expect(net.json().grossLossMinor).toBe(50_000_000); // $500,000
    expect(net.json().netMinor).toBe(40_000_000); // gross − recovered = $400,000
  });
});
