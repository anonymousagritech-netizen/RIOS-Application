/**
 * Exposure / aggregate management tests (brief §7.8, §9.9, §30).
 *
 * Proves the cat / exposure-manager view: an accumulation reports its utilisation
 * against capacity and flags a breach when its entries exceed the zonal limit.
 *
 * Skips cleanly if Postgres is unreachable so it never produces a false failure.
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

describe('exposure: zonal aggregates vs limits', () => {
  it('reports utilisation and flags a breach when entries exceed capacity', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // A unique zone so the accumulation list assertions are deterministic.
    const zone = `ZONE-${Date.now()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/exposure/accumulations',
      headers: auth,
      payload: { peril: 'WINDSTORM', zone, currency: 'USD', capacity: 1000 },
    });
    expect(created.statusCode).toBe(201);
    const accId = created.json().id as string;
    expect(created.json().capacityMinor).toBe(100_000); // $1,000

    // Two entries totalling $1,500 gross — above the $1,000 capacity.
    await app.inject({
      method: 'POST',
      url: `/api/exposure/accumulations/${accId}/entries`,
      headers: auth,
      payload: { grossExposure: 600, netExposure: 400, currency: 'USD' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/exposure/accumulations/${accId}/entries`,
      headers: auth,
      payload: { grossExposure: 900, netExposure: 500, currency: 'USD' },
    });

    // Detail view reports utilisation and a breach.
    const detail = await app.inject({ method: 'GET', url: `/api/exposure/accumulations/${accId}`, headers: auth });
    const d = detail.json();
    expect(d.usedMinor).toBe(150_000); // $1,500
    expect(d.netMinor).toBe(90_000); // $900
    expect(d.breached).toBe(true);
    expect(d.utilisationPct).toBeCloseTo(1.5, 5);
    expect(d.entries.length).toBe(2);

    // List view exposes the same utilisation/breach for this accumulation.
    const list = await app.inject({ method: 'GET', url: '/api/exposure/accumulations', headers: auth });
    const mine = (list.json().accumulations as Array<{ id: string; breached: boolean; usedMinor: number }>).find(
      (a) => a.id === accId,
    )!;
    expect(mine.breached).toBe(true);
    expect(mine.usedMinor).toBe(150_000);

    // Summary aggregates gross/net by peril+zone.
    const summary = await app.inject({
      method: 'GET',
      url: `/api/exposure/summary?peril=WINDSTORM&zone=${zone}`,
      headers: auth,
    });
    const row = (summary.json().summary as Array<{ peril: string; zone: string; grossMinor: number; netMinor: number }>).find(
      (r) => r.zone === zone,
    )!;
    expect(row.grossMinor).toBe(150_000);
    expect(row.netMinor).toBe(90_000);
  });
});
