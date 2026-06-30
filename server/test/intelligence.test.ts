/**
 * AI & channels batch (brief §5, §9.4, §13, §9.11): OCR extraction, voice → the
 * assistant, renewal insights, narrative generation, and the mobile home/manifest.
 * Skips cleanly without a DB.
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

describe('OCR / document intelligence', () => {
  it('extracts fields from cover-note text with a confidence score', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const text = 'Policy No: ZZ-9001\nPremium: USD $750,000.00\nInception date: 2026-04-01';
    const res = await app.inject({ method: 'POST', url: '/api/ocr/extract', headers: auth, payload: { documentType: 'cover_note', text } });
    expect(res.statusCode).toBe(200);
    expect(res.json().fields.policyNumber).toBe('ZZ-9001');
    expect(res.json().fields.premium).toBe('750,000.00');
    expect(res.json().confidence).toBeGreaterThan(0);
  });
});

describe('Voice assistant', () => {
  it('routes a spoken transcript through the assistant', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/voice/interpret', headers: auth, payload: { transcript: 'Hey RIOS, take me to the dashboard please.' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().normalized).toContain('dashboard');
    expect(res.json().response).toBeTruthy(); // assistant produced a response
  });
});

describe('AI prediction & generation', () => {
  it('scores renewal likelihood per contract', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/insights/renewals', headers: auth });
    expect(res.statusCode).toBe(200);
    const first = res.json().insights[0];
    expect(first).toHaveProperty('renewalLikelihood');
    expect(['unlikely', 'at-risk', 'likely']).toContain(first.band);
  });

  it('generates a narrative executive summary', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({ method: 'POST', url: '/api/generate/summary', headers: auth, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().narrative).toMatch(/portfolio holds \d+ contracts/);
  });
});

describe('Mobile portal', () => {
  it('returns a condensed home and a PWA manifest', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const home = await app.inject({ method: 'GET', url: '/api/mobile/home', headers: auth });
    expect(home.statusCode).toBe(200);
    expect(home.json().tiles.length).toBe(3);

    const manifest = await app.inject({ method: 'GET', url: '/api/mobile/manifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().short_name).toBe('RIOS');
  });
});
