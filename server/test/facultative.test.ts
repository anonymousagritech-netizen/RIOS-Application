/**
 * Facultative module test (brief §7.4, §29.2).
 *
 * Proves the one-screen cession creates a contract + risk + a correct ceded
 * premium Financial Event in a single transaction. Skips cleanly when Postgres
 * is unreachable so it never produces a false failure.
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

describe('facultative: one-screen cession with auto-accounting', () => {
  it('creates a contract + risk + correct ceded premium financial event', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Proportional cession: $1,000,000 premium at a 40% ceded share => $400,000.00 = 40,000,000 minor.
    const created = await app.inject({
      method: 'POST',
      url: '/api/facultative',
      headers: auth,
      payload: {
        name: 'Fac Test Cession',
        basis: 'PROPORTIONAL',
        currency: 'USD',
        insuredName: 'Acme Manufacturing Ltd',
        sumInsured: 5_000_000,
        premium: 1_000_000,
        cededShare: 0.4,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.reference).toMatch(/^FAC-/);
    expect(typeof body.id).toBe('string');
    expect(typeof body.riskId).toBe('string');
    expect(body.financialEvents).toHaveLength(1);
    expect(body.financialEvents[0].eventType).toBe('DEPOSIT_PREMIUM');
    expect(body.financialEvents[0].amountMinor).toBe(40_000_000); // $400,000.00

    // Detail view joins the risk and the booked event.
    const detail = await app.inject({ method: 'GET', url: `/api/facultative/${body.id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.contractKind).toBe('FACULTATIVE');
    expect(d.status).toBe('BOUND');
    expect(d.risks).toHaveLength(1);
    expect(d.risks[0].insuredName).toBe('Acme Manufacturing Ltd');
    expect(d.risks[0].sumInsuredMinor).toBe(500_000_000); // $5,000,000.00
    expect(d.financialEvents).toHaveLength(1);
    expect(d.financialEvents[0].amountMinor).toBe(40_000_000);

    // The list view surfaces the new facultative contract.
    const list = await app.inject({ method: 'GET', url: '/api/facultative', headers: auth });
    expect(list.statusCode).toBe(200);
    const ids = (list.json().facultative as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(body.id);
  });

  it('persists a metadata-driven details bag on the cession risk and returns it', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const details = { occupancy: 'Warehouse', floodZone: 'A', sprinklered: true };
    const created = await app.inject({
      method: 'POST',
      url: '/api/facultative',
      headers: auth,
      payload: {
        name: 'Fac Details Cession',
        basis: 'PROPORTIONAL',
        currency: 'USD',
        insuredName: 'Details Corp',
        sumInsured: 1_000_000,
        cededShare: 0.5,
        details,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const detail = await app.inject({ method: 'GET', url: `/api/facultative/${id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.risks).toHaveLength(1);
    expect(d.risks[0].details).toEqual(details);
  });

  it('books the full premium for non-proportional facultative', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/facultative',
      headers: auth,
      payload: {
        name: 'Fac NP Cession',
        basis: 'NON_PROPORTIONAL',
        currency: 'USD',
        premium: 250_000,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.financialEvents).toHaveLength(1);
    expect(body.financialEvents[0].amountMinor).toBe(25_000_000); // full $250,000.00
  });
});
