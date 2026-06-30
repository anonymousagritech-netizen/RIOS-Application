/**
 * Designer surfaces (brief §10.3): Workflow Designer + Business Rules engine.
 * Drives definition authoring (draft → publish), the seeded definitions, the
 * workflow simulator and the rule evaluator through the API. Skips without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
  // Keep reruns clean: drop any authored test definitions.
  await ownerQuery(`delete from config_document where kind in ('workflow','rule') and key like 'test.%'`).catch(() => {});
});
afterAll(async () => {
  if (app) {
    await ownerQuery(`delete from config_document where kind in ('workflow','rule') and key like 'test.%'`).catch(() => {});
    await app.close();
  }
  await closePools();
});

describe('Workflow Designer', () => {
  it('serves the seeded treaty lifecycle and simulates transitions', async () => {
    if (!dbUp) return;
    const tkn = await loginToken('admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const list = await app.inject({ method: 'GET', url: '/api/designer/workflows', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().definitions.some((d: { key: string }) => d.key === 'treaty.lifecycle')).toBe(true);

    // A legal transition advances the state.
    const ok = await app.inject({
      method: 'POST', url: '/api/designer/workflows/simulate', headers: auth,
      payload: { key: 'treaty.lifecycle', state: 'DRAFT', event: 'quote' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().result.ok).toBe(true);
    expect(ok.json().result.state).toBe('QUOTED');

    // An illegal transition is rejected and the state is unchanged.
    const bad = await app.inject({
      method: 'POST', url: '/api/designer/workflows/simulate', headers: auth,
      payload: { key: 'treaty.lifecycle', state: 'DRAFT', event: 'activate' },
    });
    expect(bad.json().result.ok).toBe(false);
    expect(bad.json().result.state).toBe('DRAFT');
  });

  it('rejects an invalid definition and round-trips a valid draft → publish', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };

    const invalid = await app.inject({
      method: 'POST', url: '/api/designer/workflows', headers: auth,
      payload: { key: 'test.bad', body: { initial: 'NOPE', states: ['A'], transitions: [] } },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().issues.map((i: { code: string }) => i.code)).toContain('bad_initial');

    const created = await app.inject({
      method: 'POST', url: '/api/designer/workflows', headers: auth,
      payload: {
        key: 'test.simple',
        body: {
          initial: 'NEW', states: ['NEW', 'DONE'], finalStates: ['DONE'],
          transitions: [{ event: 'finish', from: 'NEW', to: 'DONE' }],
        },
        publish: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('published');
  });

  it('forbids authoring without config:write', async () => {
    if (!dbUp) return;
    // The claims user has no config:write permission.
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/designer/workflows', headers: auth,
      payload: { key: 'test.forbidden', body: { initial: 'A', states: ['A'], transitions: [] } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Business Rules engine', () => {
  it('evaluates the seeded bind guards against a context', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };

    // Missing premium → blocking error + a defaulted brokerage.
    const blocked = await app.inject({
      method: 'POST', url: '/api/designer/rules/evaluate', headers: auth,
      payload: { key: 'treaty.bind.guards', context: { lob: 'CASUALTY' } },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().outcome.ok).toBe(false);
    expect(blocked.json().outcome.set.brokeragePct).toBe(10);

    // Large property line → routed & flagged, no blocking error.
    const big = await app.inject({
      method: 'POST', url: '/api/designer/rules/evaluate', headers: auth,
      payload: { key: 'treaty.bind.guards', context: { premiumMinor: 25000000, lob: 'PROPERTY', brokeragePct: 12 } },
    });
    expect(big.json().outcome.ok).toBe(true);
    expect(big.json().outcome.routes).toContain('senior-uw');
    expect(big.json().outcome.flags).toContain('large-line');
  });
});
