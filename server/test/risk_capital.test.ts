/**
 * Risk & capital + RDS (brief §13). Exercises the capital adequacy verdict, the
 * netted RDS scenarios, the VaR/TVaR calculator and the permission gate. Skips
 * cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
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

describe('Capital adequacy', () => {
  it('returns the seeded position with a solvency ratio and verdict', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/risk/capital', headers: auth });
    expect(res.statusCode).toBe(200);
    // own funds 1.8bn / SCR 1.2bn = 1.5 → 'strong'
    expect(res.json().adequacy.solvencyRatio).toBeCloseTo(1.5, 6);
    expect(res.json().adequacy.status).toBe('strong');
    expect(res.json().adequacy.surplusMinor).toBe(600000000);
  });
});

describe('Realistic Disaster Scenarios', () => {
  it('nets each scenario and projects the post-event solvency ratio', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/risk/scenarios', headers: auth });
    expect(res.statusCode).toBe(200);
    const fl = res.json().scenarios.find((s: { code: string }) => s.code === 'RDS-FL-WIND');
    // gross 900m − recovery 600m = 300m net; own funds 1.8bn − 300m = 1.5bn; /1.2bn = 1.25
    expect(fl.result.netLossMinor).toBe(300000000);
    expect(fl.result.postEventOwnFundsMinor).toBe(1500000000);
    expect(fl.result.postEventRatio).toBeCloseTo(1.25, 6);
  });
});

describe('VaR / TVaR calculator', () => {
  it('computes empirical VaR and Tail-VaR from a loss sample', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/risk/var', headers: auth,
      payload: { losses: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], confidence: 0.8 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valueAtRiskMinor).toBe(900);
    expect(res.json().tailValueAtRiskMinor).toBe(950);
  });

  it('forbids capital authoring without risk:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/risk/capital', headers: auth,
      payload: { ownFundsMinor: 1, scrMinor: 1 },
    });
    expect(res.statusCode).toBe(403);
  });
});
