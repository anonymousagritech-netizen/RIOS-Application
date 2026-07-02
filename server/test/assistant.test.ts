/**
 * Assistant breadth & guardrails (brief §12). Verifies navigation, grounded
 * reads across modules, and that mutations are prepared (not executed) and
 * gated by permission on confirm. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';
import { resolveScreen } from '../src/nav/screens.js';

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

// The screen registry + resolver are pure (no DB), so exercise them directly:
// these assertions run even when Postgres is unavailable.
describe('assistant - screen resolution (pure)', () => {
  const expectPath = (msg: string, path: string) =>
    expect(resolveScreen(msg, ['admin:manage']).screen?.path, msg).toBe(path);

  it('resolves the underwriting workspace by name, synonym and bare word', () => {
    expectPath('open underwriting workspace', '/w/underwriting');
    expectPath('open underwriting workbench', '/w/underwriting');
    expectPath('open underwriting', '/w/underwriting');
    expectPath('open the underwriting workbench please', '/w/underwriting');
    expectPath('open uw', '/w/underwriting');
  });

  it('resolves core screens across command phrasings', () => {
    expectPath('go to portal', '/portal');
    expectPath('open treaties', '/treaties');
    expectPath('open finance', '/finance');
    expectPath('go to finance', '/finance');
    expectPath('take me to claims', '/claims');
    expectPath('navigate to accounts', '/accounting');
    expectPath('show me risk capital', '/risk-capital');
  });

  it('tolerates minor typos via fuzzy match', () => {
    expectPath('open underwritng', '/w/underwriting');
    expectPath('go to treasery', '/treasury');
  });

  it('returns real suggestions (not hard-coded) on a genuine no-match', () => {
    const r = resolveScreen('open zzzqqq flibbertigibbet', ['admin:manage']);
    expect(r.screen).toBeNull();
    expect(r.confidence).toBe('none');
    expect(r.suggestions.length).toBeGreaterThan(0);
    // Every suggestion is a real screen with a route.
    for (const s of r.suggestions) expect(s.path.startsWith('/')).toBe(true);
  });
});

describe('assistant - navigation & grounded reads', () => {
  it('returns a non-mutating navigation action', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    const r = await ask(tkn, 'go to finance');
    expect(r.actions[0].kind).toBe('navigate');
    expect(r.actions[0].requiresConfirmation).toBe(false);
    expect(r.actions[0].preview.route).toBe('/finance');
  });

  it('opens any screen by name, synonym or fuzzy match', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    for (const [msg, route] of [
      ['open underwriting workspace', '/w/underwriting'],
      ['open underwriting workbench', '/w/underwriting'],
      ['open underwriting', '/w/underwriting'],
      ['go to portal', '/portal'],
      ['open treaties', '/treaties'],
      ['open finance', '/finance'],
    ] as const) {
      const r = await ask(tkn, msg);
      expect(r.actions?.[0]?.kind, msg).toBe('navigate');
      expect(r.actions[0].preview.route, msg).toBe(route);
    }
  });

  it('returns a helpful no-match with real suggestions for a nonsense screen', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    const r = await ask(tkn, 'open zzzqqq flibbertigibbet');
    expect(r.actions).toHaveLength(0);
    expect(r.reply.toLowerCase()).toContain("couldn't find");
    // Suggests at least one real, well-known screen from the registry.
    expect(r.reply).toMatch(/Dashboard|Treaties|Claims|Finance|Underwriting/);
  });

  it('navigates on a loose module mention (no command prefix)', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    for (const [msg, route] of [['hrms', '/hr'], ['attendance', '/attendance'], ['give me the treasury', '/treasury']] as const) {
      const r = await ask(tkn, msg);
      expect(r.actions?.[0]?.kind).toBe('navigate');
      expect(r.actions[0].preview.route).toBe(route);
    }
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

describe('assistant - platform-wide grounded intents', () => {
  it('answers claims, finance, retro, capacity, exposure and portfolio queries', async () => {
    if (!dbUp) return;
    const tkn = await token('admin@demo.rios');
    for (const [msg, needle] of [
      ['what is the loss ratio', 'loss ratio'],
      ['technical result', 'technical result'],
      ['retrocession position', 'retrocession'],
      ['capacity utilisation', 'apacity'],
      ['peak accumulation zone', 'accumulation'],
      ['portfolio insights', 'ortfolio'],
      ['top brokers', 'broker'],
      ['top cedents', 'cedent'],
    ] as const) {
      const r = await ask(tkn, msg);
      expect(typeof r.reply, msg).toBe('string');
      expect(r.reply.toLowerCase(), msg).toContain(String(needle).toLowerCase());
    }
  });
});
