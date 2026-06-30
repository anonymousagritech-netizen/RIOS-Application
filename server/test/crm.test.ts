/**
 * CRM module integration test (brief §9.11): activities + opportunity pipeline.
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

describe('crm: activities + pipeline', () => {
  it('weights opportunities into the pipeline funnel', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const parties = await app.inject({ method: 'GET', url: '/api/parties', headers: auth });
    const partyId = parties.json().parties[0].id as string;

    const created = await app.inject({
      method: 'POST',
      url: '/api/crm/opportunities',
      headers: auth,
      payload: { partyId, name: 'Pipeline Deal', stage: 'QUALIFIED', amount: 1000000, currency: 'USD', probability: 50 },
    });
    expect(created.statusCode).toBe(201);

    const pipe = await app.inject({ method: 'GET', url: '/api/crm/pipeline', headers: auth });
    const body = pipe.json();
    const bucket = body.pipeline.find((p: { stage: string }) => p.stage === 'QUALIFIED');
    expect(bucket).toBeTruthy();
    expect(bucket.count).toBeGreaterThanOrEqual(1);
    // $1,000,000 at 50% => 50,000,000 minor weighted for this opportunity.
    expect(body.totalWeightedMinor).toBeGreaterThanOrEqual(50_000_000);
  });

  it('creates and completes an activity', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const parties = await app.inject({ method: 'GET', url: '/api/parties', headers: auth });
    const partyId = parties.json().parties[0].id as string;

    const created = await app.inject({
      method: 'POST',
      url: '/api/crm/activities',
      headers: auth,
      payload: { partyId, kind: 'call', subject: 'Intro call' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const done = await app.inject({ method: 'POST', url: `/api/crm/activities/${id}/complete`, headers: auth });
    expect(done.statusCode).toBe(200);
    expect(done.json().completed).toBe(true);
  });
});
