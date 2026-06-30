/**
 * Statements-of-account lifecycle test (brief §7.6, §28.5).
 *
 * Builds a treaty, binds it (booking the deposit premium), generates a statement
 * from the resulting financial events and drives it through the ordered lifecycle
 * to ISSUED, asserting the AR invoice is spun off for the counterparty. Skips
 * cleanly when Postgres is unreachable so it never produces a false failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { statementsModule } from '../src/modules/statements.js';
import { financeModule } from '../src/modules/finance.js';

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

describe('statement-of-account lifecycle', () => {
  it('generates a statement netting to the deposit premium and issues an AR invoice', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Create a treaty with a $500,000 deposit premium and a counterparty.
    const party = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: 'SOA Counterparty Ltd', shortName: 'SOA CP', roles: ['cedent'] },
    });
    const counterpartyId = party.json().id as string;

    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: {
        name: 'Statement Test Treaty',
        basis: 'NON_PROPORTIONAL',
        npType: 'CAT_XL',
        currency: 'USD',
        cedentPartyId: counterpartyId,
        terms: { depositPremium: 500000, currency: 'USD' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // DRAFT → QUOTED → BOUND books the deposit premium.
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    const bound = await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
    expect(bound.json().status).toBe('BOUND');

    // Generate the statement; balance nets to the deposit premium.
    const gen = await app.inject({
      method: 'POST', url: '/api/statements/generate', headers: auth,
      payload: { contractId: id, counterpartyId },
    });
    expect(gen.statusCode).toBe(201);
    expect(gen.json().balanceMinor).toBe(50_000_000); // $500,000.00
    const statementId = gen.json().id as string;

    // Re-generating finds nothing left to statement.
    const again = await app.inject({
      method: 'POST', url: '/api/statements/generate', headers: auth,
      payload: { contractId: id },
    });
    expect(again.statusCode).toBe(409);

    // PREPARED → UNDER_REVIEW → APPROVED → ISSUED.
    for (const to of ['UNDER_REVIEW', 'APPROVED', 'ISSUED']) {
      const t = await app.inject({ method: 'POST', url: `/api/statements/${statementId}/transition`, headers: auth, payload: { to } });
      expect(t.statusCode).toBe(200);
      expect(t.json().status).toBe(to);
    }

    // The issue spun off an AR invoice for the counterparty.
    const arList = await app.inject({ method: 'GET', url: '/api/finance/ar-invoices', headers: auth });
    const invoices = arList.json().invoices as Array<{ statementId: string; partyId: string; amountMinor: number }>;
    const inv = invoices.find((i) => i.statementId === statementId);
    expect(inv).toBeDefined();
    expect(inv!.partyId).toBe(counterpartyId);
    expect(inv!.amountMinor).toBe(50_000_000);
  });

  it('rejects an illegal lifecycle transition with 409', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'SOA Guard Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD', terms: { depositPremium: 100000, currency: 'USD' } },
    });
    const id = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
    const gen = await app.inject({ method: 'POST', url: '/api/statements/generate', headers: auth, payload: { contractId: id } });
    const statementId = gen.json().id as string;

    // PREPARED → APPROVED skips UNDER_REVIEW and is illegal.
    const bad = await app.inject({ method: 'POST', url: `/api/statements/${statementId}/transition`, headers: auth, payload: { to: 'APPROVED' } });
    expect(bad.statusCode).toBe(409);
  });
});
