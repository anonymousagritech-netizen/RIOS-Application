/**
 * Approval delegation (brief §3). The seeded accountant→underwriter delegation
 * lets the underwriter act for the accountant on accounting:post but not other
 * permissions; self-delegation is rejected. Skips cleanly without a DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;
let acctId = '';

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
  const r = await ownerQuery<{ id: string }>(`select id from app_user where email = 'acct@demo.rios'`);
  acctId = r.rows[0]!.id;
});
afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('Approval delegation', () => {
  it('lets the underwriter act for the accountant only within the delegated scope', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('uw@demo.rios')}` };

    const acting = await app.inject({ method: 'GET', url: '/api/delegations/acting-for', headers: auth });
    expect(acting.statusCode).toBe(200);
    expect(acting.json().actingFor.some((a: { displayName: string }) => /Counts/.test(a.displayName))).toBe(true);

    const scoped = await app.inject({ method: 'GET', url: `/api/delegations/can-act?delegatorUserId=${acctId}&permission=accounting:post`, headers: auth });
    expect(scoped.json().canAct).toBe(true);

    const other = await app.inject({ method: 'GET', url: `/api/delegations/can-act?delegatorUserId=${acctId}&permission=treaty:bind`, headers: auth });
    expect(other.json().canAct).toBe(false);
  });

  it('rejects self-delegation', async () => {
    if (!dbUp) return;
    const adminTkn = await loginToken('admin@demo.rios');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${adminTkn}` } });
    const myId = me.json().user.id;
    const res = await app.inject({
      method: 'POST', url: '/api/delegations', headers: { authorization: `Bearer ${adminTkn}` },
      payload: { delegateUserId: myId },
    });
    expect(res.statusCode).toBe(400);
  });
});
