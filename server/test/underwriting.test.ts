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

describe('Underwriting: analytics, scenarios & approval matrix', () => {
  it('returns portfolio, risk and CAT analytics', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const portfolio = await app.inject({ method: 'GET', url: '/api/underwriting/analytics/portfolio', headers: auth });
    expect(portfolio.statusCode).toBe(200);
    expect(portfolio.json()).toHaveProperty('byStructure');
    expect(portfolio.json()).toHaveProperty('topCedents');

    const risk = await app.inject({ method: 'GET', url: '/api/underwriting/analytics/risk', headers: auth });
    expect(risk.statusCode).toBe(200);
    expect(Array.isArray(risk.json().heatmap)).toBe(true);

    const cat = await app.inject({ method: 'GET', url: '/api/underwriting/analytics/cat', headers: auth });
    expect(cat.statusCode).toBe(200);
    expect(cat.json()).toHaveProperty('bookEpCurve');
    expect(Array.isArray(cat.json().bookEpCurve)).toBe(true);
  });

  it('serves the model catalog and flags incomplete slip terms', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // The catalog is the declarative structure × line-of-business registry.
    const cat = await app.inject({ method: 'GET', url: '/api/underwriting/models', headers: auth });
    expect(cat.statusCode).toBe(200);
    const body = cat.json();
    expect(Array.isArray(body.structures)).toBe(true);
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.structures.some((s: { key: string }) => s.key === 'CAT_XL')).toBe(true);
    expect(body.lines.some((l: { key: string }) => l.key === 'AGRICULTURE')).toBe(true);

    // A CAT_XL / PROPERTY submission missing required model terms is created but
    // the response reports the gaps.
    const incomplete = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: { title: 'Cat XL missing terms', structure: 'CAT_XL', lineOfBusiness: 'PROPERTY', terms: { peril: 'Earthquake' } },
    });
    expect(incomplete.statusCode).toBe(201);
    expect(incomplete.json().termsCheck.ok).toBe(false);
    expect(incomplete.json().termsCheck.missing).toContain('attachmentMinor');

    // A fully-specified slip validates clean and round-trips its terms.
    const complete = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: {
        title: 'Cat XL complete', structure: 'CAT_XL', lineOfBusiness: 'PROPERTY',
        terms: { attachmentMinor: 100_000_000, limitMinor: 500_000_000, peril: 'Windstorm', totalInsuredValueMinor: 900_000_000 },
      },
    });
    expect(complete.json().termsCheck.ok).toBe(true);
    const id = complete.json().id as string;
    const detail = await app.inject({ method: 'GET', url: `/api/underwriting/submissions/${id}`, headers: auth });
    expect(detail.json().terms.peril).toBe('Windstorm');
    expect(detail.json().termsCheck.ok).toBe(true);
  });

  it('exports the pipeline as CSV', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/underwriting/export.csv', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const body = res.body as string;
    const header = body.split('\n')[0];
    expect(header).toContain('Reference');
    expect(header).toContain('Technical premium (major)');
    // At least a header + one data row from earlier submissions.
    expect(body.split('\n').length).toBeGreaterThan(1);
  });

  it('builds a pricing scenario grid for a submission', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: { title: 'Scenario QS', estPremium: 5_000_000, lossRatioPct: 60 },
    });
    const id = create.json().id as string;
    const sc = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/scenarios`, headers: auth, payload: {} });
    expect(sc.statusCode).toBe(200);
    expect(sc.json().grid.length).toBeGreaterThan(0);
    expect(sc.json().base).toHaveProperty('combinedRatioPct');
  });

  it('blocks a non-approver from binding a HIGH-risk submission (403)', async () => {
    if (!dbUp) return;
    const adminAuth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    // uw@demo has treaty:write but NOT underwriting:approve / admin:manage.
    const uwAuth = { authorization: `Bearer ${await token(app, 'uw@demo.rios')}` };

    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: adminAuth,
      payload: { title: 'High risk cat', basis: 'NON_PROPORTIONAL', structure: 'CAT_XL', lossRatioPct: 95, catExposed: true, classHazard: 5, priorClaims: 4 },
    });
    expect(create.json().riskBand).toBe('HIGH');
    const id = create.json().id as string;
    // Advance to QUOTED with admin (who can approve).
    for (const to of ['TRIAGE', 'ANALYSIS', 'PRICING', 'QUOTED']) {
      await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: adminAuth, payload: { to } });
    }
    // The junior underwriter cannot bind a HIGH-risk submission.
    const uwBind = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: uwAuth, payload: { to: 'BOUND' } });
    expect(uwBind.statusCode).toBe(403);
    // The approver (admin) can.
    const adminBind = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: adminAuth, payload: { to: 'BOUND' } });
    expect(adminBind.statusCode).toBe(200);
  });
});
