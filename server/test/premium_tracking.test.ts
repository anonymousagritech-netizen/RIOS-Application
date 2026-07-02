/**
 * Premium tracking / M&D adjustment integration test (gap-analysis Tier-2 #7):
 *   create rated XL treaty (EPI / minimum / deposit / rate) → bind (books the
 *   deposit premium) → adjust on actual GNPI (books rate x GNPI − deposit as an
 *   ADJUSTMENT_PREMIUM) → re-run same GNPI books nothing (idempotent) → the
 *   premium-tracking endpoint reflects the new booked total.
 *
 * Requires a migrated + seeded database reachable via DATABASE_URL/DATABASE_APP_URL.
 * Skips cleanly if the DB is unreachable so it never produces a false failure in an
 * environment without PG.
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

// EPI 5,000,000 at 2% => expected premium 100,000; minimum 90,000; deposit 80,000.
// rate x actual GNPI > minimum > deposit for actual GNPI 6,000,000 (=> 120,000).
const TERMS = {
  currency: 'USD',
  estimatedPremiumIncome: 5_000_000,
  minimumPremium: 90_000, // passthrough key (see resolvePremiumTerms)
  depositPremium: 80_000,
  premiumRatePct: 2, // passthrough key: adjustable rate on GNPI
};

async function createTreaty(
  app: FastifyInstance,
  auth: { authorization: string },
  terms: Record<string, unknown> = TERMS,
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/treaties',
    headers: auth,
    payload: {
      name: 'Premium Tracking XL',
      basis: 'NON_PROPORTIONAL',
      npType: 'CAT_XL',
      currency: 'USD',
      terms,
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}

async function bind(app: FastifyInstance, auth: { authorization: string }, id: string): Promise<void> {
  await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
  const bound = await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
  expect(bound.json().status).toBe('BOUND');
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

describe('premium tracking: EPI vs booked with M&D adjustment on actual GNPI', () => {
  it('books rate x GNPI − deposit exactly, idempotently, and tracks the booked total', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const contractId = await createTreaty(app, auth);
    await bind(app, auth, contractId);

    // Binding booked the deposit premium as a DEPOSIT_PREMIUM financial event.
    const events = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/financial-events`, headers: auth });
    const deposit = (events.json().events as Array<{ eventType: string; amountMinor: number; direction: string }>).find(
      (e) => e.eventType === 'DEPOSIT_PREMIUM',
    );
    expect(deposit).toBeTruthy();
    expect(deposit!.amountMinor).toBe(8_000_000); // $80,000
    expect(deposit!.direction).toBe('DR');

    // Tracking endpoint: EPI/minimum/deposit/rate from terms, deposit booked.
    const tracking = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/premium-tracking`, headers: auth });
    expect(tracking.statusCode).toBe(200);
    const t = tracking.json();
    expect(t.epiMinor).toBe(500_000_000); // $5,000,000
    expect(t.minimumPremiumMinor).toBe(9_000_000); // $90,000
    expect(t.depositPremiumMinor).toBe(8_000_000); // $80,000
    expect(t.premiumRatePct).toBe(2);
    expect(t.bookedPremiumMinor).toBe(8_000_000);
    expect(t.bookedPremiumByCurrency).toEqual([{ currency: 'USD', bookedMinor: 8_000_000, eventCount: 1 }]);

    // Projection at actual GNPI 6,000,000: final 120,000, adjustment 40,000.
    const projected = await app.inject({
      method: 'GET',
      url: `/api/treaties/${contractId}/premium-tracking?gnpi=6000000`,
      headers: auth,
    });
    expect(projected.json().projection).toEqual({
      actualGnpiMinor: 600_000_000,
      indicatedPremiumMinor: 12_000_000,
      finalPremiumMinor: 12_000_000,
      projectedAdjustmentMinor: 4_000_000,
      minimumApplied: false,
    });

    // Adjustment run: rate x GNPI (120,000) > minimum (90,000) > deposit (80,000)
    // => books exactly 120,000 − 80,000 = $40,000 additional premium (DR).
    const run = await app.inject({
      method: 'POST',
      url: `/api/treaties/${contractId}/premium-adjustment`,
      headers: auth,
      payload: { actualGnpi: 6_000_000 },
    });
    expect(run.statusCode).toBe(200);
    const r = run.json();
    expect(r.indicatedPremiumMinor).toBe(12_000_000);
    expect(r.minimumPremiumMinor).toBe(9_000_000);
    expect(r.finalPremiumMinor).toBe(12_000_000);
    expect(r.bookedBeforeMinor).toBe(8_000_000);
    expect(r.adjustmentMinor).toBe(4_000_000); // rate x GNPI − deposit, exact minor units
    expect(r.minimumApplied).toBe(false);
    expect(r.booked).toBe(true);
    expect(r.direction).toBe('DR');
    expect(r.eventId).toBeTruthy();

    // The ADJUSTMENT_PREMIUM event is on the contract's financial-events feed.
    const after = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/financial-events`, headers: auth });
    const adj = (after.json().events as Array<{ eventType: string; amountMinor: number; direction: string }>).filter(
      (e) => e.eventType === 'ADJUSTMENT_PREMIUM',
    );
    expect(adj.length).toBe(1);
    expect(adj[0]!.amountMinor).toBe(4_000_000);
    expect(adj[0]!.direction).toBe('DR');

    // Idempotency: same GNPI again books zero incremental adjustment.
    const rerun = await app.inject({
      method: 'POST',
      url: `/api/treaties/${contractId}/premium-adjustment`,
      headers: auth,
      payload: { actualGnpi: 6_000_000 },
    });
    expect(rerun.statusCode).toBe(200);
    expect(rerun.json().adjustmentMinor).toBe(0);
    expect(rerun.json().booked).toBe(false);
    expect(rerun.json().eventId).toBeNull();
    expect(rerun.json().bookedBeforeMinor).toBe(12_000_000); // deposit + first adjustment

    const eventsAfterRerun = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/financial-events`, headers: auth });
    const adjCount = (eventsAfterRerun.json().events as Array<{ eventType: string }>).filter(
      (e) => e.eventType === 'ADJUSTMENT_PREMIUM',
    ).length;
    expect(adjCount).toBe(1); // no double-booking

    // Tracking reflects the new booked total = final premium.
    const trackingAfter = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/premium-tracking`, headers: auth });
    expect(trackingAfter.json().bookedPremiumMinor).toBe(12_000_000);
  });

  it('books a return premium (CR) when the actual GNPI drops the final premium below booked', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Deposit 120,000 booked on binding; actual GNPI 3,000,000 => indicated
    // 60,000 < minimum 90,000 => final 90,000 => return premium 30,000 (CR).
    const contractId = await createTreaty(app, auth, { ...TERMS, depositPremium: 120_000 });
    await bind(app, auth, contractId);

    const run = await app.inject({
      method: 'POST',
      url: `/api/treaties/${contractId}/premium-adjustment`,
      headers: auth,
      payload: { actualGnpi: 3_000_000 },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().finalPremiumMinor).toBe(9_000_000);
    expect(run.json().minimumApplied).toBe(true);
    expect(run.json().adjustmentMinor).toBe(-3_000_000);
    expect(run.json().direction).toBe('CR');

    const events = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/financial-events`, headers: auth });
    const adj = (events.json().events as Array<{ eventType: string; amountMinor: number; direction: string }>).find(
      (e) => e.eventType === 'ADJUSTMENT_PREMIUM',
    );
    expect(adj).toBeTruthy();
    expect(adj!.amountMinor).toBe(3_000_000); // stored positive, direction carries the sign
    expect(adj!.direction).toBe('CR');

    // Signed booked total is now the minimum premium.
    const tracking = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/premium-tracking`, headers: auth });
    expect(tracking.json().bookedPremiumMinor).toBe(9_000_000);
  });

  it('rejects adjustment on a non-BOUND contract (409) and missing term keys (400)', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Not bound: 409.
    const draftId = await createTreaty(app, auth);
    const notBound = await app.inject({
      method: 'POST',
      url: `/api/treaties/${draftId}/premium-adjustment`,
      headers: auth,
      payload: { actualGnpi: 1_000_000 },
    });
    expect(notBound.statusCode).toBe(409);
    expect(notBound.json().error).toContain('BOUND');

    // Bound but no rate / minimum in terms: 400 naming the missing keys.
    const bareId = await createTreaty(app, auth, { currency: 'USD' });
    await bind(app, auth, bareId);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/treaties/${bareId}/premium-adjustment`,
      headers: auth,
      payload: { actualGnpi: 1_000_000 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain('premiumRatePct (or rateOnLine)');
    expect(missing.json().error).toContain('minimumPremium (or minimumAndDepositPremium)');

    // Invalid body: negative GNPI is rejected by the schema.
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/treaties/${draftId}/premium-adjustment`,
      headers: auth,
      payload: { actualGnpi: -1 },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
