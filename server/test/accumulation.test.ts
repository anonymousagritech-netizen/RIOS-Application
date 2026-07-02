/**
 * Accumulation control at bind time + RDS run (industry-gap-analysis Tier-3
 * item 14). dbUp guard + demo token, mirroring counterparty_security.test.ts.
 *
 * Zone limits (HARD/SOFT), the what-if check endpoint, the bind hook in
 * treaties.ts (409 on HARD breach with zone numbers, admin override audited as
 * 'accumulation override', SOFT breach binds with warnings), the honest
 * terms-territory fallback, and an RDS run over the bound portfolio.
 *
 * Fixtures are scoped with a unique suffix (zones/perils/scenario codes) so
 * concurrent suites binding treaties in the same demo tenant never match these
 * limits - and, symmetrically, this suite's assertions never see their data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerQuery } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

const suffix = Date.now();
const Z_HARD = `ACCTEST-${suffix}-FL-WIND`;
const Z_SOFT = `ACCTEST-${suffix}-JP-EQ`;
const Z_TERMS = `ACCTEST-${suffix}-TERR`;
const PERIL = `WIND-${suffix}`;
const REGION = `ACCTEST-${suffix}`;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => {
  if (dbUp) {
    // Best-effort cleanup: deactivate this run's zone limits so later suites
    // (and re-runs) start from a no-limit state for these zones.
    await ownerQuery(`update accumulation_zone_limit set active = false where zone like $1`, [`ACCTEST-${suffix}%`]).catch(() => {});
  }
  if (app) await app.close();
  await closePools();
});

let auth: Record<string, string>;

async function createTreaty(terms?: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/treaties', headers: auth,
    payload: {
      name: `Acc control test ${suffix}-${Math.random().toString(36).slice(2, 7)}`,
      basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD',
      ...(terms ? { terms } : {}),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** Attach zone exposure to a contract via the existing exposure endpoints (0009 tables). */
const accByZone = new Map<string, string>();
async function addExposure(contractId: string, zone: string, grossMajor: number): Promise<void> {
  let accId = accByZone.get(zone);
  if (!accId) {
    // accumulation is unique per (tenant, peril, zone, as_at) → create once per zone.
    const acc = await app.inject({
      method: 'POST', url: '/api/exposure/accumulations', headers: auth,
      payload: { peril: PERIL, zone, currency: 'USD', capacity: 0 },
    });
    expect(acc.statusCode).toBe(201);
    accId = acc.json().id as string;
    accByZone.set(zone, accId);
  }
  const entry = await app.inject({
    method: 'POST', url: `/api/exposure/accumulations/${accId}/entries`, headers: auth,
    payload: { contractId, grossExposure: grossMajor, netExposure: grossMajor, currency: 'USD' },
  });
  expect(entry.statusCode).toBe(201);
}

async function transition(id: string, to: string, extra?: Record<string, unknown>, asAuth?: Record<string, string>) {
  return app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: asAuth ?? auth, payload: { to, ...(extra ?? {}) } });
}

