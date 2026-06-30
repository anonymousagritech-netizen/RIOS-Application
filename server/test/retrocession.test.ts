/**
 * Retrocession module test (brief §7.5, §29.3).
 *
 * Proves an OUTWARDS retrocession contract is created and that the net-position
 * view reports gross ≥ ceded with net = gross − ceded for the seeded book.
 * Skips cleanly when Postgres is unreachable so it never produces a false failure.
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

describe('retrocession: outwards protection + net position', () => {
  it('creates an OUTWARDS retrocession contract and lists it', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/retrocession',
      headers: auth,
      payload: {
        name: 'Retro Cat XL Protection',
        basis: 'NON_PROPORTIONAL',
        npType: 'CAT_XL',
        currency: 'USD',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.reference).toMatch(/^RETRO-/);

    const detail = await app.inject({ method: 'GET', url: '/api/retrocession', headers: auth });
    expect(detail.statusCode).toBe(200);
    const match = (detail.json().retrocession as { id: string; direction: string; contractKind: string }[]).find(
      (c) => c.id === body.id,
    );
    expect(match).toBeDefined();
    expect(match!.direction).toBe('OUTWARDS');
    expect(match!.contractKind).toBe('RETROCESSION');
  });

  it('reports a net position with gross >= ceded and net = gross - ceded', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Seed gross (inwards) premium via a facultative cession of $800,000.
    await app.inject({
      method: 'POST',
      url: '/api/facultative',
      headers: auth,
      payload: {
        name: 'Retro Net Inwards Fac',
        basis: 'NON_PROPORTIONAL',
        currency: 'USD',
        premium: 800_000,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/retrocession/net-position', headers: auth });
    expect(res.statusCode).toBe(200);
    const positions = res.json().positions as {
      currency: string;
      grossMinor: number;
      cededMinor: number;
      netMinor: number;
    }[];

    const usd = positions.find((p) => p.currency === 'USD');
    expect(usd).toBeDefined();
    // The seeded facultative cession (inwards) contributes at least $800,000 gross.
    expect(usd!.grossMinor).toBeGreaterThanOrEqual(80_000_000);
    // Net identity holds and gross dominates ceded for the demo book.
    expect(usd!.grossMinor).toBeGreaterThanOrEqual(usd!.cededMinor);
    expect(usd!.netMinor).toBe(usd!.grossMinor - usd!.cededMinor);
  });
});
