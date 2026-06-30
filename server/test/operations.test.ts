/**
 * Operations / Observability module integration test (brief §9.13).
 *
 * Requires a migrated + seeded database (DATABASE_URL/DATABASE_APP_URL). Skips
 * cleanly if Postgres is unreachable so it never produces a false failure.
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

describe('operations: observability + SLA + health', () => {
  it('returns a numeric health summary for the tenant', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({ method: 'GET', url: '/api/ops/health', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.auditEvents).toBe('number');
    expect(body.auditEvents).toBeGreaterThanOrEqual(0);
    expect(typeof body.activeContracts).toBe('number');
    expect(body.activeContracts).toBeGreaterThanOrEqual(0);
  });

  it('upserts an SLA target and lists it', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const service = `svc-${Date.now()}`;
    const posted = await app.inject({
      method: 'POST',
      url: '/api/ops/sla',
      headers: auth,
      payload: { service, metric: 'availability', targetValue: 99.9, unit: 'percent' },
    });
    expect(posted.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/ops/sla', headers: auth });
    const target = list.json().slaTargets.find((t: { service: string }) => t.service === service);
    expect(target).toBeTruthy();
    expect(target.metric).toBe('availability');
  });

  it('returns the immutable-audit viewer entries', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({ method: 'GET', url: '/api/ops/audit', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().entries)).toBe(true);
  });
});
