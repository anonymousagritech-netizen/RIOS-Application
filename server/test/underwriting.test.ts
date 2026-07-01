/**
 * Underwriting Workbench integration test (brief §7 / §28).
 * Mirrors hr_attendance.test.ts: dbUp guard, demo token, buildApp/closePools.
 *
 * Proves the submission lifecycle: create (auto-scored) → price → advance through
 * the stage machine to BOUND, an illegal skip is rejected (409), risk re-score,
 * activity trail accrues, and KPIs reflect the pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('Underwriting: submission lifecycle', () => {
  it('creates, prices, advances to bound, rejects illegal skips, and logs activity', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // Create a cat-exposed, loss-heavy submission — should auto-score HIGH.
    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: {
        title: 'North Atlantic Property Cat XL 2026', kind: 'TREATY', basis: 'NON_PROPORTIONAL',
        structure: 'CAT_XL', currency: 'USD', estPremium: 5_000_000, lossRatioPct: 95,
        catExposed: true, classHazard: 5, priorClaims: 3, yearsWithCedent: 0, capacityUtilPct: 80,
      },
    });
    expect(create.statusCode).toBe(201);
    const { id, riskBand } = create.json();
    expect(riskBand).toBe('HIGH');

    // Price it: technical premium above the pure expected loss.
    const price = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/price`, headers: auth, payload: {} });
    expect(price.statusCode).toBe(200);
    expect(price.json().technicalPremiumMinor).toBeGreaterThan(price.json().expectedLossMinor);

    // Illegal skip SUBMISSION → BOUND must be rejected.
    const illegal = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
    expect(illegal.statusCode).toBe(409);

    // Walk the happy path to BOUND.
    for (const to of ['TRIAGE', 'ANALYSIS', 'PRICING', 'REFERRAL', 'QUOTED', 'BOUND']) {
      const t = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: auth, payload: { to } });
      expect(t.statusCode).toBe(200);
      expect(t.json().to).toBe(to);
    }

    // A bound submission cannot move again.
    const afterBound = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: auth, payload: { to: 'DECLINED' } });
    expect(afterBound.statusCode).toBe(409);

    // Detail carries the score breakdown + a full activity trail.
    const detail = await app.inject({ method: 'GET', url: `/api/underwriting/submissions/${id}`, headers: auth });
    const body = detail.json();
    expect(body.stage).toBe('BOUND');
    expect(Array.isArray(body.scoreBreakdown)).toBe(true);
    expect(body.scoreBreakdown.length).toBeGreaterThan(0);
    // CREATE + PRICE + 6 stage moves = at least 8 activity rows.
    expect(body.activity.length).toBeGreaterThanOrEqual(8);

    // KPIs reflect at least one bound submission and a hit ratio.
    const kpis = await app.inject({ method: 'GET', url: '/api/underwriting/kpis', headers: auth });
    expect(kpis.json().bound).toBeGreaterThanOrEqual(1);
  });

  it('re-scores from stored factors', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: { title: 'Benign QS', basis: 'PROPORTIONAL', structure: 'QUOTA_SHARE', lossRatioPct: 20, yearsWithCedent: 5, classHazard: 1 },
    });
    const id = create.json().id as string;
    const score = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/score`, headers: auth, payload: {} });
    expect(score.statusCode).toBe(200);
    expect(score.json().riskBand).toBe('LOW');
  });
});
