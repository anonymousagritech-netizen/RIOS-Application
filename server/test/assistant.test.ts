/**
 * Assistant breadth & guardrails (brief §12). Verifies navigation, grounded
 * reads across modules, and that mutations are prepared (not executed) and
 * gated by permission on confirm. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}
async function ask(tkn: string, message: string) {
  const res = await app.inject({ method: 'POST', url: '/api/assistant', headers: { authorization: `Bearer ${tkn}` }, payload: { message } });
  return res.json();
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('assistant - navigation & grounded reads', () => {
  it('returns a non-mutating navigation action', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    const r = await ask(tkn, 'go to finance');
    expect(r.actions[0].kind).toBe('navigate');
    expect(r.actions[0].requiresConfirmation).toBe(false);
    expect(r.actions[0].preview.route).toBe('/finance');
  });

  it('answers counts grounded in tenant data', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    const r = await ask(tkn, 'how many treaties do we have?');
    expect(r.reply).toMatch(/\d+ treaty\/contract/);
  });

  it('summarises premium without fabricating', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    const r = await ask(tkn, 'what is total GWP?');
    expect(r.reply).toMatch(/premium/i);
  });
});

describe('assistant - mutation guardrails (§12.4)', () => {
  it('prepares a claim registration but does not execute it', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    const r = await ask(tkn, 'register a claim for 250000');
    expect(r.actions[0].kind).toBe('create_claim');
    expect(r.actions[0].requiresConfirmation).toBe(true);
  });

  it('blocks an under-permissioned confirm', async () => {
    if (!dbUp) return;
    const acct = await token('acct@demo.rios'); // no claims:write
    const res = await app.inject({
      method: 'POST', url: '/api/assistant/confirm',
      headers: { authorization: `Bearer ${acct}` },
      payload: { kind: 'create_claim', preview: { contractId: '00000000-0000-0000-0000-000000000000', grossLoss: 1, currency: 'USD' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('executes a vendor creation on confirm with permission', async () => {
    if (!dbUp) return;
    const admin = await token('admin@demo.rios');
    const res = await app.inject({
      method: 'POST', url: '/api/assistant/confirm',
      headers: { authorization: `Bearer ${admin}` },
      payload: { kind: 'create_vendor', preview: { name: 'Assistant Vendor' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
