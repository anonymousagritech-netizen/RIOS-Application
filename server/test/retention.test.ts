/**
 * Data retention & legal hold (brief §14). Exercises policy listing, the
 * disposition evaluation (a legal hold overriding an aged-out record), and the
 * permission gate. Skips cleanly without a DB.
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

describe('Retention policies', () => {
  it('lists the seeded policies', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/retention/policies', headers: auth });
    expect(res.statusCode).toBe(200);
    const claim = res.json().policies.find((p: { entityType: string }) => p.entityType === 'claim');
    expect(claim.retentionDays).toBe(3650);
  });
});

describe('Disposition evaluation', () => {
  it('keeps an aged-out claim because a legal hold covers claims', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    // A very old claim (well past 10 years) — but the seeded claim hold overrides.
    const res = await app.inject({
      method: 'POST', url: '/api/retention/evaluate', headers: auth,
      payload: { entityType: 'claim', recordedAt: '2000-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict.onHold).toBe(true);
    expect(res.json().verdict.eligible).toBe(false);
    expect(res.json().verdict.reason).toBe('legal_hold');
  });

  it('marks an aged-out statement (no hold) as eligible', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/retention/evaluate', headers: auth,
      payload: { entityType: 'statement', recordedAt: '2000-01-01T00:00:00Z' },
    });
    expect(res.json().verdict.eligible).toBe(true);
    expect(res.json().verdict.reason).toBe('eligible');
  });

  it('forbids policy authoring without retention:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/retention/policies', headers: auth,
      payload: { entityType: 'x', retentionDays: 1 },
    });
    expect(res.statusCode).toBe(403);
  });
});
