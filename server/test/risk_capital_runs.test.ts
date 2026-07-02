/**
 * Persisted risk & capital measurement runs + disclosure roll-forward
 * (migration 0069). Proves a Solvency II run persists SCR/MCR/ratio exactly as
 * the pure @rios/domain engines compute them, an IFRS 17 CSM run persists its
 * roll-forward, the disclosure roll-forward ties out (opening + movement =
 * closing), and the write gate returns 403. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  aggregateStandardFormulaBscr,
  solvencyCapitalRequirement,
  minimumCapitalRequirement,
  riskMargin,
  eligibleOwnFunds,
  csmRollforward,
  money,
} from '@rios/domain';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

// A fixed Solvency II input and the expected figures recomputed straight from
// the domain engines the endpoint reuses.
const siiInputs = {
  currency: 'USD',
  moduleCharges: { market: 1_000_000_000, default: 200_000_000, nonLife: 800_000_000 },
  operationalRiskMinor: 50_000_000,
  adjustmentMinor: 0,
  linearMcrMinor: 0,
  absoluteFloorMinor: 0,
  ownFundsTiers: { tier1Minor: 2_000_000_000, tier2Minor: 200_000_000, tier3Minor: 50_000_000 },
  riskMargin: { projectedScrMinor: [500_000_000, 400_000_000], costOfCapital: 0.06, riskFreeRate: 0.03 },
};

function expectedSii() {
  const bscr = aggregateStandardFormulaBscr({
    charges: { market: 1_000_000_000, default: 200_000_000, life: 0, health: 0, nonLife: 800_000_000 },
    intangibleAssetRisk: 0,
  });
  const scr = solvencyCapitalRequirement({
    moduleScrs: [bscr.bscr], correlation: [[1]], operationalRisk: 50_000_000, adjustment: 0,
  }).scr;
  const mcr = minimumCapitalRequirement({ scr, linearMcr: 0, absoluteFloor: 0 });
  const rm = riskMargin([500_000_000, 400_000_000], 0.06, 0.03);
  const elig = eligibleOwnFunds({ tier1: 2_000_000_000, tier2: 200_000_000, tier3: 50_000_000 }, scr, mcr);
  return {
    scrMinor: Math.round(scr),
    mcrMinor: Math.round(mcr),
    riskMarginMinor: Math.round(rm),
    ownFundsMinor: Math.round(elig.eligibleForScr),
    ratio: elig.scrRatio,
  };
}

describe('Solvency II capital run', () => {
  it('persists SCR/MCR/risk-margin/own-funds/ratio matching the domain engines exactly', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/risk-capital/runs', headers: auth,
      payload: { asOf: '2026-06-30', framework: 'SOLVENCY_II', inputs: siiInputs },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json().run;
    const exp = expectedSii();
    expect(run.scrMinor).toBe(exp.scrMinor);
    expect(run.mcrMinor).toBe(exp.mcrMinor);
    expect(run.riskMarginMinor).toBe(exp.riskMarginMinor);
    expect(run.ownFundsMinor).toBe(exp.ownFundsMinor);
    expect(run.ratio).toBeCloseTo(exp.ratio, 9);
    expect(run.framework).toBe('SOLVENCY_II');
    expect(run.asOf).toBe('2026-06-30');
  });

  it('lists and fetches the run by id', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const created = await app.inject({
      method: 'POST', url: '/api/risk-capital/runs', headers: auth,
      payload: { framework: 'SOLVENCY_II', inputs: siiInputs },
    });
    const id = created.json().run.id;

    const list = await app.inject({ method: 'GET', url: '/api/risk-capital/runs', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs.some((r: { id: string }) => r.id === id)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/risk-capital/runs/${id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.id).toBe(id);
  });

  it('persists a supplied disclosure roll-forward that ties out (opening + movement = closing)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const created = await app.inject({
      method: 'POST', url: '/api/risk-capital/runs', headers: auth,
      payload: { framework: 'SOLVENCY_II', inputs: siiInputs },
    });
    const id = created.json().run.id;

    const rf = await app.inject({
      method: 'POST', url: `/api/risk-capital/runs/${id}/rollforward`, headers: auth,
      payload: {
        period: '2026-H1',
        lines: [
          { lineItem: 'Eligible own funds', openingMinor: 1_800_000_000, movementMinor: 200_000_000, currency: 'USD' },
          { lineItem: 'SCR', openingMinor: 1_100_000_000, movementMinor: -50_000_000, currency: 'USD' },
        ],
      },
    });
    expect(rf.statusCode).toBe(201);
    for (const l of rf.json().lines) {
      expect(l.closingMinor).toBe(l.openingMinor + l.movementMinor);
    }

    const got = await app.inject({ method: 'GET', url: `/api/risk-capital/runs/${id}/rollforward`, headers: auth });
    expect(got.statusCode).toBe(200);
    const lines = got.json().lines;
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.closingMinor).toBe(l.openingMinor + l.movementMinor);
    }
  });
});

describe('IFRS 17 capital run', () => {
  const ifrsInputs = {
    currency: 'USD',
    openingCsmMinor: 1_000_000_000,
    interestAccretionRate: 0.03,
    newBusinessCsmMinor: 100_000_000,
    changeInEstimatesMinor: -50_000_000,
    coverageUnitsThisPeriod: 100,
    coverageUnitsRemaining: 500,
  };

  it('runs the domain CSM roll-forward and auto-derives a disclosure roll-forward that ties out', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const created = await app.inject({
      method: 'POST', url: '/api/risk-capital/runs', headers: auth,
      payload: { framework: 'IFRS17', inputs: ifrsInputs },
    });
    expect(created.statusCode).toBe(201);
    const run = created.json().run;

    const expected = csmRollforward({
      openingCsm: money(1_000_000_000, 'USD'),
      interestAccretionRate: 0.03,
      newBusinessCsm: money(100_000_000, 'USD'),
      changeInEstimates: money(-50_000_000, 'USD'),
      coverageUnitsThisPeriod: 100,
      coverageUnitsRemaining: 500,
    });
    expect(run.result.closingCsmMinor).toBe(expected.closingCsm.amount);
    expect(run.result.releasedMinor).toBe(expected.released.amount);

    // No lines supplied → auto-derived CSM reconciliation from the run result.
    const rf = await app.inject({
      method: 'POST', url: `/api/risk-capital/runs/${run.id}/rollforward`, headers: auth,
      payload: { period: '2026-H1' },
    });
    expect(rf.statusCode).toBe(201);
    const lines = rf.json().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].lineItem).toBe('CSM');
    expect(lines[0].openingMinor).toBe(1_000_000_000);
    expect(lines[0].closingMinor).toBe(lines[0].openingMinor + lines[0].movementMinor);
    expect(lines[0].closingMinor).toBe(expected.closingCsm.amount);
  });
});

describe('Risk-capital run permission gate', () => {
  it('forbids running a capital measurement without risk:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/risk-capital/runs', headers: auth,
      payload: { framework: 'SOLVENCY_II', inputs: siiInputs },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Standard-formula correlations disclosure', () => {
  it('returns the labelled Solvency II BSCR correlation matrix', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/risk-capital/correlations', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.modules).toHaveLength(5);
    expect(body.matrix).toHaveLength(5);
    expect(body.certified).toBe(false);
    expect(body.source).toMatch(/standard-formula/i);
  });
});
