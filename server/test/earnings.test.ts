/**
 * UPR/DAC earnings integration test (industry-gap-analysis §2.2 item 6):
 *   create treaty (with earning pattern in terms) → bind (books the deposit
 *   premium) → run the UPR/DAC accrual as of a mid-period date → prove
 *   earned + UPR === written exactly, DAC amortises on the same pattern, and
 *   the run/lines endpoints return the persisted valuation.
 *
 * Requires a migrated + seeded database reachable via DATABASE_URL/DATABASE_APP_URL.
 * Skips cleanly if the DB is unreachable so it never produces a false failure in an
 * environment without PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { earningsModule } from '../src/modules/earnings.js';

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

async function boundTreaty(
  app: FastifyInstance,
  auth: { authorization: string },
  payload: Record<string, unknown>,
): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/treaties', headers: auth, payload });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
  const bound = await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
  expect(bound.json().status).toBe('BOUND');
  return id;
}

interface Line {
  contractId: string;
  pattern: string;
  currency: string;
  writtenPremiumMinor: number;
  earnedMinor: number;
  uprMinor: number;
  acquisitionCostMinor: number;
  dacMinor: number;
}

const findLine = (lines: Line[], contractId: string): Line | undefined =>
  lines.find((l) => l.contractId === contractId);

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

describe('UPR/DAC accrual run', () => {
  it('earns pro-rata, 8ths and risk-attaching premium with integer-exact UPR/DAC', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Two-year pro-rata treaty: 730 days, $365,000 deposit premium, 25% ceding
    // commission (no commission events booked -> derived from terms).
    const proRataId = await boundTreaty(app, auth, {
      name: 'UPR Pro-Rata Treaty',
      basis: 'NON_PROPORTIONAL',
      npType: 'CAT_XL',
      currency: 'USD',
      periodStart: '2026-01-01',
      periodEnd: '2027-12-31',
      terms: { currency: 'USD', depositPremium: 365000, cedingCommissionPct: 25, earningPattern: 'PRO_RATA' },
    });

    // Annual 8ths treaty, $800,000 deposit premium.
    const eighthsId = await boundTreaty(app, auth, {
      name: 'UPR Eighths Treaty',
      basis: 'PROPORTIONAL',
      proportionalType: 'QUOTA_SHARE',
      currency: 'USD',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      terms: { currency: 'USD', depositPremium: 800000, earningPattern: 'EIGHTHS' },
    });

    // Risks-attaching treaty: no explicit earningPattern - the RISKS_ATTACHING
    // period basis must imply the RISK_ATTACHING pattern.
    const riskAttachingId = await boundTreaty(app, auth, {
      name: 'UPR Risks-Attaching Treaty',
      basis: 'PROPORTIONAL',
      proportionalType: 'QUOTA_SHARE',
      currency: 'USD',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      terms: { currency: 'USD', depositPremium: 100000, periodBasis: 'RISKS_ATTACHING' },
    });

    // Mid-period valuation: 2027-06-30.
    const run = await app.inject({
      method: 'POST',
      url: '/api/accounting/upr/run',
      headers: auth,
      payload: { asOf: '2027-06-30' },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();
    expect(body.status).toBe('COMPLETED');
    expect(body.asOf).toBe('2027-06-30');
    const lines = body.lines as Line[];

    // Pro-rata: 546 of 730 days elapsed. $365,000 -> 36,500,000 minor =
    // 50,000/day; earned 27,300,000; UPR 9,200,000. Acquisition = 25% =
    // 9,125,000 minor = 12,500/day; amortised 6,825,000; DAC 2,300,000.
    const pr = findLine(lines, proRataId)!;
    expect(pr).toBeTruthy();
    expect(pr.pattern).toBe('PRO_RATA');
    expect(pr.writtenPremiumMinor).toBe(36_500_000);
    expect(pr.earnedMinor).toBe(27_300_000);
    expect(pr.uprMinor).toBe(9_200_000);
    expect(pr.earnedMinor + pr.uprMinor).toBe(pr.writtenPremiumMinor); // exact
    expect(pr.acquisitionCostMinor).toBe(9_125_000);
    expect(pr.dacMinor).toBe(2_300_000);
    expect(pr.dacMinor + (pr.acquisitionCostMinor - pr.dacMinor)).toBe(pr.acquisitionCostMinor);

    // 8ths: 2027-06-30 ends Q2 -> 2 complete quarters -> 3/8 earned.
    const e8 = findLine(lines, eighthsId)!;
    expect(e8).toBeTruthy();
    expect(e8.pattern).toBe('EIGHTHS');
    expect(e8.writtenPremiumMinor).toBe(80_000_000);
    expect(e8.earnedMinor).toBe(30_000_000); // 3/8
    expect(e8.uprMinor).toBe(50_000_000);
    expect(e8.earnedMinor + e8.uprMinor).toBe(e8.writtenPremiumMinor);

    // Risk-attaching: quadratic ramp, t = 181 of W = 365 -> t²/2W².
    const ra = findLine(lines, riskAttachingId)!;
    expect(ra).toBeTruthy();
    expect(ra.pattern).toBe('RISK_ATTACHING');
    expect(ra.writtenPremiumMinor).toBe(10_000_000);
    expect(ra.earnedMinor).toBe(Math.round((10_000_000 * 181 * 181) / (2 * 365 * 365)));
    expect(ra.earnedMinor + ra.uprMinor).toBe(ra.writtenPremiumMinor);
    // Slower than pro-rata at the same date.
    expect(ra.earnedMinor / ra.writtenPremiumMinor).toBeLessThan(181 / 365);

    // The run is retrievable with its persisted lines.
    const list = await app.inject({ method: 'GET', url: '/api/accounting/upr/runs', headers: auth });
    expect(list.statusCode).toBe(200);
    expect((list.json().runs as Array<{ id: string }>).some((r) => r.id === body.id)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/accounting/upr/runs/${body.id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().asOf).toBe('2027-06-30');
    const savedLines = detail.json().lines as Line[];
    const savedPr = findLine(savedLines, proRataId)!;
    expect(savedPr.earnedMinor).toBe(27_300_000);
    expect(savedPr.uprMinor).toBe(9_200_000);
    expect(savedPr.dacMinor).toBe(2_300_000);
    // Every persisted line reconciles: earned + UPR = written, amortised + DAC = cost.
    for (const l of savedLines) {
      expect(l.earnedMinor + l.uprMinor).toBe(l.writtenPremiumMinor);
      expect(l.dacMinor).toBeLessThanOrEqual(l.acquisitionCostMinor);
    }

    // Before-inception valuation: nothing earned, UPR = written.
    const early = await app.inject({
      method: 'POST',
      url: '/api/accounting/upr/run',
      headers: auth,
      payload: { asOf: '2026-12-31' },
    });
    expect(early.statusCode).toBe(201);
    const earlyE8 = findLine(early.json().lines as Line[], eighthsId)!;
    expect(earlyE8.earnedMinor).toBe(0);
    expect(earlyE8.uprMinor).toBe(80_000_000);
    // Pro-rata treaty is exactly half-way through its 730-day period.
    const earlyPr = findLine(early.json().lines as Line[], proRataId)!;
    expect(earlyPr.earnedMinor).toBe(18_250_000);
  });

  it('rejects a malformed asOf with 400 and missing runs with 404', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const bad = await app.inject({ method: 'POST', url: '/api/accounting/upr/run', headers: auth, payload: { asOf: '30/06/2027' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toBeTruthy();

    const missing = await app.inject({
      method: 'GET',
      url: '/api/accounting/upr/runs/00000000-0000-0000-0000-000000000000',
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('gates the run behind accounting:post (claims handler gets 403)', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'claims@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const res = await app.inject({ method: 'POST', url: '/api/accounting/upr/run', headers: auth, payload: { asOf: '2027-06-30' } });
    expect(res.statusCode).toBe(403);
  });
});
