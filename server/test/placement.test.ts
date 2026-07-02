/**
 * Placement / Slip integration test (brief §29.4):
 *   create contract → open slip → write two oversubscribing lines → sign down →
 *   signed lines sum to the order and flow into participations without re-keying.
 *
 * Requires a migrated + seeded database. Skips cleanly if Postgres is unreachable
 * so it never produces a false failure in an environment without PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { placementModule } from '../src/modules/placement.js';

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

describe('placement: oversubscribed slip signs down to the order', () => {
  it('signs down two lines summing to >1.0 and creates participations', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // A contract to place.
    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'Placement Test Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const contractId = created.json().id as string;

    // Two reinsurers to write lines.
    const partyA = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: 'Reinsurer Alpha Ltd', shortName: 'Alpha Re', roles: ['reinsurer'] },
    });
    const partyB = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: 'Reinsurer Beta Ltd', shortName: 'Beta Re', roles: ['reinsurer'] },
    });
    const partyAId = partyA.json().id as string;
    const partyBId = partyB.json().id as string;

    // Open a slip placing 100% of the order.
    const slip = await app.inject({
      method: 'POST', url: '/api/placement/slips', headers: auth,
      payload: { contractId, orderPct: 1.0 },
    });
    expect(slip.statusCode).toBe(201);
    const slipId = slip.json().id as string;

    // Write two lines summing to 1.2 → oversubscribed.
    await app.inject({
      method: 'POST', url: `/api/placement/slips/${slipId}/lines`, headers: auth,
      payload: { partyId: partyAId, writtenLine: 0.8 },
    });
    const second = await app.inject({
      method: 'POST', url: `/api/placement/slips/${slipId}/lines`, headers: auth,
      payload: { partyId: partyBId, writtenLine: 0.4 },
    });
    expect(second.json().isOversubscribed).toBe(true);
    expect(second.json().totalWritten).toBeCloseTo(1.2, 6);

    // Slip detail must expose the written market lines under `marketLines`
    // (the client renders `slip.marketLines`; a `lines` alias would crash it).
    const detail = await app.inject({ method: 'GET', url: `/api/placement/slips/${slipId}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(Array.isArray(detail.json().marketLines)).toBe(true);
    expect(detail.json().marketLines).toHaveLength(2);

    // Sign down: signed lines must sum to the order (1.0) and shares stay proportional.
    const signed = await app.inject({
      method: 'POST', url: `/api/placement/slips/${slipId}/sign-down`, headers: auth,
    });
    expect(signed.statusCode).toBe(200);
    const body = signed.json();
    expect(body.status).toBe('SIGNED');
    expect(body.totalSigned).toBeCloseTo(1.0, 6); // signed down to the order

    const signedSum = body.signedLines.reduce((acc: number, l: { signedLine: number }) => acc + l.signedLine, 0);
    expect(signedSum).toBeCloseTo(1.0, 6);

    // Proportional shares: 0.8/1.2 = 2/3, 0.4/1.2 = 1/3 of the order.
    const lineA = body.signedLines.find((l: { partyId: string }) => l.partyId === partyAId);
    const lineB = body.signedLines.find((l: { partyId: string }) => l.partyId === partyBId);
    expect(lineA.signedLine).toBeCloseTo(2 / 3, 6);
    expect(lineB.signedLine).toBeCloseTo(1 / 3, 6);

    // Signed lines flow into participations without re-keying.
    expect(body.participations).toHaveLength(2);
    const partSum = body.participations.reduce((acc: number, p: { signedLine: number }) => acc + p.signedLine, 0);
    expect(partSum).toBeCloseTo(1.0, 6);
  });

  it('signs the written line unchanged when not oversubscribed', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'Undersub Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD' },
    });
    const contractId = created.json().id as string;
    const party = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: 'Reinsurer Gamma Ltd', shortName: 'Gamma Re', roles: ['reinsurer'] },
    });
    const partyId = party.json().id as string;

    const slip = await app.inject({
      method: 'POST', url: '/api/placement/slips', headers: auth,
      payload: { contractId, orderPct: 1.0 },
    });
    const slipId = slip.json().id as string;

    const line = await app.inject({
      method: 'POST', url: `/api/placement/slips/${slipId}/lines`, headers: auth,
      payload: { partyId, writtenLine: 0.6 },
    });
    expect(line.json().isOversubscribed).toBe(false);

    const signed = await app.inject({
      method: 'POST', url: `/api/placement/slips/${slipId}/sign-down`, headers: auth,
    });
    expect(signed.json().signedLines[0].signedLine).toBeCloseTo(0.6, 6);
  });
});
