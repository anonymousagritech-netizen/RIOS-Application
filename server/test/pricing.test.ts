/**
 * Pricing / Rating integration test (brief §29.5):
 *   create contract → burning-cost run with round inputs → assert the exact
 *   technical premium → persist + retrieve the run (reproducibility).
 *
 * Requires a migrated + seeded database. Skips cleanly if Postgres is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { pricingModule } from '../src/modules/pricing.js';

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

describe('pricing: reproducible burning-cost run', () => {
  it('computes the expected technical premium and persists a retrievable run', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'Pricing Test Treaty', basis: 'NON_PROPORTIONAL', npType: 'PER_RISK_XL', currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const contractId = created.json().id as string;

    // Layer 4,000,000 xs 1,000,000. One year: subject premium 10,000,000, a 3,000,000 loss.
    //   layer loss = min(max(0, 3M - 1M), 4M) = 2,000,000
    //   pure burning cost = 2M / 10M = 0.2
    //   loaded = 0.2 × 1.25 = 0.25
    //   technical premium = 10,000,000 × 0.25 = 2,500,000  →  250,000,000 minor (USD)
    const run = await app.inject({
      method: 'POST', url: '/api/pricing/burning-cost', headers: auth,
      payload: {
        contractId,
        currency: 'USD',
        attachment: 1_000_000,
        limit: 4_000_000,
        loadingFactor: 1.25,
        currentSubjectPremium: 10_000_000,
        years: [{ year: 2024, subjectPremium: 10_000_000, losses: [3_000_000] }],
      },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();
    expect(body.method).toBe('BURNING_COST');
    expect(body.pureBurningCost).toBeCloseTo(0.2, 9);
    expect(body.loadedBurningCost).toBeCloseTo(0.25, 9);
    expect(body.technicalPremium.amount).toBe(250_000_000);
    expect(body.rateOnLine).toBeCloseTo(250_000_000 / 400_000_000, 9); // tp / limit (minor)
    const runId = body.id as string;

    // The run is retrievable with its full inputs + results (proves reproducibility, §29.5).
    const fetched = await app.inject({
      method: 'GET', url: `/api/pricing/runs/${runId}`, headers: auth,
    });
    expect(fetched.statusCode).toBe(200);
    const f = fetched.json();
    expect(f.method).toBe('BURNING_COST');
    expect(f.technicalPremiumMinor).toBe(250_000_000);
    expect(f.inputs.loadingFactor).toBe(1.25);
    expect(f.results.technicalPremium.amount).toBe(250_000_000);

    // It appears in the contract's run list.
    const list = await app.inject({
      method: 'GET', url: `/api/pricing/runs?contractId=${contractId}`, headers: auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs.some((r: { id: string }) => r.id === runId)).toBe(true);
  });

  it('runs exposure rating and persists a run', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const run = await app.inject({
      method: 'POST', url: '/api/pricing/exposure', headers: auth,
      payload: {
        currency: 'USD',
        attachment: 1_000_000,
        limit: 4_000_000,
        alpha: 1.5,
        bands: [{ bandLimit: 10_000_000, premium: 5_000_000, lossRatio: 0.6 }],
      },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();
    expect(body.method).toBe('EXPOSURE');
    expect(body.technicalPremium.amount).toBeGreaterThan(0);
    expect(body.id).toBeTruthy();
  });
});