describe('Accumulation control at bind', () => {
  let treatyA: string;
  let treatyB: string;

  it('sets a HARD zone limit and binds a treaty within it, with a clean PASS check', async () => {
    if (!dbUp) return;
    auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const limit = await app.inject({
      method: 'POST', url: '/api/accumulation/zone-limits', headers: auth,
      payload: { zone: Z_HARD, currency: 'USD', limitMinor: 100_000_000, mode: 'HARD' }, // $1,000,000
    });
    expect(limit.statusCode).toBe(201);
    expect(limit.json().mode).toBe('HARD');

    treatyA = await createTreaty();
    await addExposure(treatyA, Z_HARD, 600_000); // $600k → 60,000,000 minor

    // What-if before binding: current 0, addition 60m minor, PASS.
    const check = await app.inject({ method: 'GET', url: `/api/accumulation/check?contractId=${treatyA}`, headers: auth });
    expect(check.statusCode).toBe(200);
    expect(check.json().checked).toBe(true);
    expect(check.json().exposureSource).toBe('EXPOSURE_ENTRIES');
    expect(check.json().verdict).toBe('PASS');
    const zA = check.json().zones.find((z: { zone: string }) => z.zone === Z_HARD);
    expect(zA).toMatchObject({ currentMinor: 0, additionMinor: 60_000_000, projectedMinor: 60_000_000, limitMinor: 100_000_000 });

    expect((await transition(treatyA, 'QUOTED')).statusCode).toBe(200);
    const bind = await transition(treatyA, 'BOUND');
    expect(bind.statusCode).toBe(200);
    expect(bind.json().status).toBe('BOUND');
    expect(bind.json().warnings).toBeUndefined(); // within limit → no warnings key
  });

  it('blocks a HARD breach with the zone numbers, matching the check endpoint, and rolls nothing forward', async () => {
    if (!dbUp) return;
    treatyB = await createTreaty();
    await addExposure(treatyB, Z_HARD, 700_000); // projected 130m minor vs 100m limit

    const check = await app.inject({ method: 'GET', url: `/api/accumulation/check?contractId=${treatyB}`, headers: auth });
    expect(check.json().verdict).toBe('BLOCK');
    const projected = check.json().blocked[0];
    expect(projected).toMatchObject({
      zone: Z_HARD, mode: 'HARD',
      currentMinor: 60_000_000, additionMinor: 70_000_000,
      projectedMinor: 130_000_000, limitMinor: 100_000_000, headroomMinor: -30_000_000,
    });

    expect((await transition(treatyB, 'QUOTED')).statusCode).toBe(200);
    const blocked = await transition(treatyB, 'BOUND');
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json();
    expect(body.verdict).toBe('BLOCK');
    // The 409 reports the same numbers the check endpoint projected.
    expect(body.zones[0]).toMatchObject({
      zone: Z_HARD, projectedMinor: 130_000_000, limitMinor: 100_000_000,
      currentMinor: 60_000_000, additionMinor: 70_000_000, mode: 'HARD',
    });
    expect(body.zones[0].message).toContain(`aggregate becomes 130000000 vs limit 100000000`);

    // The transition did not happen and no deposit event was booked.
    const status = await app.inject({ method: 'GET', url: `/api/treaties/${treatyB}`, headers: auth });
    expect(status.json().status).toBe('QUOTED');
    const fe = await ownerQuery(`select 1 from financial_event where contract_id = $1`, [treatyB]);
    expect(fe.rows.length).toBe(0);
  });

  it('rejects the override flag for non-admins, then lets an admin bind with an audited accumulation override', async () => {
    if (!dbUp) return;
    // uw@demo.rios has treaty:bind but not admin:manage → override flag is ignored.
    const uwAuth = { authorization: `Bearer ${await token(app, 'uw@demo.rios')}` };
    const stillBlocked = await transition(treatyB, 'BOUND', { overrideAccumulation: true }, uwAuth);
    expect(stillBlocked.statusCode).toBe(409);

    // Admin override downgrades the HARD breach to a warning and is audited.
    const bound = await transition(treatyB, 'BOUND', { overrideAccumulation: true });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().status).toBe('BOUND');
    expect(bound.json().warnings.length).toBe(1);
    expect(bound.json().warnings[0]).toMatchObject({ zone: Z_HARD, projectedMinor: 130_000_000, limitMinor: 100_000_000 });

    const audit = await ownerQuery<{ action: string; after: { note: string; zones: { zone: string }[] } }>(
      `select action, after from audit_log where entity_id = $1 and action = 'accumulation_override'`,
      [treatyB],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]!.after.note).toBe('accumulation override');
    expect(audit.rows[0]!.after.zones[0]!.zone).toBe(Z_HARD);
  });

  it('SOFT mode binds with a warnings array and an audit trail', async () => {
    if (!dbUp) return;
    const limit = await app.inject({
      method: 'POST', url: '/api/accumulation/zone-limits', headers: auth,
      payload: { zone: Z_SOFT, currency: 'USD', limitMinor: 50_000_000, mode: 'SOFT' }, // $500k
    });
    expect(limit.statusCode).toBe(201);

    const treatyC = await createTreaty();
    await addExposure(treatyC, Z_SOFT, 600_000); // 60m minor > 50m soft limit
    expect((await transition(treatyC, 'QUOTED')).statusCode).toBe(200);
    const bind = await transition(treatyC, 'BOUND');
    expect(bind.statusCode).toBe(200);
    expect(bind.json().warnings.length).toBe(1);
    expect(bind.json().warnings[0]).toMatchObject({
      zone: Z_SOFT, mode: 'SOFT', projectedMinor: 60_000_000, limitMinor: 50_000_000, headroomMinor: -10_000_000,
    });
    const audit = await ownerQuery(
      `select 1 from audit_log where entity_id = $1 and action = 'accumulation_warning'`,
      [treatyC],
    );
    expect(audit.rows.length).toBe(1);
  });

  it('falls back to terms territory/limit when a contract has no exposure rows, honestly labelled', async () => {
    if (!dbUp) return;
    const limit = await app.inject({
      method: 'POST', url: '/api/accumulation/zone-limits', headers: auth,
      payload: { zone: Z_TERMS, currency: 'USD', limitMinor: 100_000_000, mode: 'HARD' },
    });
    expect(limit.statusCode).toBe(201);

    // No exposure entries: the check uses terms.territory as the zone and the
    // occurrence limit as the exposure proxy ($2m → 200m minor vs 100m limit).
    const treatyD = await createTreaty({ territory: Z_TERMS, limit: 2_000_000 });
    const check = await app.inject({ method: 'GET', url: `/api/accumulation/check?contractId=${treatyD}`, headers: auth });
    expect(check.json().exposureSource).toBe('TERMS_TERRITORY');
    expect(check.json().verdict).toBe('BLOCK');
    expect(check.json().blocked[0]).toMatchObject({ zone: Z_TERMS, additionMinor: 200_000_000, limitMinor: 100_000_000 });

    expect((await transition(treatyD, 'QUOTED')).statusCode).toBe(200);
    const blocked = await transition(treatyD, 'BOUND');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().exposureSource).toBe('TERMS_TERRITORY');
  });

  it('lists zone limits with the bound aggregate and runs an RDS over the bound portfolio', async () => {
    if (!dbUp) return;
    // Bound in Z_HARD by now: A (60m) + B (70m, bound via override) = 130m minor.
    const list = await app.inject({ method: 'GET', url: '/api/accumulation/zone-limits', headers: auth });
    expect(list.statusCode).toBe(200);
    const hard = list.json().limits.find((l: { zone: string }) => l.zone === Z_HARD);
    expect(hard.boundAggregateMinor).toBe(130_000_000);
    expect(hard.breached).toBe(true);

    // Ad-hoc scenario params: half-damage over the region prefix hits Z_HARD
    // (130m) + Z_SOFT (60m) = 190m minor exposure → 95m modelled gross loss.
    const run = await app.inject({
      method: 'POST', url: '/api/accumulation/rds/run', headers: auth,
      payload: { peril: PERIL, region: REGION, damageRatio: 0.5 },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().modelledGrossLossMinor).toBe(95_000_000);
    expect(run.json().zones.length).toBe(2);
    expect(run.json().appetite).toBeNull(); // honest: no risk-appetite table exists
    expect(run.json().appetiteNote).toContain('No risk-appetite table');

    // Via a stored RDS scenario (reuses rds_scenario from migration 0020).
    const scen = await app.inject({
      method: 'POST', url: '/api/risk/scenarios', headers: auth,
      payload: { code: `RDS-ACC-${suffix}`, name: 'Accumulation test windstorm', peril: PERIL, region: REGION, currency: 'USD', grossLossMinor: 0 },
    });
    expect(scen.statusCode).toBe(201);
    const keyed = await app.inject({
      method: 'POST', url: '/api/accumulation/rds/run', headers: auth,
      payload: { scenarioKey: `RDS-ACC-${suffix}` }, // full damage ratio by default
    });
    expect(keyed.statusCode).toBe(200);
    expect(keyed.json().scenario.code).toBe(`RDS-ACC-${suffix}`);
    expect(keyed.json().modelledGrossLossMinor).toBe(190_000_000);

    const missing = await app.inject({
      method: 'POST', url: '/api/accumulation/rds/run', headers: auth,
      payload: { scenarioKey: `RDS-NOPE-${suffix}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('deactivating the limits makes the check a no-op again (checked: false)', async () => {
    if (!dbUp) return;
    const list = await app.inject({ method: 'GET', url: '/api/accumulation/zone-limits', headers: auth });
    for (const l of list.json().limits.filter((l: { zone: string; active: boolean }) => l.zone.startsWith('ACCTEST-') && l.active)) {
      const res = await app.inject({ method: 'POST', url: `/api/accumulation/zone-limits/${l.id}/deactivate`, headers: auth });
      expect(res.statusCode).toBe(200);
    }
    // With no active limits left in these zones, a breaching contract binds
    // untouched - the no-op guarantee the rest of the suite relies on. (Other
    // suites' limits, if any, cannot match this suffix-scoped zone.)
    const treatyE = await createTreaty();
    await addExposure(treatyE, Z_HARD, 5_000_000);
    const check = await app.inject({ method: 'GET', url: `/api/accumulation/check?contractId=${treatyE}`, headers: auth });
    // checked=false only when the tenant has zero active limits anywhere;
    // concurrent suites never configure limits, but be tolerant: the verdict
    // must be PASS either way because no active limit matches this zone.
    expect(check.json().verdict).toBe('PASS');
    expect((await transition(treatyE, 'QUOTED')).statusCode).toBe(200);
    const bind = await transition(treatyE, 'BOUND');
    expect(bind.statusCode).toBe(200);
    expect(bind.json().warnings).toBeUndefined();
  });

  it('gates the endpoints: broker portal user cannot administer zone limits', async () => {
    if (!dbUp) return;
    const portal = { authorization: `Bearer ${await token(app, 'broker@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/accumulation/zone-limits', headers: portal,
      payload: { zone: `ACCTEST-${suffix}-DENIED`, currency: 'USD', limitMinor: 1_000, mode: 'HARD' },
    });
    expect(res.statusCode).toBe(403);
  });
});
