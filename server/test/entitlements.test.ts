/**
 * Entitlement engine (0073): per-tenant/plan feature flags & numeric limits.
 * Proves effective resolution (override > plan > unset), a demo plan seeded with
 * a FLAG and LIMITs, and enforcement of a configured limit (409 over-limit,
 * allowed within-limit; unconfigured => no restriction). Skips without a DB.
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

describe('Effective entitlements from the seeded demo plan', () => {
  it('resolves the plan FLAG and LIMIT entitlements', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/features/entitlements', headers: auth });
    expect(res.statusCode).toBe(200);
    const ents = res.json().entitlements as Array<{ key: string; kind: string; flag: boolean | null; limit: number | null; source: string }>;

    const flag = ents.find((e) => e.key === 'features.betaModules');
    expect(flag).toMatchObject({ kind: 'FLAG', flag: true, source: 'plan' });

    const limit = ents.find((e) => e.key === 'platform.maxCompanies');
    expect(limit).toMatchObject({ kind: 'LIMIT', limit: 100, source: 'plan' });
  });

  it('checks a single key and reports unconfigured keys as unrestricted', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const hit = await app.inject({ method: 'GET', url: '/api/features/check?key=features.betaModules', headers: auth });
    expect(hit.json()).toMatchObject({ configured: true, flag: true, source: 'plan' });

    const miss = await app.inject({ method: 'GET', url: '/api/features/check?key=nope.not.configured', headers: auth });
    expect(miss.json()).toMatchObject({ configured: false, flag: null, limit: null, source: null });
  });
});

describe('Per-tenant overrides outrank the plan', () => {
  it('lets an override change a plan flag/limit and reverts on delete', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    // Override the plan FLAG to false.
    const set = await app.inject({ method: 'POST', url: '/api/platform/entitlement-overrides', headers: auth, payload: { key: 'features.betaModules', kind: 'FLAG', boolValue: false } });
    expect(set.statusCode).toBe(201);

    const after = await app.inject({ method: 'GET', url: '/api/features/check?key=features.betaModules', headers: auth });
    expect(after.json()).toMatchObject({ configured: true, flag: false, source: 'override' });

    // Remove the override => resolution falls back to the plan value.
    const del = await app.inject({ method: 'DELETE', url: '/api/platform/entitlement-overrides/features.betaModules', headers: auth });
    expect(del.statusCode).toBe(200);
    const back = await app.inject({ method: 'GET', url: '/api/features/check?key=features.betaModules', headers: auth });
    expect(back.json()).toMatchObject({ flag: true, source: 'plan' });
  });
});

describe('Admin can define a plan and assign it', () => {
  it('creates a plan, sets a LIMIT entitlement and assigns it back to demo-standard', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const plan = await app.inject({ method: 'POST', url: '/api/platform/plans', headers: auth, payload: { code: 'test-plan', name: 'Test Plan' } });
    expect(plan.statusCode).toBe(201);
    const planId = plan.json().id as string;

    const ent = await app.inject({ method: 'POST', url: `/api/platform/plans/${planId}/entitlements`, headers: auth, payload: { key: 'reports.maxScheduled', kind: 'LIMIT', limitValue: 25 } });
    expect(ent.statusCode).toBe(201);

    const assign = await app.inject({ method: 'POST', url: '/api/platform/tenant-plan', headers: auth, payload: { planId } });
    expect(assign.statusCode).toBe(201);
    const check = await app.inject({ method: 'GET', url: '/api/features/check?key=reports.maxScheduled', headers: auth });
    expect(check.json()).toMatchObject({ kind: 'LIMIT', limit: 25, source: 'plan' });

    // Re-assign the seeded demo-standard plan so later assertions/paths hold.
    const plans = await app.inject({ method: 'GET', url: '/api/platform/plans', headers: auth });
    const demo = (plans.json().plans as Array<{ id: string; code: string }>).find((p) => p.code === 'demo-standard')!;
    const reassign = await app.inject({ method: 'POST', url: '/api/platform/tenant-plan', headers: auth, payload: { planId: demo.id } });
    expect(reassign.statusCode).toBe(201);
  });

  it('forbids managing plans without platform:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/platform/plans', headers: auth, payload: { code: 'x', name: 'X' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('Enforcement of a configured limit (platform.maxCompanies)', () => {
  it('allows creating a company within the generous plan limit', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/platform/companies', headers: auth, payload: { code: 'CO-ENT1', name: 'Entitlement Test Co' } });
    expect(res.statusCode).toBe(201);
  });

  it('blocks a new company (409) when an override lowers the limit below current usage, then reverts', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    // Override maxCompanies to 1: there are already several companies, so any NEW code is blocked.
    const set = await app.inject({ method: 'POST', url: '/api/platform/entitlement-overrides', headers: auth, payload: { key: 'platform.maxCompanies', kind: 'LIMIT', limitValue: 1 } });
    expect(set.statusCode).toBe(201);

    const blocked = await app.inject({ method: 'POST', url: '/api/platform/companies', headers: auth, payload: { code: 'CO-ENT2', name: 'Over Limit Co' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ key: 'platform.maxCompanies' });

    // Updating an EXISTING company is not counted, so it still succeeds under the low limit.
    const upsert = await app.inject({ method: 'POST', url: '/api/platform/companies', headers: auth, payload: { code: 'CO-ENT1', name: 'Entitlement Test Co (renamed)' } });
    expect(upsert.statusCode).toBe(201);

    // Clean up the override so no other test file sees the low limit.
    const del = await app.inject({ method: 'DELETE', url: '/api/platform/entitlement-overrides/platform.maxCompanies', headers: auth });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/api/platform/companies', headers: auth, payload: { code: 'CO-ENT3', name: 'Back Within Limit Co' } });
    expect(after.statusCode).toBe(201);
  });
});
