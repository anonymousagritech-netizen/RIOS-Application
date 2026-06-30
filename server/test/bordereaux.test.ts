/**
 * Bordereaux ingestion tests (brief §7.10, §29.6).
 *
 * Proves the acceptance contract: a malformed premium bordereau is rejected with
 * line-level errors and cannot be processed; a fully-valid one validates, then
 * processes into reconciling Financial Events on the contract.
 *
 * Skips cleanly if Postgres is unreachable so it never produces a false failure.
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

async function createContract(app: FastifyInstance, auth: Record<string, string>): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/treaties',
    headers: auth,
    payload: { name: 'Bordereaux Test Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD' },
  });
  return created.json().id as string;
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

describe('bordereaux: mapped, validated ingestion → financial events', () => {
  it('rejects a malformed premium bordereau with line-level errors and refuses to process it', async () => {
    if (!dbUp) return; // environment without Postgres
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const contractId = await createContract(app, auth);

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/bordereaux',
      headers: auth,
      payload: {
        contractId,
        kind: 'PREMIUM',
        currency: 'USD',
        rows: [
          { policy: 'P-1', premium: 1000 }, // good
          { policy: 'P-2' }, // bad: amount missing
        ],
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const body = uploaded.json();
    expect(body.rowCount).toBe(2);
    expect(body.errorCount).toBe(1);
    expect(body.status).toBe('REJECTED');

    // The bad line carries a human-readable error.
    const detail = await app.inject({ method: 'GET', url: `/api/bordereaux/${body.id}`, headers: auth });
    const lines = detail.json().lines as Array<{ isValid: boolean; errors: string[] }>;
    const bad = lines.find((l) => !l.isValid)!;
    expect(bad.errors).toContain('amount missing or not positive');

    // A malformed bordereau cannot be processed.
    const processed = await app.inject({ method: 'POST', url: `/api/bordereaux/${body.id}/process`, headers: auth });
    expect(processed.statusCode).toBe(409);
    expect(processed.json().error).toContain('1 line-level errors');
  });

  it('validates a clean premium bordereau, then processes it into financial events', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };
    const contractId = await createContract(app, auth);

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/bordereaux',
      headers: auth,
      payload: {
        contractId,
        kind: 'PREMIUM',
        currency: 'USD',
        rows: [
          { policy: 'P-1', premium: 1000 },
          { policy: 'P-2', premium: 2500 },
        ],
      },
    });
    const body = uploaded.json();
    expect(body.status).toBe('VALIDATED');
    expect(body.errorCount).toBe(0);
    expect(body.totalMinor).toBe(350_000); // ($1,000 + $2,500) in minor units

    const processed = await app.inject({ method: 'POST', url: `/api/bordereaux/${body.id}/process`, headers: auth });
    expect(processed.statusCode).toBe(200);
    expect(processed.json().status).toBe('PROCESSED');
    expect(processed.json().financialEvents).toBe(2);

    // The events reconcile on the contract's financial-event ledger.
    const events = await app.inject({ method: 'GET', url: `/api/treaties/${contractId}/financial-events`, headers: auth });
    const list = events.json().events as Array<{ eventType: string; amountMinor: number }>;
    const instalments = list.filter((e) => e.eventType === 'INSTALMENT_PREMIUM');
    expect(instalments.length).toBe(2);
    const total = instalments.reduce((acc, e) => acc + e.amountMinor, 0);
    expect(total).toBe(350_000);
  });
});
