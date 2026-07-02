/**
 * Governed reserving workflow integration test (Tier-3 gap #13):
 *   triangle -> IBNR recommendation (the @rios/domain chain-ladder engine's exact
 *   output) -> maker/checker approval (self-approve -> 403, wrong permission ->
 *   403) -> GL booking as a balanced journal through the existing ledger path
 *   (double-book -> 409) -> actual-vs-expected monitoring with a cumulative
 *   deviation from the pure domain helper.
 *
 * Requires a migrated + seeded database reachable via DATABASE_URL/DATABASE_APP_URL.
 * Skips cleanly if the DB is unreachable so it never produces a false failure in an
 * environment without PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { developmentFactors, projectUltimate, actualVsExpected } from '@rios/domain';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

// Cumulative paid triangle in MAJOR units (USD): the same shape the domain
// unit tests use, so every figure is hand-checkable.
const TRIANGLE = [
  [1000, 1500, 1800], // origin 0: fully developed
  [1200, 1800],       // origin 1: to age 1
  [900],              // origin 2: to age 0
];
const TRIANGLE_MINOR = TRIANGLE.map((row) => row.map((v) => v * 100));

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

describe('governed reserving workflow: triangle -> IBNR -> approval -> GL -> AvE', () => {
  let maker: { authorization: string };   // admin creates the study
  let checker: { authorization: string }; // accountant approves it
  let studyId: string;
  let recommendationMinor: number;

  it('creates a study whose recommendation is exactly the domain chain-ladder output', async () => {
    if (!dbUp) return; // environment without Postgres
    maker = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    checker = { authorization: `Bearer ${await token(app, 'acct@demo.rios')}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/reserving/studies',
      headers: maker,
      payload: { name: 'Q2 2026 IBNR study', asOf: '2026-06-30', lob: 'property_cat', currency: 'USD', triangle: TRIANGLE },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    studyId = body.id as string;
    expect(body.status).toBe('RECOMMENDED');
    expect(body.method).toBe('CHAIN_LADDER');

    // The recommendation must equal the domain engine's output on the same
    // minor-unit triangle - the server orchestrates, it never re-implements.
    const factors = developmentFactors(TRIANGLE_MINOR);
    const projection = projectUltimate(TRIANGLE_MINOR, factors);
    expect(body.recommendationMinor).toBe(projection.ibnrMinor);
    expect(body.recommendationMinor).toBe(108_000); // $1,080.00 - hand-checkable
    expect(body.developmentFactors).toEqual(factors);
    expect(body.latestMinor).toBe(projection.latestMinor);
    expect(body.ultimateMinor).toBe(projection.totalUltimateMinor);
    recommendationMinor = body.recommendationMinor as number;

    // The generated rationale names the method and shows the development factors.
    expect(String(body.rationale)).toContain('chain-ladder');
    for (const f of factors) expect(String(body.rationale)).toContain(String(f));

    // It shows up on the list for readers.
    const list = await app.inject({ method: 'GET', url: '/api/reserving/studies', headers: checker });
    expect(list.statusCode).toBe(200);
    expect((list.json().studies as Array<{ id: string }>).some((s) => s.id === studyId)).toBe(true);
  });

  it('maker/checker: the creator cannot approve; a permissionless user cannot approve', async () => {
    if (!dbUp) return;

    // Booking before approval is refused.
    const early = await app.inject({ method: 'POST', url: `/api/reserving/studies/${studyId}/book`, headers: maker });
    expect(early.statusCode).toBe(409);

    // Segregation of duties: the study's creator cannot approve their own work.
    const selfApprove = await app.inject({ method: 'POST', url: `/api/reserving/studies/${studyId}/approve`, headers: maker });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error).toContain('Segregation of duties');

    // The underwriter lacks accounting:post - the permission gate holds.
    const uw = { authorization: `Bearer ${await token(app, 'uw@demo.rios')}` };
    const noPerm = await app.inject({ method: 'POST', url: `/api/reserving/studies/${studyId}/approve`, headers: uw });
    expect(noPerm.statusCode).toBe(403);

    // A different user with accounting:post approves.
    const approved = await app.inject({ method: 'POST', url: `/api/reserving/studies/${studyId}/approve`, headers: checker });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('APPROVED');
    expect(approved.json().approvedBy).toBeTruthy();

    // Approving twice is an illegal transition.
    const again = await app.inject({ method: 'POST', url: `/api/reserving/studies/${studyId}/approve`, headers: checker });
    expect(again.statusCode).toBe(409);
  });

  it('books a balanced GL journal through the existing ledger; double-book -> 409', async () => {
    if (!dbUp) return;

    const booked = await app.inject({ method: 'POST', url: `/api/reserving/studies/${studyId}/book`, headers: checker });
    expect(booked.statusCode).toBe(200);
    const body = booked.json();
    expect(body.status).toBe('BOOKED');
    const journalId = body.journalId as string;
    expect(journalId).toBeTruthy();

    // The journal is balanced: DR 5100 Claims / Loss Expense == CR 2100
    // Reinsurance Creditors (Control), both exactly the recommendation.
    const postings = body.postings as Array<{ account: string; debitMinor: number; creditMinor: number }>;
    const totalDr = postings.reduce((a, p) => a + p.debitMinor, 0);
    const totalCr = postings.reduce((a, p) => a + p.creditMinor, 0);
    expect(totalDr).toBe(totalCr);
    expect(totalDr).toBe(recommendationMinor);
    expect(postings.find((p) => p.account === '5100')!.debitMinor).toBe(recommendationMinor);
    expect(postings.find((p) => p.account === '2100')!.creditMinor).toBe(recommendationMinor);

    // The GL still self-balances after the booking (existing finance endpoint),
    // and the liability account carries at least this booking's credit.
    const tb = await app.inject({ method: 'GET', url: '/api/finance/trial-balance', headers: maker });
    expect(tb.statusCode).toBe(200);
    expect(tb.json().balanced).toBe(true);
    const liability = (tb.json().accounts as Array<{ code: string; creditMinor: number }>).find((a) => a.code === '2100');
    expect(liability).toBeDefined();
    expect(liability!.creditMinor).toBeGreaterThanOrEqual(recommendationMinor);

    // The journal linkage is on the study detail.
    const detail = await app.inject({ method: 'GET', url: `/api/reserving/studies/${studyId}`, headers: checker });
    expect(detail.json().journalId).toBe(journalId);
    expect(detail.json().bookedAt).toBeTruthy();

    // Booking twice never doubles the reserve.
    const twice = await app.inject({ method: 'POST', url: `/api/reserving/studies/${studyId}/book`, headers: checker });
    expect(twice.statusCode).toBe(409);
  });

  it('records AvE observations and reports the cumulative deviation', async () => {
    if (!dbUp) return;

    const first = await app.inject({
      method: 'POST',
      url: `/api/reserving/studies/${studyId}/ave`,
      headers: checker,
      payload: { period: '2026-07-31', actual: 300, note: 'July emergence' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().actualMinor).toBe(30_000);
    expect(first.json().expectedMinor).toBe(recommendationMinor);

    const second = await app.inject({
      method: 'POST',
      url: `/api/reserving/studies/${studyId}/ave`,
      headers: checker,
      payload: { period: '2026-08-31', actual: 400 },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().actualMinor).toBe(40_000);

    const detail = await app.inject({ method: 'GET', url: `/api/reserving/studies/${studyId}`, headers: checker });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect((d.ave as unknown[]).length).toBe(2);

    // The cumulative deviation is exactly the pure domain helper's output.
    const expected = actualVsExpected(recommendationMinor, [30_000, 40_000]);
    expect(d.aveSummary).toEqual({
      periods: 2,
      cumulativeActualMinor: 70_000,
      expectedMinor: recommendationMinor,
      cumulativeDeviationMinor: 70_000 - recommendationMinor, // -38,000: emerging better than expected
      deviationPct: expected.deviationPct,
    });
  });

  it('a recommendation can be rejected with a reason; a rejected study is closed', async () => {
    if (!dbUp) return;

    const created = await app.inject({
      method: 'POST',
      url: '/api/reserving/studies',
      headers: maker,
      payload: { name: 'Rejected IBNR study', asOf: '2026-06-30', currency: 'USD', triangle: TRIANGLE },
    });
    const rejectId = created.json().id as string;

    const noReason = await app.inject({ method: 'POST', url: `/api/reserving/studies/${rejectId}/reject`, headers: checker, payload: {} });
    expect(noReason.statusCode).toBe(400);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/reserving/studies/${rejectId}/reject`,
      headers: checker,
      payload: { reason: 'Triangle excludes the June cat event; re-run with updated data' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('REJECTED');
    expect(rejected.json().rejectionReason).toContain('June cat event');

    // A rejected study cannot be approved, booked or monitored.
    expect((await app.inject({ method: 'POST', url: `/api/reserving/studies/${rejectId}/approve`, headers: checker })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/reserving/studies/${rejectId}/book`, headers: checker })).statusCode).toBe(409);
    expect(
      (await app.inject({
        method: 'POST',
        url: `/api/reserving/studies/${rejectId}/ave`,
        headers: checker,
        payload: { period: '2026-07-31', actual: 100 },
      })).statusCode,
    ).toBe(409);
  });
});
