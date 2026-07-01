/**
 * Bordereau CSV parsing tests (brief §7.10, §29.6 - report gap 5.2).
 *
 * Proves POST /api/bordereaux/parse turns raw CSV text into header-keyed rows
 * that feed the existing upload (rows) and /api/import/validate endpoints:
 * happy path with CRLF, RFC-4180 quoting (embedded delimiters, "" escapes,
 * embedded newlines), custom delimiters, and clear 400s for malformed files
 * (unclosed quote, ragged rows) and oversize files (> 50,000 data rows).
 *
 * Skips cleanly if Postgres is unreachable so it never produces a false failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;
let auth: Record<string, string> = {};

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
  auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('bordereaux: CSV text -> header-keyed rows', () => {
  it('parses a plain CSV (CRLF line endings, trailing newline) into rows keyed by header', async () => {
    if (!dbUp) return; // environment without Postgres
    const res = await app.inject({
      method: 'POST',
      url: '/api/bordereaux/parse',
      headers: auth,
      payload: { csv: 'policy,premium\r\nP-1,1000\r\nP-2,2500\r\n' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.headers).toEqual(['policy', 'premium']);
    expect(body.rowCount).toBe(2);
    expect(body.rows).toEqual([
      { policy: 'P-1', premium: '1000' },
      { policy: 'P-2', premium: '2500' },
    ]);
  });

  it('handles quoted fields: embedded delimiters, "" escapes and embedded newlines', async () => {
    if (!dbUp) return;
    const csv =
      'ref,insured,premium\n' +
      '"P-1","Acme ""Widgets"", Inc.","1000"\n' +
      'P-2,"Line one\nLine two",2500';
    const res = await app.inject({
      method: 'POST',
      url: '/api/bordereaux/parse',
      headers: auth,
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rowCount).toBe(2);
    expect(body.rows[0]).toEqual({ ref: 'P-1', insured: 'Acme "Widgets", Inc.', premium: '1000' });
    expect(body.rows[1]).toEqual({ ref: 'P-2', insured: 'Line one\nLine two', premium: '2500' });
  });

  it('supports a custom delimiter and pads short rows with empty strings', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/bordereaux/parse',
      headers: auth,
      payload: { csv: 'ref;amount;comment\nP-1;1000;"a;b"\nP-2;2500', delimiter: ';' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.headers).toEqual(['ref', 'amount', 'comment']);
    expect(body.rows[0]).toEqual({ ref: 'P-1', amount: '1000', comment: 'a;b' });
    expect(body.rows[1]).toEqual({ ref: 'P-2', amount: '2500', comment: '' });
  });

  it('rejects a malformed CSV (unclosed quote) with a 400 and a line-level message', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/bordereaux/parse',
      headers: auth,
      payload: { csv: 'ref,premium\n"P-1,1000\nP-2,2500\n' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain('Malformed CSV');
    expect(body.error).toContain('unterminated quoted field');
    expect(body.error).toContain('line 2');
  });

  it('rejects a ragged row (more fields than headers) with its row number', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/bordereaux/parse',
      headers: auth,
      payload: { csv: 'ref,premium\nP-1,1000\nP-2,2500,EXTRA\n' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('row 3 has 3 fields but the header has 2');
  });

  it('caps files at 50,000 data rows with a 413-style 400', async () => {
    if (!dbUp) return;
    const csv = 'premium\n' + '1\n'.repeat(50_001);
    const res = await app.inject({
      method: 'POST',
      url: '/api/bordereaux/parse',
      headers: auth,
      payload: { csv },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('50000-row limit');
  });

  it('parsed rows feed the existing bordereau upload endpoint', async () => {
    if (!dbUp) return;
    const parsed = await app.inject({
      method: 'POST',
      url: '/api/bordereaux/parse',
      headers: auth,
      payload: { csv: 'policy,premium\nP-1,1000\nP-2,2500\n' },
    });
    expect(parsed.statusCode).toBe(200);
    const { rows, rowCount } = parsed.json();

    // The upload endpoint accepts the parsed rows verbatim (amounts arrive as
    // strings, so the line validator flags them - proving the wiring, and that
    // the parse endpoint stays a pure text->rows step with no silent coercion).
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/bordereaux',
      headers: auth,
      payload: { kind: 'PREMIUM', currency: 'USD', rows },
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().rowCount).toBe(rowCount);
  });
});
