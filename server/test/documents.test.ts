/**
 * Documents/Templates module test (brief §9.4).
 *
 * Proves the pure merge engine: a template with {{ dotted.path }} placeholders is
 * rendered against a context object, the generated document equals the expected
 * string, and the persisted document is retrievable with its content.
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

describe('documents: template engine + generation', () => {
  it('renders a template and persists a retrievable document', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const key = `slip-${Date.now()}`;
    const tmpl = await app.inject({
      method: 'POST',
      url: '/api/documents/templates',
      headers: auth,
      payload: {
        key,
        name: 'Cover Slip',
        docType: 'slip',
        body: 'Slip for {{contract.name}} - {{contract.currency}}',
      },
    });
    expect(tmpl.statusCode).toBe(201);

    const gen = await app.inject({
      method: 'POST',
      url: '/api/documents/generate',
      headers: auth,
      payload: {
        templateKey: key,
        title: 'Generated Slip',
        context: { contract: { name: 'Test Cover', currency: 'USD' } },
      },
    });
    expect(gen.statusCode).toBe(201);
    expect(gen.json().content).toBe('Slip for Test Cover - USD');

    const docId = gen.json().id as string;
    const fetched = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: auth });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().content).toBe('Slip for Test Cover - USD');
    expect(fetched.json().title).toBe('Generated Slip');
  });

  it('renders missing placeholders as empty strings', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const key = `gap-${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/documents/templates',
      headers: auth,
      payload: { key, name: 'Gap', body: 'A[{{a}}]B[{{missing.path}}]C' },
    });
    const gen = await app.inject({
      method: 'POST',
      url: '/api/documents/generate',
      headers: auth,
      payload: { templateKey: key, title: 'Gap doc', context: { a: 'x' } },
    });
    expect(gen.json().content).toBe('A[x]B[]C');
  });
});
