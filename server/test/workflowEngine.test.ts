/**
 * Workflow Engine console test. dbUp guard + demo token.
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

describe('Workflow Engine console', () => {
  it('returns SLA-scored tasks, escalations and the approval matrix', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/workflow-engine', headers: auth });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.totals).toHaveProperty('slaCompliancePct');
    expect(d.slaBook).toHaveProperty('breached');
    expect(Array.isArray(d.tasks)).toBe(true);
    expect(Array.isArray(d.escalations)).toBe(true);
    expect(Array.isArray(d.approvals)).toBe(true);
    // Every scored task carries an SLA state and escalation tier.
    for (const t of d.tasks) {
      expect(['ON_TRACK', 'AT_RISK', 'DUE_SOON', 'BREACHED', 'DONE', 'NO_DUE']).toContain(t.slaState);
      expect(typeof t.escalationTier).toBe('number');
    }
  });

  it('denies access without workflow:read', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('broker@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/workflow-engine', headers: auth });
    expect(res.statusCode).toBe(403);
  });
});
