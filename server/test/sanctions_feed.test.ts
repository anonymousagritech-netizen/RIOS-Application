/**
 * Sanctions feed provider adapter (brief §12). Refreshes the denylist from the
 * bundled sample provider, confirms the entries load and the status reports the
 * refresh, screens the party book (a party named to match the sample list must
 * be flagged), and checks the permission gate. Skips cleanly without a DB.
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

describe('Sanctions feed adapter', () => {
  it('refreshes the denylist and reports status', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const refresh = await app.inject({ method: 'POST', url: '/api/sanctions/refresh', headers: auth });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().entryCount).toBeGreaterThanOrEqual(4);

    const list = await app.inject({ method: 'GET', url: '/api/sanctions/list', headers: auth });
    const sample = list.json().entries.filter((e: { listSource: string }) => e.listSource === 'OFAC-SAMPLE');
    expect(sample.length).toBeGreaterThanOrEqual(4);

    const status = await app.inject({ method: 'GET', url: '/api/sanctions/status', headers: auth });
    expect(status.json().refreshes.some((r: { source: string }) => r.source === 'OFAC-SAMPLE')).toBe(true);
  });

  it('screen-all flags a party matching the sample list', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    // Ensure the list is loaded, then add a party that exactly matches an entry.
    await app.inject({ method: 'POST', url: '/api/sanctions/refresh', headers: auth });
    await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: 'Sanctioned Holdings International', roles: ['cedent'] },
    });
    const res = await app.inject({ method: 'POST', url: '/api/sanctions/screen-all', headers: auth });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.screened).toBeGreaterThanOrEqual(1);
    // The exact-match party must be BLOCKED.
    expect(b.blocked).toBeGreaterThanOrEqual(1);
  });

  it('forbids refresh without party:write', async () => {
    if (!dbUp) return;
    // The accountant has party:read but not party:write.
    const auth = { authorization: `Bearer ${await loginToken('acct@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/sanctions/refresh', headers: auth });
    expect(res.statusCode).toBe(403);
  });
});
