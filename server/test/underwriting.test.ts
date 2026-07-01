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

  it('produces underwriting advice: clauses, gaps, flags, summary, similar risks', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: {
        title: 'Advisor cat XL', structure: 'CAT_XL', lineOfBusiness: 'PROPERTY', currency: 'USD',
        limit: 100_000_000, estPremium: 200_000, lossRatioPct: 120, catExposed: true, classHazard: 5,
        terms: { peril: 'Windstorm' },
      },
    });
    const id = create.json().id as string;
    const adv = await app.inject({ method: 'GET', url: `/api/underwriting/submissions/${id}/advisor`, headers: auth });
    expect(adv.statusCode).toBe(200);
    const body = adv.json();
    expect(body.clauses.some((c: { code: string }) => c.code === 'HOURS')).toBe(true);
    expect(body.missingInfo.length).toBeGreaterThan(0);
    // LR 120% and a thin rate on line should both flag.
    expect(body.flags.some((f: { code: string }) => f.code === 'LR_OVER_100')).toBe(true);
    expect(typeof body.executiveSummary).toBe('string');
    expect(body.executiveSummary.length).toBeGreaterThan(40);
    expect(Array.isArray(body.similar)).toBe(true);
  });

  it('manages the submission data room: register, extract, version, sign', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: { title: 'Data room test', structure: 'CAT_XL', lineOfBusiness: 'PROPERTY' },
    });
    const id = create.json().id as string;

    // Register a document — kind inferred from the name, extraction runs.
    const add = await app.inject({
      method: 'POST', url: `/api/underwriting/submissions/${id}/documents`, headers: auth,
      payload: { name: 'Acme_SOV_2026.xlsx' },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().kind).toBe('SOV');
    expect(add.json().extraction).toHaveProperty('confidence');
    const docId = add.json().id as string;

    // List shows it.
    const list = await app.inject({ method: 'GET', url: `/api/underwriting/submissions/${id}/documents`, headers: auth });
    expect(list.json().documents.length).toBe(1);

    // Supersede → new version, old marked SUPERSEDED.
    const sup = await app.inject({ method: 'POST', url: `/api/underwriting/documents/${docId}/supersede`, headers: auth, payload: { name: 'Acme_SOV_2026_rev.xlsx' } });
    expect(sup.statusCode).toBe(200);
    expect(sup.json().version).toBe(2);
    const newId = sup.json().id as string;

    // Sign the new version.
    const sign = await app.inject({ method: 'POST', url: `/api/underwriting/documents/${newId}/sign`, headers: auth, payload: {} });
    expect(sign.statusCode).toBe(200);
    expect(sign.json().signature).toMatch(/^sha-/);
    expect(sign.json().status).toBe('SIGNED');

    // Signing a superseded document is rejected.
    const badSign = await app.inject({ method: 'POST', url: `/api/underwriting/documents/${docId}/sign`, headers: auth, payload: {} });
    expect(badSign.statusCode).toBe(409);
  });

  it('tracks a renewal: rate change and retention in the renewal pipeline', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // The expiring contract (prior year).
    const prior = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: { title: 'Expiring QS 2025', structure: 'QUOTA_SHARE', estPremium: 1_000_000 },
    });
    const priorId = prior.json().id as string;

    // The renewal, 8% up on expiring premium.
    const renewal = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: auth,
      payload: { title: 'Renewal QS 2026', structure: 'QUOTA_SHARE', estPremium: 1_080_000, renewalOfId: priorId, expiringPremium: 1_000_000 },
    });
    expect(renewal.statusCode).toBe(201);
    const renewalId = renewal.json().id as string;

    const analytics = await app.inject({ method: 'GET', url: '/api/underwriting/analytics/renewal', headers: auth });
    expect(analytics.statusCode).toBe(200);
    const body = analytics.json();
    expect(body.book).toHaveProperty('retentionRatePct');
    const row = body.renewals.find((r: { id: string }) => r.id === renewalId);
    expect(row).toBeTruthy();
    expect(row.rateChangePct).toBe(8);
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

  it('returns claims, finance and retrocession integration dashboards', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const claims = await app.inject({ method: 'GET', url: '/api/underwriting/analytics/claims', headers: auth });
    expect(claims.statusCode).toBe(200);
    expect(claims.json()).toHaveProperty('lossRatioPct');
    expect(claims.json().technicalAccount).toHaveProperty('combinedRatioPct');
    expect(claims.json().frequencySeverity).toHaveProperty('severityMinor');

    const finance = await app.inject({ method: 'GET', url: '/api/underwriting/analytics/finance', headers: auth });
    expect(finance.statusCode).toBe(200);
    expect(finance.json().totals).toHaveProperty('premiumMinor');
    expect(Array.isArray(finance.json().cashflow)).toBe(true);

    const retro = await app.inject({ method: 'GET', url: '/api/underwriting/analytics/retro', headers: auth });
    expect(retro.statusCode).toBe(200);
    expect(retro.json().summary).toHaveProperty('cededPremiumMinor');
    expect(Array.isArray(retro.json().programmes)).toBe(true);
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

  it('runs the maker/checker referral: underwriter binds only after sign-off', async () => {
    if (!dbUp) return;
    const adminAuth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const uwAuth = { authorization: `Bearer ${await token(app, 'uw@demo.rios')}` };

    // A HIGH-risk submission → the matrix requires chief-underwriter sign-off.
    const create = await app.inject({
      method: 'POST', url: '/api/underwriting/submissions', headers: uwAuth,
      payload: { title: 'Referral flow cat', basis: 'NON_PROPORTIONAL', structure: 'CAT_XL', lossRatioPct: 95, catExposed: true, classHazard: 5, priorClaims: 4 },
    });
    const id = create.json().id as string;
    expect(create.json().riskBand).toBe('HIGH');

    // Advance to QUOTED with an approver (admin), then hand back to the underwriter.
    for (const to of ['TRIAGE', 'ANALYSIS', 'PRICING', 'QUOTED']) {
      await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: adminAuth, payload: { to } });
    }

    // The underwriter raises the referral: required level is CHIEF_UW.
    const refer = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/approvals`, headers: uwAuth, payload: {} });
    expect(refer.statusCode).toBe(200);
    expect(refer.json().referralRequired).toBe(true);
    expect(refer.json().level).toBe('CHIEF_UW');
    const approvalId = refer.json().approvalId as string;

    // Underwriter still cannot bind (no APPROVED referral yet).
    const blocked = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: uwAuth, payload: { to: 'BOUND' } });
    expect(blocked.statusCode).toBe(403);

    // Underwriter cannot self-approve (lacks the level's authority).
    const selfApprove = await app.inject({ method: 'POST', url: `/api/underwriting/approvals/${approvalId}/decision`, headers: uwAuth, payload: { decision: 'APPROVED' } });
    expect(selfApprove.statusCode).toBe(403);

    // The approver signs off, and the referral shows in the queue.
    const queue = await app.inject({ method: 'GET', url: '/api/underwriting/approvals?status=PENDING', headers: adminAuth });
    expect(queue.json().approvals.some((a: { id: string }) => a.id === approvalId)).toBe(true);
    const decide = await app.inject({ method: 'POST', url: `/api/underwriting/approvals/${approvalId}/decision`, headers: adminAuth, payload: { decision: 'APPROVED', note: 'Within appetite' } });
    expect(decide.statusCode).toBe(200);

    // Now the underwriter can bind.
    const bind = await app.inject({ method: 'POST', url: `/api/underwriting/submissions/${id}/transition`, headers: uwAuth, payload: { to: 'BOUND' } });
    expect(bind.statusCode).toBe(200);

    // Detail carries the approval history and the current requirement.
    const detail = await app.inject({ method: 'GET', url: `/api/underwriting/submissions/${id}`, headers: adminAuth });
    expect(detail.json().approvals.length).toBeGreaterThanOrEqual(1);
    expect(detail.json().approvalRequirement.level).toBe('CHIEF_UW');
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
