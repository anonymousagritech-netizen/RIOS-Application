/**
 * Signing workflow integration test (gap-analysis §2.2 item 1):
 *   written vs signed lines - pro-rata signing down of an oversubscribed slip,
 *   the signing-down-only guard (signed may never exceed written), the
 *   order-total guard, and the written/signed reconciliation view.
 *
 * Requires a migrated + seeded database. Skips cleanly if Postgres is
 * unreachable so it never produces a false failure without PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'demo1234', tenantCode: 'demo' },
  });
  return res.json().token as string;
}

interface Auth {
  authorization: string;
}

async function createParty(app: FastifyInstance, auth: Auth, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/parties',
    headers: auth,
    payload: { legalName: `${name} Ltd`, shortName: name, roles: ['reinsurer'] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** Contract + slip + written lines; returns slip id and line ids in order. */
async function slipWithLines(
  app: FastifyInstance,
  auth: Auth,
  name: string,
  orderPct: number,
  writtenLines: number[],
): Promise<{ slipId: string; lineIds: string[] }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/treaties',
    headers: auth,
    payload: { name, basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD' },
  });
  expect(created.statusCode).toBe(201);
  const contractId = created.json().id as string;

  const slip = await app.inject({
    method: 'POST',
    url: '/api/placement/slips',
    headers: auth,
    payload: { contractId, orderPct },
  });
  expect(slip.statusCode).toBe(201);
  const slipId = slip.json().id as string;

  const lineIds: string[] = [];
  for (let i = 0; i < writtenLines.length; i++) {
    const partyId = await createParty(app, auth, `${name} Re ${i + 1}`);
    const line = await app.inject({
      method: 'POST',
      url: `/api/placement/slips/${slipId}/lines`,
      headers: auth,
      payload: { partyId, writtenLine: writtenLines[i] },
    });
    expect(line.statusCode).toBe(201);
    lineIds.push(line.json().id as string);
  }
  return { slipId, lineIds };
}

