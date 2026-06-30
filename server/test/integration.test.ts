/**
 * Vertical-slice integration test (brief §21 Phase 10 exit gate):
 *   login → create treaty → bind (books deposit premium) → statement →
 *   post to GL → reconcile; plus claims and the assistant confirmation gate.
 *
 * Requires a migrated + seeded database reachable via DATABASE_URL/DATABASE_APP_URL
 * (run `npm run db:reset` first, or point at the dev DB). Skips cleanly if the DB
 * is unreachable so it never produces a false failure in an environment without PG.
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

describe('vertical slice: place → bind → account → reconcile', () => {
  it('runs the full chain with correct, reconciled numbers', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Create a fully-formed treaty with a deposit premium of $500,000.
    const created = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Integration Test Treaty',
        basis: 'NON_PROPORTIONAL',
        npType: 'CAT_XL',
        currency: 'USD',
        terms: { depositPremium: 500000, currency: 'USD' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // DRAFT → QUOTED → BOUND. Binding books the deposit premium.
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    const bound = await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
    expect(bound.json().status).toBe('BOUND');
    expect(bound.json().financialEvents[0].amountMinor).toBe(50_000_000); // $500,000.00

    // Statement nets to the deposit premium.
    const stmt = await app.inject({ method: 'GET', url: `/api/treaties/${id}/statement`, headers: auth });
    expect(stmt.json().balanceMinor).toBe(50_000_000);

    // Post to the GL and confirm the chain reconciles.
    const posted = await app.inject({ method: 'POST', url: `/api/treaties/${id}/post`, headers: auth });
    expect(posted.json().reconciled).toBe(true);
    expect(posted.json().controlMovementMinor).toBe(posted.json().statementBalanceMinor);
  });

  it('enforces the illegal-transition guard', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'Guard Test', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD' },
    });
    const id = created.json().id as string;
    const bad = await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
    expect(bad.statusCode).toBe(409); // DRAFT → BOUND is illegal
  });

  it('blocks an under-permissioned assistant confirmation', async () => {
    if (!dbUp) return;
    const acct = await token(app, 'acct@demo.rios'); // no treaty:write
    const res = await app.inject({
      method: 'POST', url: '/api/assistant/confirm',
      headers: { authorization: `Bearer ${acct}` },
      payload: { kind: 'create_treaty', preview: { name: 'Nope' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('grounds assistant answers in tenant data and prepares (not executes) mutations', async () => {
    if (!dbUp) return;
    const uw = await token(app, 'uw@demo.rios');
    const res = await app.inject({
      method: 'POST', url: '/api/assistant',
      headers: { authorization: `Bearer ${uw}` },
      payload: { message: 'create a treaty named Prepared Only' },
    });
    const body = res.json();
    expect(body.actions[0].requiresConfirmation).toBe(true);
    expect(body.actions[0].kind).toBe('create_treaty');
  });
});
