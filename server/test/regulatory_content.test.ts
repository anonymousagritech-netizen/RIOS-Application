/**
 * Regulatory content-as-versioned-config + filing-validation engine
 * (moves "Regulatory / Returns" towards Delivered).
 *
 *  1. Content versioning: GET the effective content (shipped code default,
 *     is_certified=false) → POST a tenant override (v2) → GET returns the
 *     override as the latest version, still is_certified=false labelled.
 *  2. Validation PASS: assemble + validate SOLVENCY2_QRT against its content -
 *     required cells present and the balance-sheet / recoverable control totals
 *     tie (structural identities that hold whenever the GL balances) → PASS,
 *     persisted with per-rule items and surfaced in the history.
 *  3. Validation FAIL (built honestly): a stricter tenant content version that
 *     requires a disclosure cell the assembly does not yet map → the engine
 *     correctly reports the missing required cell and the run is FAIL.
 *  Plus the permission gate (403) and unknown-content/pack guards.
 *
 * Requires a migrated + seeded database; skips cleanly when Postgres is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

const today = new Date().toISOString().slice(0, 10);

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

type ContentEntry = {
  jurisdiction: string;
  contentKey: string;
  version: number;
  isCertified: boolean;
  source: string;
  body: {
    packCode: string;
    factorBands: unknown[];
    requiredCells: Array<{ template: string; code: string; label: string }>;
    controls: unknown[];
    disclaimer: string;
  };
};
type ValidationItem = { ruleKey: string; severity: string; message: string; ok: boolean };
type ValidationResult = {
  id: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  contentVersion: number;
  contentSource: string;
  isCertified: boolean;
  items: ValidationItem[];
};

describe('regulatory content-as-config + filing validation', () => {
  let auth: { authorization: string };

  it('serves the shipped default content as illustrative, not certified (is_certified=false)', async () => {
    if (!dbUp) return;
    auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const res = await app.inject({
      method: 'GET',
      url: '/api/regulatory/content?jurisdiction=US&key=NAIC_SCHEDULE_F',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const content = res.json().content as ContentEntry[];
    expect(content).toHaveLength(1);
    const c = content[0]!;
    expect(c.jurisdiction).toBe('US');
    expect(c.contentKey).toBe('NAIC_SCHEDULE_F');
    // On a fresh DB the effective content is the shipped code default (v1); the
    // assertion below is written relatively so it also holds on reruns where an
    // earlier override persists. Either way it is NEVER certified.
    expect(['code-default', 'tenant-override']).toContain(c.source);
    expect(c.version).toBeGreaterThanOrEqual(1);
    // HONESTY: shipped defaults are never presented as certified.
    expect(c.isCertified).toBe(false);
    expect(c.body.packCode).toBe('NAIC_SCHEDULE_F');
    expect(c.body.requiredCells.length).toBeGreaterThan(0);
  });

  it('gates content + validation endpoints behind regulatory permissions (403 for portal users)', async () => {
    if (!dbUp) return;
    const portal = { authorization: `Bearer ${await token(app, 'broker@demo.rios')}` };
    const get = await app.inject({ method: 'GET', url: '/api/regulatory/content', headers: portal });
    expect(get.statusCode).toBe(403);
    const post = await app.inject({
      method: 'POST', url: '/api/regulatory/content', headers: portal,
      payload: { jurisdiction: 'US', contentKey: 'NAIC_SCHEDULE_F', body: {} },
    });
    expect(post.statusCode).toBe(403);
    const validate = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/SOLVENCY2_QRT/validate', headers: portal, payload: { asOf: today },
    });
    expect(validate.statusCode).toBe(403);
  });

  it('versions content: a tenant override becomes the latest version, still is_certified=false', async () => {
    if (!dbUp) return;

    // Take the effective default body and re-post it as a tenant override; the
    // new version must outrank whatever was effective before.
    const before = await app.inject({
      method: 'GET', url: '/api/regulatory/content?jurisdiction=US&key=NAIC_SCHEDULE_F', headers: auth,
    });
    const beforeEntry = (before.json().content as ContentEntry[])[0]!;

    const post = await app.inject({
      method: 'POST', url: '/api/regulatory/content', headers: auth,
      payload: { jurisdiction: 'US', contentKey: 'NAIC_SCHEDULE_F', effectiveFrom: today, body: beforeEntry.body },
    });
    expect(post.statusCode).toBe(201);
    const created = post.json() as { version: number; isCertified: boolean };
    expect(created.version).toBeGreaterThan(beforeEntry.version); // outranks prior effective version
    expect(created.isCertified).toBe(false); // default: not asserted certified

    const after = await app.inject({
      method: 'GET', url: '/api/regulatory/content?jurisdiction=US&key=NAIC_SCHEDULE_F', headers: auth,
    });
    const c = (after.json().content as ContentEntry[])[0]!;
    expect(c.version).toBe(created.version);
    expect(c.source).toBe('tenant-override');
    // The override is still labelled not certified (honesty preserved).
    expect(c.isCertified).toBe(false);
  });

  it('validates SOLVENCY2_QRT → PASS when required cells present and control totals tie', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/SOLVENCY2_QRT/validate', headers: auth, payload: { asOf: today },
    });
    expect(res.statusCode).toBe(201);
    const v = res.json() as ValidationResult & { disclaimer: string };
    expect(v.status).toBe('PASS');
    expect(v.isCertified).toBe(false);
    expect(v.disclaimer).toMatch(/template, not certified content/i);
    // Every rule evaluated passed.
    expect(v.items.length).toBeGreaterThan(0);
    expect(v.items.every((i) => i.ok)).toBe(true);
    // The balance-sheet control tie was actually checked.
    const balanceTie = v.items.find((i) => i.ruleKey.includes('S02_BALANCE_SHEET_TIE'));
    expect(balanceTie).toBeDefined();
    expect(balanceTie!.ok).toBe(true);

    // Persisted to history.
    const hist = await app.inject({
      method: 'GET', url: '/api/regulatory/packs/SOLVENCY2_QRT/validations', headers: auth,
    });
    expect(hist.statusCode).toBe(200);
    const rows = hist.json().validations as Array<{ id: string; status: string }>;
    expect(rows.some((r) => r.id === v.id && r.status === 'PASS')).toBe(true);
  });

  it('validates IRDAI and NAIC packs → PASS (structural ties hold)', async () => {
    if (!dbUp) return;
    for (const code of ['IRDAI_REINSURANCE_RETURNS', 'NAIC_SCHEDULE_F']) {
      const res = await app.inject({
        method: 'POST', url: `/api/regulatory/packs/${code}/validate`, headers: auth, payload: { asOf: today },
      });
      expect(res.statusCode).toBe(201);
      const v = res.json() as ValidationResult;
      expect(v.status).toBe('PASS');
      expect(v.items.every((i) => i.ok)).toBe(true);
    }
  });

  it('validates → FAIL honestly when a stricter content version requires an unmapped cell', async () => {
    if (!dbUp) return;
    const MARKER = 'S02_NONEXISTENT_DISCLOSURE';

    // Effective S2 content, stripped of any marker cell a prior run may have
    // left, so this test is rerun- and parallel-safe.
    const before = await app.inject({
      method: 'GET', url: '/api/regulatory/content?jurisdiction=EU&key=SOLVENCY2_QRT', headers: auth,
    });
    const raw = (before.json().content as ContentEntry[])[0]!.body;
    const cleanBody = { ...raw, requiredCells: raw.requiredCells.filter((c) => !c.code.includes(MARKER)) };
    const stricter = {
      ...cleanBody,
      requiredCells: [
        ...cleanBody.requiredCells,
        { template: 'S.02.01', code: MARKER, label: 'Disclosure not yet mapped by assembly' },
      ],
    };
    const post = await app.inject({
      method: 'POST', url: '/api/regulatory/content', headers: auth,
      payload: { jurisdiction: 'EU', contentKey: 'SOLVENCY2_QRT', body: stricter },
    });
    expect(post.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/SOLVENCY2_QRT/validate', headers: auth, payload: { asOf: today },
    });
    expect(res.statusCode).toBe(201);
    const v = res.json() as ValidationResult;
    expect(v.status).toBe('FAIL');
    expect(v.contentSource).toBe('tenant-override');
    const missing = v.items.find((i) => i.ruleKey.includes(MARKER));
    expect(missing).toBeDefined();
    expect(missing!.ok).toBe(false);
    expect(missing!.severity).toBe('ERROR');
    // The structural controls still passed - only the unmapped required cell fails.
    expect(v.items.some((i) => i.ruleKey.includes('S02_BALANCE_SHEET_TIE') && i.ok)).toBe(true);

    const hist = await app.inject({
      method: 'GET', url: '/api/regulatory/packs/SOLVENCY2_QRT/validations', headers: auth,
    });
    const rows = hist.json().validations as Array<{ id: string; status: string }>;
    expect(rows.some((r) => r.id === v.id && r.status === 'FAIL')).toBe(true);

    // Self-heal: publish a clean version so the effective content passes again
    // for any later / repeated run, then confirm the engine reports PASS.
    const restore = await app.inject({
      method: 'POST', url: '/api/regulatory/content', headers: auth,
      payload: { jurisdiction: 'EU', contentKey: 'SOLVENCY2_QRT', body: cleanBody },
    });
    expect(restore.statusCode).toBe(201);
    const revalidate = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/SOLVENCY2_QRT/validate', headers: auth, payload: { asOf: today },
    });
    expect((revalidate.json() as ValidationResult).status).toBe('PASS');
  });

  it('rejects unknown content (404) and unknown pack (404) and malformed body (400)', async () => {
    if (!dbUp) return;
    const unknownContent = await app.inject({
      method: 'POST', url: '/api/regulatory/content', headers: auth,
      payload: { jurisdiction: 'ZZ', contentKey: 'NOPE', body: {} },
    });
    expect(unknownContent.statusCode).toBe(404);

    const badBody = await app.inject({
      method: 'POST', url: '/api/regulatory/content', headers: auth,
      payload: { jurisdiction: 'US' },
    });
    expect(badBody.statusCode).toBe(400);

    const unknownPack = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/NOT_A_PACK/validate', headers: auth, payload: { asOf: today },
    });
    expect(unknownPack.statusCode).toBe(404);
  });
});