beforeAll(async () => {
  try {
    await appPool.query('select 1');
  } catch {
    dbUp = false;
    return;
  }
  app = await buildApp();
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('signing workflow: written vs signed', () => {
  it('PRO_RATA signs an oversubscribed slip down to the order', async () => {
    if (!dbUp) return; // environment without Postgres
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    // Three lines writing 1.5 against a 100% order → oversubscribed by 50%.
    const written = [0.6, 0.5, 0.4];
    const { slipId } = await slipWithLines(app, auth, 'Signing ProRata Treaty', 1.0, written);

    const signed = await app.inject({
      method: 'POST',
      url: `/api/placement/slips/${slipId}/sign`,
      headers: auth,
      payload: { mode: 'PRO_RATA' },
    });
    expect(signed.statusCode).toBe(200);
    const body = signed.json();
    expect(body.status).toBe('SIGNED');
    expect(body.totalWritten).toBeCloseTo(1.5, 6);
    expect(body.totalSigned).toBeCloseTo(1.0, 6); // Σ signed ≈ order

    // Each signed line ≤ its written line and equals written × order/total.
    const factor = 1.0 / 1.5;
    for (const line of body.lines) {
      expect(line.signedLine).toBeLessThanOrEqual(line.writtenLine);
      expect(line.signedLine).toBeCloseTo(line.writtenLine * factor, 6);
    }
    const sum = body.lines.reduce((acc: number, l: { signedLine: number }) => acc + l.signedLine, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it('rejects an explicit signed line above the written line (signing down only)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const { slipId, lineIds } = await slipWithLines(app, auth, 'Signing Up Guard Treaty', 1.0, [0.3, 0.2]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/placement/slips/${slipId}/sign`,
      headers: auth,
      payload: { lines: [{ lineId: lineIds[0], signedLine: 0.5 }] }, // 0.5 > written 0.3
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/signing down/i);
  });

  it('rejects explicit signed lines whose total exceeds the order', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const { slipId, lineIds } = await slipWithLines(app, auth, 'Signing Order Guard Treaty', 0.5, [0.4, 0.3]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/placement/slips/${slipId}/sign`,
      headers: auth,
      payload: {
        lines: [
          { lineId: lineIds[0], signedLine: 0.4 },
          { lineId: lineIds[1], signedLine: 0.3 }, // total 0.7 > order 0.5
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/exceeds the order/i);
  });

  it('accepts a valid explicit sign-down and shows it in the reconciliation view', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const { slipId, lineIds } = await slipWithLines(app, auth, 'Signing Recon Treaty', 1.0, [0.7, 0.5, 0.3]);

    // Before signing: oversubscribed (1.5 written vs 1.0 order), nothing signed.
    const preRes = await app.inject({ method: 'GET', url: `/api/placement/slips/${slipId}/signing`, headers: auth });
    expect(preRes.statusCode).toBe(200);
    const pre = preRes.json();
    expect(pre.totals.writtenTotal).toBeCloseTo(1.5, 6);
    expect(pre.totals.signedTotal).toBeCloseTo(0, 6);
    expect(pre.totals.orderPct).toBeCloseTo(1.0, 6);
    expect(pre.totals.oversubscribed).toBe(true);
    expect(pre.totals.fullySigned).toBe(false);
    for (const line of pre.lines) {
      expect(line.signedLine).toBeNull();
      expect(line.deltaLine).toBeNull();
    }

    // Explicit sign-down to exactly the order.
    const signed = await app.inject({
      method: 'POST',
      url: `/api/placement/slips/${slipId}/sign`,
      headers: auth,
      payload: {
        lines: [
          { lineId: lineIds[0], signedLine: 0.5 },
          { lineId: lineIds[1], signedLine: 0.3 },
          { lineId: lineIds[2], signedLine: 0.2 },
        ],
      },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().totalSigned).toBeCloseTo(1.0, 6);

    // Reconciliation view: per-line deltas and slip totals.
    const res = await app.inject({ method: 'GET', url: `/api/placement/slips/${slipId}/signing`, headers: auth });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.slipId).toBe(slipId);
    expect(view.status).toBe('SIGNED');
    expect(view.lines).toHaveLength(3);

    const byId = new Map(view.lines.map((l: { lineId: string }) => [l.lineId, l]));
    const expected: Record<string, { written: number; signedShare: number }> = {
      [lineIds[0]!]: { written: 0.7, signedShare: 0.5 },
      [lineIds[1]!]: { written: 0.5, signedShare: 0.3 },
      [lineIds[2]!]: { written: 0.3, signedShare: 0.2 },
    };
    for (const [lineId, exp] of Object.entries(expected)) {
      const line = byId.get(lineId) as { party: string | null; writtenLine: number; signedLine: number; deltaLine: number };
      expect(line).toBeDefined();
      expect(line.party).toBeTruthy();
      expect(line.writtenLine).toBeCloseTo(exp.written, 6);
      expect(line.signedLine).toBeCloseTo(exp.signedShare, 6);
      expect(line.deltaLine).toBeCloseTo(exp.signedShare - exp.written, 6);
    }

    expect(view.totals.writtenTotal).toBeCloseTo(1.5, 6);
    expect(view.totals.signedTotal).toBeCloseTo(1.0, 6);
    expect(view.totals.orderPct).toBeCloseTo(1.0, 6);
    expect(view.totals.oversubscribed).toBe(true); // written 1.5 > order 1.0
    expect(view.totals.fullySigned).toBe(true); // signed ≈ order
  });

  it('rejects a line id that does not belong to the slip and an out-of-range share', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const { slipId, lineIds } = await slipWithLines(app, auth, 'Signing Foreign Line Treaty', 1.0, [0.4]);
    const other = await slipWithLines(app, auth, 'Signing Other Treaty', 1.0, [0.4]);

    // A line from another slip.
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/placement/slips/${slipId}/sign`,
      headers: auth,
      payload: { lines: [{ lineId: other.lineIds[0], signedLine: 0.2 }] },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toMatch(/does not belong/i);

    // signedLine must be in (0, 1]: zero is rejected by the schema.
    const zero = await app.inject({
      method: 'POST',
      url: `/api/placement/slips/${slipId}/sign`,
      headers: auth,
      payload: { lines: [{ lineId: lineIds[0], signedLine: 0 }] },
    });
    expect(zero.statusCode).toBe(400);
  });
});
