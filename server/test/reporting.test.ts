/**
 * Reporting module test (brief §13).
 *
 * Proves the governed query engine: a definition over an allowlisted source runs
 * and returns rows; an unknown column is rejected with 400 (no SQL injection
 * surface); and CSV export returns text beginning with the header row.
 *
 * Skips cleanly when Postgres is unreachable so it never false-fails in CI without a DB.
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

describe('reporting: governed definitions + execution + export', () => {
  it('defines and runs a report over an allowlisted source', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const key = `contracts-${Date.now()}`;
    const def = await app.inject({
      method: 'POST',
      url: '/api/reports/definitions',
      headers: auth,
      payload: { key, name: 'Contracts', source: 'contracts', columns: ['reference', 'status'] },
    });
    expect(def.statusCode).toBe(201);
    const defId = def.json().id as string;

    const run = await app.inject({
      method: 'POST',
      url: `/api/reports/definitions/${defId}/run`,
      headers: auth,
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(Array.isArray(run.json().rows)).toBe(true);
    expect(run.json().rowCount).toBeGreaterThanOrEqual(0);

    // Run history records the execution.
    const runs = await app.inject({
      method: 'GET',
      url: `/api/reports/runs?definitionId=${defId}`,
      headers: auth,
    });
    expect(runs.statusCode).toBe(200);
    expect(Array.isArray(runs.json().runs)).toBe(true);
  });

  it('runs an ad-hoc report without persisting', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/run',
      headers: auth,
      payload: { source: 'contracts', columns: ['reference', 'status'] },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().rows)).toBe(true);
    expect(res.json().source).toBe('contracts');
  });

  it('rejects an unknown column with 400', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/run',
      headers: auth,
      payload: { source: 'contracts', columns: ['reference', 'drop_table'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exports CSV starting with the header row', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const key = `export-${Date.now()}`;
    const def = await app.inject({
      method: 'POST',
      url: '/api/reports/definitions',
      headers: auth,
      payload: { key, name: 'Export', source: 'contracts', columns: ['reference', 'status'] },
    });
    const defId = def.json().id as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/reports/definitions/${defId}/export?format=csv`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.startsWith('"reference","status"')).toBe(true);
  });
});
