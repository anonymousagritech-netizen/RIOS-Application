/**
 * Retro cession allocation engine integration test (Tier-2 gap #10):
 *   bind an inward treaty (books DEPOSIT_PREMIUM) → create an outward retro
 *   contract → QUOTA_SHARE 25% PREMIUM rule → run allocation → exactly 25% of
 *   the deposit premium is ceded onto the retro contract; a re-run allocates
 *   nothing (idempotent via the UNIQUE constraint); the trace links source →
 *   rule → ceded event; and a claim CASH_LOSS event allocates under a CLAIM rule.
 *
 * The test's rules filter on a unique line of business so runs only touch the
 * events this file creates, keeping assertions exact even on a shared DB.
 * Requires a migrated + seeded database; skips cleanly when Postgres is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

const LOB = `retro_alloc_${Date.now()}`;
const DEPOSIT_MINOR = 10_000_000; // $100,000
const CASH_LOSS_MINOR = 4_000_000; // $40,000

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

describe('retro cession allocation engine', () => {
  let auth: { authorization: string };
  let inwardId: string;
  let retroId: string;
  let premiumRuleId: string;

  it('binds an inward treaty, creates a retro contract and a 25% PREMIUM rule', async () => {
    if (!dbUp) return; // environment without Postgres
    auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // Inward treaty with a $100,000 deposit premium, on a LOB unique to this run.
    const created = await app.inject({
      method: 'POST',
      url: '/api/treaties',
      headers: auth,
      payload: {
        name: 'Retro Allocation Inward Treaty',
        basis: 'NON_PROPORTIONAL',
        npType: 'CAT_XL',
        currency: 'USD',
        lineOfBusiness: LOB,
        terms: { currency: 'USD', depositPremium: 100000 },
      },
    });
    expect(created.statusCode).toBe(201);
    inwardId = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${inwardId}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    const bound = await app.inject({ method: 'POST', url: `/api/treaties/${inwardId}/transition`, headers: auth, payload: { to: 'BOUND' } });
    expect(bound.statusCode).toBe(200);
    const booked = bound.json().financialEvents as Array<{ eventType: string; amountMinor: number }>;
    expect(booked[0]!.eventType).toBe('DEPOSIT_PREMIUM');
    expect(booked[0]!.amountMinor).toBe(DEPOSIT_MINOR);

    // Outward retro protection via the module's existing creation path.
    const retro = await app.inject({
      method: 'POST',
      url: '/api/retrocession',
      headers: auth,
      payload: { name: 'Retro Allocation QS Protection', basis: 'PROPORTIONAL', currency: 'USD' },
    });
    expect(retro.statusCode).toBe(201);
    retroId = retro.json().id as string;

    // 25% quota-share premium cession, scoped to this run's LOB.
    const rule = await app.inject({
      method: 'POST',
      url: '/api/retrocession/allocation-rules',
      headers: auth,
      payload: { retroContractId: retroId, name: 'QS 25% premium', appliesTo: 'PREMIUM', lob: LOB, cessionPct: 25 },
    });
    expect(rule.statusCode).toBe(201);
    premiumRuleId = rule.json().id as string;
    expect(rule.json().active).toBe(true);

    // The rule cannot target an inward contract.
    const badTarget = await app.inject({
      method: 'POST',
      url: '/api/retrocession/allocation-rules',
      headers: auth,
      payload: { retroContractId: inwardId, name: 'illegal', appliesTo: 'PREMIUM', cessionPct: 25 },
    });
    expect(badTarget.statusCode).toBe(404);

    // Validation gate: pct out of range → 400.
    const badPct = await app.inject({
      method: 'POST',
      url: '/api/retrocession/allocation-rules',
      headers: auth,
      payload: { retroContractId: retroId, name: 'bad pct', appliesTo: 'PREMIUM', cessionPct: 120 },
    });
    expect(badPct.statusCode).toBe(400);
  });

  it('run allocates exactly 25% of the deposit premium onto the retro contract', async () => {
    if (!dbUp) return;
    const run = await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    expect(run.statusCode).toBe(200);
    // The run is tenant-wide and idempotent; under parallel tests a concurrent
    // run may have already inserted this allocation (reported as skipped), so
    // assert the robust invariant. The per-contract trace below is the exact check.
    expect(run.json().allocated + run.json().skipped).toBeGreaterThanOrEqual(1);

    // Trace filtered to our inward contract: exactly one allocation, 25% of the deposit.
    const trace = await app.inject({ method: 'GET', url: `/api/retrocession/allocations?contractId=${inwardId}`, headers: auth });
    expect(trace.statusCode).toBe(200);
    const allocations = trace.json().allocations as Array<{
      ruleId: string; sourceEventType: string; sourceAmountMinor: number;
      amountMinor: number; currency: string; retroContractId: string; cededEventId: string | null;
    }>;
    expect(allocations).toHaveLength(1);
    const alloc = allocations[0]!;
    expect(alloc.ruleId).toBe(premiumRuleId);
    expect(alloc.sourceEventType).toBe('DEPOSIT_PREMIUM');
    expect(alloc.sourceAmountMinor).toBe(DEPOSIT_MINOR);
    expect(alloc.amountMinor).toBe(DEPOSIT_MINOR / 4); // exactly 25% in minor units
    expect(alloc.currency).toBe('USD');
    expect(alloc.retroContractId).toBe(retroId);
    expect(alloc.cededEventId).toBeTruthy();

    // The ceded event exists on the retro contract, same vocabulary as the source.
    const events = await app.inject({ method: 'GET', url: `/api/treaties/${retroId}/financial-events`, headers: auth });
    const ceded = (events.json().events as Array<{ id: string; eventType: string; direction: string; amountMinor: number }>).find(
      (e) => e.id === alloc.cededEventId,
    );
    expect(ceded).toBeDefined();
    expect(ceded!.eventType).toBe('DEPOSIT_PREMIUM');
    expect(ceded!.direction).toBe('DR');
    expect(ceded!.amountMinor).toBe(DEPOSIT_MINOR / 4);
  });

  it('re-running allocates nothing (idempotent) and skips the already-allocated pair', async () => {
    if (!dbUp) return;
    const rerun = await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    expect(rerun.statusCode).toBe(200);
    expect(rerun.json().allocated).toBe(0);
    expect(rerun.json().skipped).toBeGreaterThanOrEqual(1);
    expect(rerun.json().totalByCurrency).toEqual({});

    // Still exactly one allocation for the inward contract - never doubled.
    const trace = await app.inject({ method: 'GET', url: `/api/retrocession/allocations?contractId=${inwardId}`, headers: auth });
    expect((trace.json().allocations as unknown[]).length).toBe(1);
  });

  it('a claim CASH_LOSS event allocates under a CLAIM rule', async () => {
    if (!dbUp) return;

    // 30% claim cession to the same retro contract, same unique LOB.
    const rule = await app.inject({
      method: 'POST',
      url: '/api/retrocession/allocation-rules',
      headers: auth,
      payload: { retroContractId: retroId, name: 'QS 30% claims', appliesTo: 'CLAIM', lob: LOB, cessionPct: 30 },
    });
    expect(rule.statusCode).toBe(201);
    const claimRuleId = rule.json().id as string;

    // Book a CASH_LOSS on the inward treaty via the claims endpoints.
    const claim = await app.inject({
      method: 'POST',
      url: '/api/claims',
      headers: auth,
      payload: { contractId: inwardId, currency: 'USD', grossLoss: 500000, description: 'Retro allocation claim' },
    });
    expect(claim.statusCode).toBe(201);
    const claimId = claim.json().id as string;
    const call = await app.inject({
      method: 'POST',
      url: `/api/claims/${claimId}/cash-call`,
      headers: auth,
      payload: { amount: 40000 },
    });
    expect(call.statusCode).toBe(200);
    expect(call.json().amountMinor).toBe(CASH_LOSS_MINOR);

    const run = await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    expect(run.statusCode).toBe(200);
    // The CLAIM rule × the CASH_LOSS event is allocated (by this run or, under
    // parallel tests, already present idempotently). The per-contract trace below
    // is the exact check; the tenant-wide run's global counters/totals are not
    // asserted because a shared-tenant concurrent run makes them non-deterministic.
    expect(run.json().allocated + run.json().skipped).toBeGreaterThanOrEqual(1);

    const trace = await app.inject({ method: 'GET', url: `/api/retrocession/allocations?contractId=${inwardId}`, headers: auth });
    const allocations = trace.json().allocations as Array<{
      ruleId: string; sourceEventType: string; amountMinor: number; cededEventId: string | null;
    }>;
    expect(allocations).toHaveLength(2);
    const lossAlloc = allocations.find((a) => a.ruleId === claimRuleId)!;
    expect(lossAlloc.sourceEventType).toBe('CASH_LOSS');
    expect(lossAlloc.amountMinor).toBe(CASH_LOSS_MINOR * 0.3); // 30% of $40,000

    // The ceded loss lands on the retro contract as a CR (recovery owed to the tenant).
    const events = await app.inject({ method: 'GET', url: `/api/treaties/${retroId}/financial-events`, headers: auth });
    const cededLoss = (events.json().events as Array<{ id: string; eventType: string; direction: string; amountMinor: number }>).find(
      (e) => e.id === lossAlloc.cededEventId,
    );
    expect(cededLoss).toBeDefined();
    expect(cededLoss!.eventType).toBe('CASH_LOSS');
    expect(cededLoss!.direction).toBe('CR');
    expect(cededLoss!.amountMinor).toBe(CASH_LOSS_MINOR * 0.3);
  });

  it('deactivating a rule stops future allocation and is reflected in the list', async () => {
    if (!dbUp) return;
    const off = await app.inject({
      method: 'POST',
      url: `/api/retrocession/allocation-rules/${premiumRuleId}/deactivate`,
      headers: auth,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/api/retrocession/allocation-rules', headers: auth });
    expect(list.statusCode).toBe(200);
    const mine = (list.json().rules as Array<{ id: string; active: boolean; cessionPct: number }>).find(
      (r) => r.id === premiumRuleId,
    );
    expect(mine).toBeDefined();
    expect(mine!.active).toBe(false);
    expect(Number(mine!.cessionPct)).toBe(25);
  });
});

// Bind an inward treaty on a unique LOB with a $50,000 deposit premium and
// return its id. Isolating each method's test behind its own LOB keeps the
// allocation totals exact on a shared DB.
async function bindInward(app: FastifyInstance, auth: { authorization: string }, lob: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/treaties',
    headers: auth,
    payload: {
      name: `Retro method inward ${lob}`,
      basis: 'NON_PROPORTIONAL',
      npType: 'CAT_XL',
      currency: 'USD',
      lineOfBusiness: lob,
      terms: { currency: 'USD', depositPremium: 50000 },
    },
  });
  const id = created.json().id as string;
  await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
  await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
  return id;
}

describe('retro cession methods: SURPLUS and XL', () => {
  let auth: { authorization: string };
  const SURPLUS_LOB = `retro_surplus_${Date.now()}`;
  const XL_LOB = `retro_xl_${Date.now()}`;
  const DEPOSIT = 5_000_000; // $50,000 deposit premium (source basis)

  it('richer create persists period and typed slip terms', async () => {
    if (!dbUp) return;
    auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const retro = await app.inject({
      method: 'POST',
      url: '/api/retrocession',
      headers: auth,
      payload: {
        name: 'Retro Surplus Programme 2026',
        basis: 'PROPORTIONAL',
        proportionalType: 'SURPLUS',
        currency: 'USD',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        terms: { attachment: 10000, limit: 90000, premium: 12000, commissionPct: 15, retentionLines: 10000, maxLines: 9 },
      },
    });
    expect(retro.statusCode).toBe(201);
    const retroId = retro.json().id as string;

    // Period is on the contract row (list projection).
    const list = await app.inject({ method: 'GET', url: '/api/retrocession', headers: auth });
    const mine = (list.json().retrocession as Array<{ id: string; periodStart: string | null; periodEnd: string | null; basis: string }>).find(
      (r) => r.id === retroId,
    );
    expect(mine).toBeDefined();
    expect(mine!.periodStart).toBe('2026-01-01');
    expect(mine!.periodEnd).toBe('2026-12-31');
    expect(mine!.basis).toBe('PROPORTIONAL');

    // Slip terms are in the contract's term set (fetched via the shared contract loader).
    const detail = await app.inject({ method: 'GET', url: `/api/treaties/${retroId}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    const terms = detail.json().terms as Record<string, number>;
    expect(terms.attachment).toBe(10000);
    expect(terms.limit).toBe(90000);
    expect(terms.premium).toBe(12000);
    expect(terms.commissionPct).toBe(15);
  });

  it('a SURPLUS rule cedes the surplus above the retention, idempotently', async () => {
    if (!dbUp) return;
    const inwardId = await bindInward(app, auth, SURPLUS_LOB);
    const retro = await app.inject({
      method: 'POST',
      url: '/api/retrocession',
      headers: auth,
      payload: { name: 'Retro Surplus Cover', basis: 'PROPORTIONAL', proportionalType: 'SURPLUS', currency: 'USD' },
    });
    const retroId = retro.json().id as string;

    // Retention $10,000 (1,000,000 minor), 9 lines: surplus of the $50,000 deposit
    // = 4,000,000 minor (< capacity 9,000,000), so exactly 4,000,000 is ceded.
    const rule = await app.inject({
      method: 'POST',
      url: '/api/retrocession/allocation-rules',
      headers: auth,
      payload: { retroContractId: retroId, name: 'Surplus 9 lines', appliesTo: 'PREMIUM', lob: SURPLUS_LOB, method: 'SURPLUS', retentionMinor: 1_000_000, maxLines: 9 },
    });
    expect(rule.statusCode).toBe(201);
    expect(rule.json().method).toBe('SURPLUS');
    const surplusRuleId = rule.json().id as string;

    // A SURPLUS rule missing its params is a 400.
    const bad = await app.inject({
      method: 'POST',
      url: '/api/retrocession/allocation-rules',
      headers: auth,
      payload: { retroContractId: retroId, name: 'bad surplus', appliesTo: 'PREMIUM', method: 'SURPLUS' },
    });
    expect(bad.statusCode).toBe(400);

    const run = await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    expect(run.statusCode).toBe(200);

    const trace = await app.inject({ method: 'GET', url: `/api/retrocession/allocations?contractId=${inwardId}`, headers: auth });
    const allocations = trace.json().allocations as Array<{ ruleId: string; amountMinor: number; cededEventId: string | null }>;
    const mine = allocations.filter((a) => a.ruleId === surplusRuleId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.amountMinor).toBe(4_000_000);
    expect(mine[0]!.cededEventId).toBeTruthy();

    // Re-run is idempotent: no new allocation for this rule.
    const rerun = await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    expect(rerun.statusCode).toBe(200);
    const trace2 = await app.inject({ method: 'GET', url: `/api/retrocession/allocations?contractId=${inwardId}`, headers: auth });
    expect((trace2.json().allocations as Array<{ ruleId: string }>).filter((a) => a.ruleId === surplusRuleId)).toHaveLength(1);
  });

  it('an XL rule cedes the layer of the source, idempotently', async () => {
    if (!dbUp) return;
    const inwardId = await bindInward(app, auth, XL_LOB);
    const retro = await app.inject({
      method: 'POST',
      url: '/api/retrocession',
      headers: auth,
      payload: { name: 'Retro XL Cover', basis: 'NON_PROPORTIONAL', npType: 'PER_RISK_XL', currency: 'USD' },
    });
    const retroId = retro.json().id as string;

    // Layer $20,000 xs $10,000 (limit 2,000,000, attachment 1,000,000): the
    // $50,000 deposit excess is 4,000,000, capped to the 2,000,000 limit.
    const rule = await app.inject({
      method: 'POST',
      url: '/api/retrocession/allocation-rules',
      headers: auth,
      payload: { retroContractId: retroId, name: 'XL 20 xs 10', appliesTo: 'PREMIUM', lob: XL_LOB, method: 'XL', attachmentMinor: 1_000_000, limitMinor: 2_000_000 },
    });
    expect(rule.statusCode).toBe(201);
    expect(rule.json().method).toBe('XL');
    const xlRuleId = rule.json().id as string;

    const run = await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    expect(run.statusCode).toBe(200);

    const trace = await app.inject({ method: 'GET', url: `/api/retrocession/allocations?contractId=${inwardId}`, headers: auth });
    const mine = (trace.json().allocations as Array<{ ruleId: string; amountMinor: number; cededEventId: string | null }>).filter(
      (a) => a.ruleId === xlRuleId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.amountMinor).toBe(2_000_000); // capped at the layer limit
    expect(mine[0]!.cededEventId).toBeTruthy();

    // Idempotent re-run.
    await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    const trace2 = await app.inject({ method: 'GET', url: `/api/retrocession/allocations?contractId=${inwardId}`, headers: auth });
    expect((trace2.json().allocations as Array<{ ruleId: string }>).filter((a) => a.ruleId === xlRuleId)).toHaveLength(1);
  });
});
