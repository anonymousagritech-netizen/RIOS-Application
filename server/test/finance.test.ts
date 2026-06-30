/**
 * Finance module test (brief §9.8) - GL / AR / AP / cash.
 *
 * Proves the trial balance self-balances after posting a contract's technical
 * accounting to the GL, and that recording cash against an AR invoice marks it
 * settled. Skips cleanly when Postgres is unreachable so it never produces a
 * false failure.
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

describe('finance: GL / AR / AP / cash', () => {
  it('keeps the trial balance balanced after posting a contract to the GL', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'Finance TB Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD', terms: { depositPremium: 250000, currency: 'USD' } },
    });
    const id = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });

    const posted = await app.inject({ method: 'POST', url: `/api/treaties/${id}/post`, headers: auth });
    expect(posted.json().reconciled).toBe(true);

    const tb = await app.inject({ method: 'GET', url: '/api/finance/trial-balance', headers: auth });
    expect(tb.statusCode).toBe(200);
    expect(tb.json().balanced).toBe(true);
    expect(tb.json().totalDebitsMinor).toBe(tb.json().totalCreditsMinor);
  });

  it('settles an AR invoice when cash is recorded against it', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const party = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: 'Finance Cash Cedent', shortName: 'Fin Cash', roles: ['cedent'] },
    });
    const counterpartyId = party.json().id as string;

    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'Finance Cash Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD', cedentPartyId: counterpartyId, terms: { depositPremium: 100000, currency: 'USD' } },
    });
    const id = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });

    const gen = await app.inject({ method: 'POST', url: '/api/statements/generate', headers: auth, payload: { contractId: id, counterpartyId } });
    const statementId = gen.json().id as string;
    for (const to of ['UNDER_REVIEW', 'APPROVED', 'ISSUED']) {
      await app.inject({ method: 'POST', url: `/api/statements/${statementId}/transition`, headers: auth, payload: { to } });
    }

    const arList = await app.inject({ method: 'GET', url: '/api/finance/ar-invoices', headers: auth });
    const invoices = arList.json().invoices as Array<{ id: string; statementId: string; amountMinor: number }>;
    const inv = invoices.find((i) => i.statementId === statementId);
    expect(inv).toBeDefined();
    expect(inv!.amountMinor).toBe(10_000_000); // $100,000.00

    // Pay it in full: cash IN allocated to the AR invoice settles it.
    const cash = await app.inject({
      method: 'POST', url: '/api/finance/cash', headers: auth,
      payload: { direction: 'IN', amount: 100000, currency: 'USD', arInvoiceId: inv!.id, counterpartyId, narrative: 'Settlement of deposit premium' },
    });
    expect(cash.statusCode).toBe(201);
    expect(cash.json().invoiceStatus).toBe('SETTLED');

    // Reconcile the bank line.
    const recon = await app.inject({ method: 'POST', url: `/api/finance/cash/${cash.json().id}/reconcile`, headers: auth });
    expect(recon.statusCode).toBe(200);
    expect(recon.json().isReconciled).toBe(true);

    // Confirm the invoice is now SETTLED in the list.
    const settledList = await app.inject({ method: 'GET', url: '/api/finance/ar-invoices?status=SETTLED', headers: auth });
    const settled = (settledList.json().invoices as Array<{ id: string }>).find((i) => i.id === inv!.id);
    expect(settled).toBeDefined();
  });
});
