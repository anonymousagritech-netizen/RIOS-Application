/**
 * Portfolio gross/ceded/net rollup test (brief §7.5, §29.3 - report gap 5.2).
 *
 * Proves GET /api/portfolio/net-position aggregates the SAME financial_event
 * source the accounting chain uses into a per-currency and per-line-of-business
 * gross (inwards) / ceded (outwards) / net position, with net = gross − ceded
 * exactly in integer minor units. Binds one inwards treaty and one outwards
 * retrocession under a run-unique LOB so the arithmetic is asserted exactly
 * even when other test files run concurrently.
 *
 * Skips cleanly if Postgres is unreachable so it never produces a false failure.
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

interface Position {
  grossPremiumMinor: number;
  cededPremiumMinor: number;
  netPremiumMinor: number;
  grossLossMinor: number;
  cededLossMinor: number;
  netLossMinor: number;
}

/** Create a contract with a deposit premium in its terms and bind it (DRAFT → QUOTED → BOUND). */
async function bindContract(
  app: FastifyInstance,
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/treaties', headers: auth, payload: body });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  for (const to of ['QUOTED', 'BOUND']) {
    const moved = await app.inject({
      method: 'POST',
      url: `/api/treaties/${id}/transition`,
      headers: auth,
      payload: { to },
    });
    expect(moved.statusCode).toBe(200);
  }
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

describe('portfolio: gross/ceded/net rollup across inwards + outwards', () => {
  it('rolls up gross − ceded = net per currency and per line of business, in minor units', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    // Run-unique LOB so this test's figures are exact even under parallel test files.
    const lob = `NETPOS_TEST_${Date.now()}`;

    // Inwards treaty: binding books a $5,000 deposit premium (gross).
    await bindContract(app, auth, {
      name: 'Net Position Inwards QS',
      basis: 'NON_PROPORTIONAL',
      npType: 'CAT_XL',
      currency: 'USD',
      lineOfBusiness: lob,
      terms: { depositPremium: 5000 },
    });
    // Outwards retrocession: binding books a $2,000 deposit premium (ceded).
    await bindContract(app, auth, {
      name: 'Net Position Outwards Retro',
      contractKind: 'RETROCESSION',
      direction: 'OUTWARDS',
      basis: 'NON_PROPORTIONAL',
      npType: 'CAT_XL',
      currency: 'USD',
      lineOfBusiness: lob,
      terms: { depositPremium: 2000 },
    });

    const res = await app.inject({ method: 'GET', url: '/api/portfolio/net-position', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      byCurrency: ({ currency: string } & Position)[];
      byLob: ({ lineOfBusiness: string | null; currency: string } & Position)[];
      totals: Record<string, Position>;
    };

    // Exact arithmetic on this test's own LOB bucket: gross $5,000, ceded $2,000, net $3,000.
    const lobPos = body.byLob.find((p) => p.lineOfBusiness === lob && p.currency === 'USD');
    expect(lobPos).toBeDefined();
    expect(lobPos!.grossPremiumMinor).toBe(500_000);
    expect(lobPos!.cededPremiumMinor).toBe(200_000);
    expect(lobPos!.netPremiumMinor).toBe(300_000);
    expect(lobPos!.netPremiumMinor).toBe(lobPos!.grossPremiumMinor - lobPos!.cededPremiumMinor);

    // The net identity holds exactly on every currency and LOB bucket, premiums and losses alike.
    expect(body.byCurrency.length).toBeGreaterThan(0);
    for (const p of [...body.byCurrency, ...body.byLob]) {
      expect(p.netPremiumMinor).toBe(p.grossPremiumMinor - p.cededPremiumMinor);
      expect(p.netLossMinor).toBe(p.grossLossMinor - p.cededLossMinor);
      expect(Number.isInteger(p.netPremiumMinor)).toBe(true);
      expect(Number.isInteger(p.netLossMinor)).toBe(true);
    }

    // The currency rollup contains at least this test's contributions, and each
    // currency's byCurrency entry is exactly the sum of its LOB buckets - the
    // rollup reconciles across grains, no money invented or lost.
    const usd = body.byCurrency.find((p) => p.currency === 'USD')!;
    expect(usd.grossPremiumMinor).toBeGreaterThanOrEqual(500_000);
    expect(usd.cededPremiumMinor).toBeGreaterThanOrEqual(200_000);
    for (const cur of body.byCurrency) {
      const lobs = body.byLob.filter((p) => p.currency === cur.currency);
      expect(lobs.reduce((acc, p) => acc + p.grossPremiumMinor, 0)).toBe(cur.grossPremiumMinor);
      expect(lobs.reduce((acc, p) => acc + p.cededPremiumMinor, 0)).toBe(cur.cededPremiumMinor);
      expect(lobs.reduce((acc, p) => acc + p.grossLossMinor, 0)).toBe(cur.grossLossMinor);
      expect(lobs.reduce((acc, p) => acc + p.cededLossMinor, 0)).toBe(cur.cededLossMinor);
    }

    // totals mirrors byCurrency, keyed by currency (money never mixes currencies).
    for (const cur of body.byCurrency) {
      const { currency, ...pos } = cur;
      expect(body.totals[currency]).toEqual(pos);
    }
  });

  it('is gated by treaty:read - a PORTAL user gets 403', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'broker@demo.rios');
    const res = await app.inject({
      method: 'GET',
      url: '/api/portfolio/net-position',
      headers: { authorization: `Bearer ${tkn}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
