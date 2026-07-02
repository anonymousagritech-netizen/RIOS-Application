/**
 * Bureau / ACORD connector (brief §7, §28). Builds a treaty, binds it (booking
 * the deposit premium), generates a statement, then builds an EBOT from that
 * statement, sends it through the loopback connector and polls the inbound
 * acknowledgement. Also checks the permission gate. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('Bureau / ACORD EBOT round trip', () => {
  it('builds, sends and acknowledges an EBOT from a statement', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };

    // A bound treaty with a deposit premium, then a statement from its events.
    const party = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: 'Bureau Cedent Ltd', shortName: 'BUR CP', roles: ['cedent'] },
    });
    const counterpartyId = party.json().id as string;
    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: {
        name: 'Bureau Test Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL',
        currency: 'USD', cedentPartyId: counterpartyId,
        terms: { depositPremium: 500000, currency: 'USD' },
      },
    });
    const contractId = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${contractId}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    await app.inject({ method: 'POST', url: `/api/treaties/${contractId}/transition`, headers: auth, payload: { to: 'BOUND' } });
    const gen = await app.inject({
      method: 'POST', url: '/api/statements/generate', headers: auth,
      payload: { contractId, counterpartyId },
    });
    const statementId = gen.json().id as string;

    // Build the EBOT.
    const built = await app.inject({ method: 'POST', url: '/api/bureau/ebot', headers: auth, payload: { statementId } });
    expect(built.statusCode).toBe(200);
    const body = built.json();
    expect(body.validation.valid).toBe(true);
    expect(body.envelope.header.messageType).toBe('EBOT');
    expect(body.envelope.premium.amountMinor).toBe(50_000_000); // $500,000.00 deposit
    // Net settlement reconciles to premium - brokerage - taxes.
    expect(body.envelope.settlementAmount.amountMinor).toBe(
      body.envelope.premium.amountMinor - body.envelope.brokerage.amountMinor - body.envelope.taxes.amountMinor,
    );
    expect(body.message.status).toBe('BUILT');
    const messageId = body.message.id as string;

    // Send through the loopback connector -> SENT with a bureau ref.
    const sent = await app.inject({ method: 'POST', url: `/api/bureau/${messageId}/send`, headers: auth });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().status).toBe('SENT');
    expect(sent.json().externalRef).toContain('BUR-');

    // Poll -> at least our message is acknowledged and an inbound echo recorded.
    const polled = await app.inject({ method: 'POST', url: '/api/bureau/poll', headers: auth });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().received).toBeGreaterThanOrEqual(1);

    // The outbound is now ACKNOWLEDGED and an INBOUND RECEIVED exists.
    const view = await app.inject({ method: 'GET', url: `/api/bureau/messages/${messageId}`, headers: auth });
    expect(view.json().status).toBe('ACKNOWLEDGED');
    const list = await app.inject({ method: 'GET', url: '/api/bureau/messages', headers: auth });
    const inbound = list.json().messages.filter((m: { direction: string }) => m.direction === 'INBOUND');
    expect(inbound.length).toBeGreaterThanOrEqual(1);
  });

  it('forbids building a bureau message without accounting:post', async () => {
    if (!dbUp) return;
    // The claims user has no accounting:post permission.
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/bureau/ebot', headers: auth,
      payload: { statementId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(403);
  });
});
