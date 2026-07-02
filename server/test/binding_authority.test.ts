/**
 * Binding / delegated authority integration test (brief §3; workbook
 * "binding-authority depth is a follow-on"). Mirrors underwriting.test.ts:
 * dbUp guard, demo token, buildApp/closePools.
 *
 * Proves: create a grant (line 1,000,000 / aggregate 5,000,000, Property, UK);
 * a within-limits check passes; an over-line check returns referralRequired and
 * records a LINE breach; usage accrues up to the aggregate; the next over-aggregate
 * record is rejected 409; an admin override succeeds; an expired-window check flags
 * EXPIRED.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

const M = (major: number) => major * 100;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('Binding authority: grant, check, usage, breach', () => {
  it('checks lines, records breaches, and enforces the aggregate with an admin override', async () => {
    if (!dbUp) return;
    const uw = { authorization: `Bearer ${await token(app, 'uw@demo.rios')}` };
    const admin = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // Create a Property / UK grant: 1,000,000 line, 5,000,000 aggregate.
    const create = await app.inject({
      method: 'POST', url: '/api/delegation/authorities', headers: uw,
      payload: {
        name: 'Test UK Property BA', lob: 'Property', territory: 'UK',
        maxLineMinor: M(1_000_000), maxAggregateMinor: M(5_000_000), currency: 'USD',
        validFrom: '2026-01-01', validTo: '2026-12-31',
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;

    // A within-limits, in-scope line passes with no referral.
    const ok = await app.inject({
      method: 'POST', url: `/api/delegation/authorities/${id}/check`, headers: uw,
      payload: { lob: 'Property', territory: 'UK', lineMinor: M(500_000), asOf: '2026-06-01' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().withinAuthority).toBe(true);
    expect(ok.json().referralRequired).toBe(false);

    // An over-line check refers up and records a LINE breach.
    const overLine = await app.inject({
      method: 'POST', url: `/api/delegation/authorities/${id}/check`, headers: uw,
      payload: { lob: 'Property', territory: 'UK', lineMinor: M(1_500_000), asOf: '2026-06-01' },
    });
    expect(overLine.statusCode).toBe(200);
    expect(overLine.json().referralRequired).toBe(true);
    expect(overLine.json().breaches).toContain('LINE');

    const breaches = await app.inject({ method: 'GET', url: `/api/delegation/authorities/${id}/breaches`, headers: uw });
    expect(breaches.statusCode).toBe(200);
    expect(breaches.json().breaches.some((b: { kind: string }) => b.kind === 'LINE')).toBe(true);

    // Record usage up to the aggregate (5 × 1,000,000 = 5,000,000).
    for (let i = 0; i < 5; i++) {
      const rec = await app.inject({
        method: 'POST', url: `/api/delegation/authorities/${id}/record-usage`, headers: uw,
        payload: { boundMinor: M(1_000_000), note: `line ${i + 1}` },
      });
      expect(rec.statusCode).toBe(201);
    }

    // The next record would exceed the aggregate — rejected 409.
    const over = await app.inject({
      method: 'POST', url: `/api/delegation/authorities/${id}/record-usage`, headers: uw,
      payload: { boundMinor: M(1_000_000) },
    });
    expect(over.statusCode).toBe(409);

    // A plain UW override is ignored (not admin) — still 409.
    const uwOverride = await app.inject({
      method: 'POST', url: `/api/delegation/authorities/${id}/record-usage`, headers: uw,
      payload: { boundMinor: M(1_000_000), override: true },
    });
    expect(uwOverride.statusCode).toBe(409);

    // An admin override succeeds and is audited as an override.
    const adminOverride = await app.inject({
      method: 'POST', url: `/api/delegation/authorities/${id}/record-usage`, headers: admin,
      payload: { boundMinor: M(1_000_000), override: true },
    });
    expect(adminOverride.statusCode).toBe(201);
    expect(adminOverride.json().overrode).toBe(true);

    // Detail reflects the consumed aggregate and the recorded breach.
    const detail = await app.inject({ method: 'GET', url: `/api/delegation/authorities/${id}`, headers: uw });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().consumedMinor).toBe(M(6_000_000));
    expect(detail.json().breaches.length).toBeGreaterThan(0);
  });

  it('flags EXPIRED when a line is checked outside the validity window', async () => {
    if (!dbUp) return;
    const uw = { authorization: `Bearer ${await token(app, 'uw@demo.rios')}` };
    const create = await app.inject({
      method: 'POST', url: '/api/delegation/authorities', headers: uw,
      payload: {
        name: 'Expiring BA', lob: 'Property', territory: 'UK',
        maxLineMinor: M(1_000_000), maxAggregateMinor: M(5_000_000), currency: 'USD',
        validFrom: '2026-01-01', validTo: '2026-12-31',
      },
    });
    const id = create.json().id as string;
    const expired = await app.inject({
      method: 'POST', url: `/api/delegation/authorities/${id}/check`, headers: uw,
      payload: { lob: 'Property', territory: 'UK', lineMinor: M(100_000), asOf: '2027-03-01' },
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json().breaches).toContain('EXPIRED');
    expect(expired.json().referralRequired).toBe(true);
  });

  it('suspends a grant so a later check breaches EXPIRED', async () => {
    if (!dbUp) return;
    const uw = { authorization: `Bearer ${await token(app, 'uw@demo.rios')}` };
    const create = await app.inject({
      method: 'POST', url: '/api/delegation/authorities', headers: uw,
      payload: { name: 'Suspendable BA', lob: 'Property', territory: 'UK', maxLineMinor: M(1_000_000), maxAggregateMinor: M(5_000_000), currency: 'USD' },
    });
    const id = create.json().id as string;
    const suspend = await app.inject({ method: 'POST', url: `/api/delegation/authorities/${id}/suspend`, headers: uw });
    expect(suspend.statusCode).toBe(200);
    const check = await app.inject({
      method: 'POST', url: `/api/delegation/authorities/${id}/check`, headers: uw,
      payload: { lob: 'Property', territory: 'UK', lineMinor: M(100_000), asOf: '2026-06-01' },
    });
    expect(check.json().breaches).toContain('EXPIRED');
  });
});
