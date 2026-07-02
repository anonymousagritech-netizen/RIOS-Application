/**
 * Reporting: semantic metric layer + Excel/PDF export packs (brief §13).
 *
 * Proves:
 *  - global default metrics ship and list (tenant_id null, read via RLS carve-out);
 *  - a tenant-defined metric resolves through the SAME governed aggregation and
 *    its value matches a direct aggregation of the same source (cross-checked
 *    against the governed ad-hoc report row count);
 *  - a seeded ratio metric resolves to a number (or null);
 *  - the .xlsx export returns a real ZIP-based workbook (PK signature) and the
 *    .pdf export returns a real binary PDF (%PDF signature), both non-empty.
 *
 * Skips cleanly when Postgres is unreachable so CI without a DB never false-fails.
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

describe('reporting: semantic metric layer', () => {
  it('ships and lists global default metrics', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const res = await app.inject({ method: 'GET', url: '/api/reports/metrics', headers: { authorization: `Bearer ${tkn}` } });
    expect(res.statusCode).toBe(200);
    const metrics = res.json().metrics as { key: string; isGlobal: boolean }[];
    const keys = metrics.map((m) => m.key);
    expect(keys).toContain('gross_written_premium');
    expect(keys).toContain('loss_ratio');
    expect(metrics.find((m) => m.key === 'gross_written_premium')!.isGlobal).toBe(true);
  });

  it('defines a metric and resolves it to match a direct aggregation', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const key = `contract_count_${Date.now()}`;
    const create = await app.inject({
      method: 'POST',
      url: '/api/reports/metrics',
      headers: auth,
      payload: {
        key,
        name: 'Contract count (test)',
        source: 'contracts',
        expression: { kind: 'aggregation', source: 'contracts', measure: '*', agg: 'count' },
        unit: 'count',
        format: 'number',
      },
    });
    expect(create.statusCode).toBe(201);

    const resolved = await app.inject({ method: 'GET', url: `/api/reports/metrics/${key}/value`, headers: auth });
    expect(resolved.statusCode).toBe(200);
    const value = resolved.json().value as number;

    // Cross-check: a governed ad-hoc report over the same source returns the same count.
    const run = await app.inject({
      method: 'POST',
      url: '/api/reports/run',
      headers: auth,
      payload: { source: 'contracts', columns: ['id'] },
    });
    expect(run.statusCode).toBe(200);
    expect(value).toBe(run.json().rowCount as number);
  });

  it('resolves a seeded ratio metric to a number (or null)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/reports/metrics/loss_ratio/value', headers: auth });
    expect(res.statusCode).toBe(200);
    const v = res.json().value;
    expect(v === null || typeof v === 'number').toBe(true);
    expect(res.json().format).toBe('percent');
  });

  it('rejects a metric over an unknown measure with 400', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/metrics',
      headers: auth,
      payload: {
        key: `bad_${Date.now()}`,
        name: 'Bad',
        source: 'contracts',
        expression: { kind: 'aggregation', source: 'contracts', measure: 'drop_table', agg: 'sum' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown metric key', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/reports/metrics/does_not_exist/value', headers: auth });
    expect(res.statusCode).toBe(404);
  });
});

describe('reporting: Excel + PDF export packs', () => {
  async function makeDefinition(auth: Record<string, string>): Promise<string> {
    const def = await app.inject({
      method: 'POST',
      url: '/api/reports/definitions',
      headers: auth,
      payload: { key: `export-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: 'Export pack', source: 'contracts', columns: ['reference', 'status'] },
    });
    return def.json().id as string;
  }

  it('exports a real .xlsx workbook (ZIP signature, non-empty)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const id = await makeDefinition(auth);
    const res = await app.inject({ method: 'GET', url: `/api/reports/definitions/${id}/export.xlsx`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    const buf = res.rawPayload;
    expect(buf.length).toBeGreaterThan(0);
    // A valid .xlsx is a ZIP: begins with the local file header magic "PK\x03\x04".
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('exports a real binary .pdf (%PDF signature, non-empty)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const id = await makeDefinition(auth);
    const res = await app.inject({ method: 'GET', url: `/api/reports/definitions/${id}/export.pdf`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const buf = res.rawPayload;
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
