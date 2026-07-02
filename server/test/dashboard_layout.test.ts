/**
 * Dashboard designer (0077): no-code personal / shared dashboards composed of
 * KPI + chart tiles from the live /api/executive packs. Proves the seeded
 * tenant-wide default is visible, a user can save & re-load a personal layout
 * (tiles round-trip), the "share with tenant" path is gated on platform:write
 * (403 for a non-privileged user), zod rejects a bad tile (400), and a personal
 * layout can be deleted. Skips without a DB.
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

describe('Seeded tenant-wide default dashboard', () => {
  it('is visible to any authenticated user as a shared, non-owned layout', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({ method: 'GET', url: '/api/dashboards/layouts', headers: auth });
    expect(res.statusCode).toBe(200);
    const layouts = res.json().layouts as Array<{ name: string; shared: boolean; owned: boolean; isDefault: boolean; tiles: unknown[] }>;
    const shared = layouts.find((l) => l.name === 'Company overview');
    expect(shared).toBeTruthy();
    expect(shared!.shared).toBe(true);
    expect(shared!.owned).toBe(false);
    expect(shared!.isDefault).toBe(true);
    expect(shared!.tiles.length).toBe(6);
  });
});

describe('Personal layout save & reload', () => {
  it('saves a personal layout and reads back the exact tiles', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };
    const tiles = [
      { persona: 'CEO', kind: 'kpi', ref: 'Gross written premium', size: 'sm' },
      { persona: 'CHIEF_UW', kind: 'chart', ref: 'Submission pipeline', size: 'md' },
    ];
    const save = await app.inject({
      method: 'POST', url: '/api/dashboards/layouts', headers: auth,
      payload: { name: 'UW desk', tiles, isDefault: true, shared: false },
    });
    expect(save.statusCode).toBe(201);
    const id = save.json().id as string;

    const list = await app.inject({ method: 'GET', url: '/api/dashboards/layouts', headers: auth });
    const mine = (list.json().layouts as Array<{ id: string; owned: boolean; shared: boolean; tiles: typeof tiles }>).find((l) => l.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.owned).toBe(true);
    expect(mine!.shared).toBe(false);
    expect(mine!.tiles).toEqual(tiles);

    // Upsert (same name) replaces the tiles rather than duplicating.
    const again = await app.inject({
      method: 'POST', url: '/api/dashboards/layouts', headers: auth,
      payload: { name: 'UW desk', tiles: [tiles[0]], isDefault: true, shared: false },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(id);

    // Clean up so re-runs stay deterministic.
    const del = await app.inject({ method: 'DELETE', url: `/api/dashboards/layouts/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);
  });

  it('is isolated per user: another user does not see a personal layout', async () => {
    if (!dbUp) return;
    const uw = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };
    const save = await app.inject({
      method: 'POST', url: '/api/dashboards/layouts', headers: uw,
      payload: { name: 'Private UW', tiles: [{ persona: 'CEO', kind: 'kpi', ref: 'Open claims', size: 'sm' }] },
    });
    const id = save.json().id as string;

    const other = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/dashboards/layouts', headers: other });
    const names = (list.json().layouts as Array<{ name: string }>).map((l) => l.name);
    expect(names).not.toContain('Private UW');

    await app.inject({ method: 'DELETE', url: `/api/dashboards/layouts/${id}`, headers: uw });
  });
});

describe('Guardrails', () => {
  it('forbids sharing a layout tenant-wide without platform:write (403)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/dashboards/layouts', headers: auth,
      payload: { name: 'Sneaky shared', tiles: [{ persona: 'CEO', kind: 'kpi', ref: 'Open claims', size: 'sm' }], shared: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid tile (400)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/dashboards/layouts', headers: auth,
      payload: { name: 'Bad', tiles: [{ persona: 'CEO', kind: 'gauge', ref: 'x', size: 'sm' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets an admin (platform:write) save a shared layout tenant-wide', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/dashboards/layouts', headers: auth,
      payload: { name: 'Ops board', tiles: [{ persona: 'OPERATIONS', kind: 'chart', ref: 'Tasks by status', size: 'md' }], shared: true, isDefault: false },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    // Visible to a different user as a shared layout.
    const other = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/dashboards/layouts', headers: other });
    expect((list.json().layouts as Array<{ id: string; shared: boolean }>).some((l) => l.id === id && l.shared)).toBe(true);
    // Clean up (admin can delete shared).
    const del = await app.inject({ method: 'DELETE', url: `/api/dashboards/layouts/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);
  });
});
