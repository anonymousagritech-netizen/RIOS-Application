/**
 * Typed contract terms integration test (gap-analysis §2.2 item 4):
 *   the known commercial term keys are validated on POST /api/treaties while
 *   unknown keys still pass through (metadata-driven config stays open).
 *
 * Requires a migrated + seeded database. Skips cleanly if Postgres is
 * unreachable so it never produces a false failure without PG.
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

describe('typed contract terms', () => {
  it('accepts a rich, valid term set (201) and persists it', async () => {
    if (!dbUp) return; // environment without Postgres
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Typed Terms Cat XL',
        basis: 'NON_PROPORTIONAL',
        npType: 'CAT_XL',
        currency: 'USD',
        terms: {
          currency: 'USD',
          underwritingYear: 2026,
          territory: 'Worldwide excl. US/Canada',
          slipReference: 'SLIP-2026-0001',
          expiringContractRef: 'TRTY-2025-0042',
          writtenSharePct: 100,
          orderPct: 100,
          periodBasis: 'LOSSES_OCCURRING',
          attachment: 5_000_000,
          limit: 20_000_000,
          layers: 2,
          aggregateDeductible: 1_000_000,
          reinstatements: '2 @ 100%',
          rateOnLine: 12.5,
          hoursClause: 72,
          eventLimit: 40_000_000,
          brokeragePct: 10,
          commissionMinPct: 20,
          commissionMaxPct: 35,
          estimatedPremiumIncome: 2_500_000,
          minimumAndDepositPremium: 2_000_000,
          depositPremium: 2_000_000,
          statementFrequency: 'QUARTERLY',
          accountingBasis: 'UNDERWRITING_YEAR',
          settlementCurrency: 'USD',
          cashCallThreshold: 250_000,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // The term set round-trips on the contract detail.
    const detail = await app.inject({ method: 'GET', url: `/api/treaties/${id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    const terms = detail.json().terms as Record<string, unknown>;
    expect(terms.underwritingYear).toBe(2026);
    expect(terms.periodBasis).toBe('LOSSES_OCCURRING');
    expect(terms.rateOnLine).toBe(12.5);
  });

  it('rejects commissionMinPct > commissionMaxPct with a 400 and flattened details', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Bad Commission Band Treaty',
        basis: 'PROPORTIONAL',
        proportionalType: 'QUOTA_SHARE',
        currency: 'USD',
        terms: { commissionMinPct: 35, commissionMaxPct: 20 },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Invalid contract');
    expect(JSON.stringify(body.details)).toMatch(/commissionMinPct/);
  });

  it('still accepts unknown extra keys (passthrough) alongside typed keys', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Passthrough Terms Treaty',
        basis: 'PROPORTIONAL',
        proportionalType: 'QUOTA_SHARE',
        currency: 'EUR',
        terms: {
          cessionPct: 30,
          cedingCommissionPct: 25,
          // Tenant-specific vocabulary not in the typed schema must survive.
          customClause: 'Sunset clause 36 months',
          internalScore: { model: 'v2', value: 0.87 },
          depositPct: 25,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const detail = await app.inject({ method: 'GET', url: `/api/treaties/${id}`, headers: auth });
    const terms = detail.json().terms as Record<string, unknown>;
    expect(terms.customClause).toBe('Sunset clause 36 months');
    expect(terms.internalScore).toEqual({ model: 'v2', value: 0.87 });
    expect(terms.cessionPct).toBe(30);
  });

  it('rejects out-of-range typed values (rateOnLine 150) with a 400', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Silly RoL Treaty',
        basis: 'NON_PROPORTIONAL',
        npType: 'CAT_XL',
        currency: 'USD',
        terms: { rateOnLine: 150 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().details)).toMatch(/rateOnLine/);
  });

  it('rejects a zero limit when an attachment is also present', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const res = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Zero Limit Layer Treaty',
        basis: 'NON_PROPORTIONAL',
        npType: 'CAT_XL',
        currency: 'USD',
        terms: { attachment: 1_000_000, limit: 0 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().details)).toMatch(/limit/);
  });
});
