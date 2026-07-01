/**
 * Regulatory & Compliance integration test. dbUp guard + demo token.
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

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('Regulatory & Compliance', () => {
  it('returns the compliance command center with audit, approvals, activity and calendar', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/compliance', headers: auth });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.totals).toHaveProperty('auditEntries');
    expect(d.totals).toHaveProperty('chainVerifiedPct');
    expect(typeof d.totals.chainOk).toBe('boolean');
    expect(Array.isArray(d.audit.byAction)).toBe(true);
    expect(Array.isArray(d.audit.recent)).toBe(true);
    expect(Array.isArray(d.approvals)).toBe(true);
    expect(Array.isArray(d.activity)).toBe(true);
    expect(Array.isArray(d.calendar)).toBe(true);
  });

  it('denies access without regulatory:read', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('broker@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/compliance', headers: auth });
    expect(res.statusCode).toBe(403);
  });
});
