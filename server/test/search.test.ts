/**
 * Global search (brief §11.3). Proves cross-entity search returns hits, respects
 * per-entity RBAC (a portal user with no read perms gets nothing), and ignores
 * too-short queries. Skips cleanly without a DB.
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

describe('Global search', () => {
  it('finds parties and contracts for an admin', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/search?q=Atlantic', headers: auth });
    expect(res.statusCode).toBe(200);
    const types = res.json().groups.map((g: { type: string }) => g.type);
    expect(types).toContain('party'); // Atlantic Mutual
    const hit = res.json().results.find((h: { label: string }) => /Atlantic/.test(h.label));
    expect(hit.url).toMatch(/^\/parties\//);
  });

  it('respects per-entity permissions — a portal user sees no privileged entities', async () => {
    if (!dbUp) return;
    // broker@ holds only portal:read, so none of the search sources are allowed.
    const auth = { authorization: `Bearer ${await loginToken('broker@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/search?q=Atlantic', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(0);
  });

  it('ignores queries shorter than two characters', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/search?q=a', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(0);
  });
});
