/**
 * Catastrophe-model provider adapter & ELT import (brief §13). Imports a small,
 * hand-checkable Event Loss Table via both the JSON and CSV adapters, asserts the
 * persisted metrics match the pure @rios/domain computation (AAL and a PML point),
 * lists and views the ELT, and checks the permission gate. Skips without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { averageAnnualLoss, probableMaximumLoss, type EltEvent } from '@rios/domain';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

// A tiny ELT: three events. AAL = Σ rate·loss.
const EVENTS: EltEvent[] = [
  { rate: 0.10, lossMinor: 1_000_000 },  // 1-in-10, $10k
  { rate: 0.02, lossMinor: 5_000_000 },  // 1-in-50, $50k
  { rate: 0.01, lossMinor: 20_000_000 }, // 1-in-100, $200k
];
const EXPECTED_AAL = averageAnnualLoss(EVENTS); // 100000 + 100000 + 200000 = 400000

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('Cat model ELT import', () => {
  it('imports a JSON ELT and computes AAL + PML matching the domain', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/catmodel/elt', headers: auth,
      payload: { name: 'JSON ELT', vendor: 'IMPORT', peril: 'HURRICANE', currency: 'USD', format: 'JSON', data: EVENTS },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.metrics.aalMinor).toBe(EXPECTED_AAL);
    // The 100-year PML is the loss whose cumulative rate first reaches 0.01.
    const pml100 = b.metrics.pmlProfile.find((p: { returnPeriod: number }) => p.returnPeriod === 100);
    expect(pml100.lossMinor).toBe(probableMaximumLoss(EVENTS, 100));
    expect(b.elt.eventCount).toBe(3);

    // View it back with events + metrics.
    const view = await app.inject({ method: 'GET', url: `/api/catmodel/elt/${b.elt.id}`, headers: auth });
    expect(view.statusCode).toBe(200);
    expect(view.json().aalMinor).toBe(EXPECTED_AAL);
    expect(view.json().events.length).toBe(3);
  });

  it('imports the same ELT from CSV and matches', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const csv = ['rate,lossMinor', '0.10,1000000', '0.02,5000000', '0.01,20000000'].join('\n');
    const res = await app.inject({
      method: 'POST', url: '/api/catmodel/elt', headers: auth,
      payload: { name: 'CSV ELT', format: 'CSV', currency: 'USD', data: csv },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.aalMinor).toBe(EXPECTED_AAL);
  });

  it('rejects a malformed CSV with a 400', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/catmodel/elt', headers: auth,
      payload: { name: 'Bad', format: 'CSV', data: 'not,a,valid\nheader,without,rate' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forbids importing without exposure:write', async () => {
    if (!dbUp) return;
    // The claims user has no exposure:write.
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/catmodel/elt', headers: auth,
      payload: { name: 'X', format: 'JSON', data: EVENTS },
    });
    expect(res.statusCode).toBe(403);
  });
});
