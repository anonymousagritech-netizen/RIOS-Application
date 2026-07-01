/**
 * Global Search enhancements + AI insights tests. dbUp guard + demo token.
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

describe('Global Search enhancements', () => {
  it('parses NL queries into filters and runs them', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/search/nl?q=bound%20treaties%202026', headers: auth });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.parsed.types).toContain('treaty');
    expect(d.parsed.status).toBe('BOUND');
    expect(d.parsed.year).toBe(2026);
    expect(typeof d.interpreted).toBe('string');
  });

  it('saves, lists and deletes a saved search; records + lists history; suggests', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const name = `Saved ${Date.now()}`;
    const save = await app.inject({ method: 'POST', url: '/api/search/saved', headers: auth, payload: { name, query: 'bound treaties', filters: { types: ['treaty'] } } });
    expect(save.statusCode).toBe(201);
    const id = save.json().id as string;

    const list = await app.inject({ method: 'GET', url: '/api/search/saved', headers: auth });
    expect(list.json().saved.some((s: { id: string }) => s.id === id)).toBe(true);

    await app.inject({ method: 'POST', url: '/api/search/history', headers: auth, payload: { query: 'atlantic mutual', resultsCount: 3 } });
    const hist = await app.inject({ method: 'GET', url: '/api/search/history', headers: auth });
    expect(Array.isArray(hist.json().history)).toBe(true);

    const suggest = await app.inject({ method: 'GET', url: '/api/search/suggest?q=bound', headers: auth });
    expect(Array.isArray(suggest.json().suggestions)).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/search/saved/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);
  });
});

describe('AI Platform insights', () => {
  it('returns ranked, grounded insights grouped by domain', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token('admin@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/ai/insights', headers: auth });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.total).toBeGreaterThan(0);
    expect(Array.isArray(d.domains)).toBe(true);
    expect(d.summary).toHaveProperty('RISK');
    // Ranked: the first insight's severity is >= the last's.
    const order = ['POSITIVE', 'INFO', 'WATCH', 'RISK'];
    expect(order.indexOf(d.insights[0].severity)).toBeGreaterThanOrEqual(order.indexOf(d.insights[d.insights.length - 1].severity));
    for (const i of d.insights) expect(i).toHaveProperty('recommendation');
  });
});
