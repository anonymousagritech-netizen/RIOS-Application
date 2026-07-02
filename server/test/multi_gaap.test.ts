/**
 * Multi-GAAP parallel ledgers integration test (Tier-3 gap #11):
 *   create an IFRS17 parallel ledger → post a balanced basis-adjustment journal
 *   to it → the ledger's trial balance shows primary-GL balances PLUS the
 *   adjustment while the primary trial balance is provably unchanged →
 *   unbalanced adjustment 400 → duplicate ledger code 409 → second primary
 *   ledger 409 → permission gate 403 → consolidation view nets flagged
 *   intercompany accounts out as eliminations.
 *
 * Requires a migrated + seeded database; skips cleanly when Postgres is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

// Unique per run so re-runs against a shared DB never collide.
const CODE = `IFRS17_${Date.now()}`;
const ADJ_MINOR = 2_500_000; // $25,000 basis adjustment

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'demo1234', tenantCode: 'demo' },
  });
  return res.json().token as string;
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

describe('multi-GAAP parallel ledgers', () => {
  let auth: { authorization: string };
  let ledgerId: string;

  it('creates an IFRS17 parallel ledger and lists it', async () => {
    if (!dbUp) return; // environment without Postgres
    auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/accounting/ledgers',
      headers: auth,
      payload: { code: CODE, name: 'IFRS 17 parallel ledger', basis: 'IFRS17' },
    });
    expect(created.statusCode).toBe(201);
    ledgerId = created.json().id as string;
    expect(created.json().isPrimary).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/api/accounting/ledgers', headers: auth });
    expect(list.statusCode).toBe(200);
    const found = (list.json().ledgers as Array<{ id: string; code: string; basis: string }>).find((l) => l.id === ledgerId);
    expect(found).toBeTruthy();
    expect(found!.code).toBe(CODE);
    expect(found!.basis).toBe('IFRS17');
  });

  it('rejects a duplicate ledger code with 409', async () => {
    if (!dbUp) return;
    const dup = await app.inject({
      method: 'POST',
      url: '/api/accounting/ledgers',
      headers: auth,
      payload: { code: CODE, name: 'Duplicate', basis: 'IFRS17' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('allows at most one primary ledger (second is 409)', async () => {
    if (!dbUp) return;
    // On a shared DB a primary may already exist from an earlier run, in which
    // case the first attempt already 409s; the second attempt must always 409.
    await app.inject({
      method: 'POST',
      url: '/api/accounting/ledgers',
      headers: auth,
      payload: { code: `PRIMARY_A_${Date.now()}`, name: 'Primary A', basis: 'LOCAL_GAAP', isPrimary: true },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/accounting/ledgers',
      headers: auth,
      payload: { code: `PRIMARY_B_${Date.now()}`, name: 'Primary B', basis: 'LOCAL_GAAP', isPrimary: true },
    });
    expect(second.statusCode).toBe(409);
  });

  it('posts a balanced basis adjustment; trial balance = primary + adjustment; primary GL unchanged', async () => {
    if (!dbUp) return;

    // Fresh ledger: its adjustment layer starts empty.
    const before = await app.inject({ method: 'GET', url: `/api/accounting/ledgers/${ledgerId}/trial-balance`, headers: auth });
    expect(before.statusCode).toBe(200);
    const before1100 = (before.json().accounts as Array<{ code: string; adjustmentDebitMinor: number }>).find((a) => a.code === '1100')!;
    expect(before1100.adjustmentDebitMinor).toBe(0);

    const primaryBefore = await app.inject({ method: 'GET', url: '/api/finance/trial-balance', headers: auth });
    expect(primaryBefore.statusCode).toBe(200);

    // IFRS17-style reclass: DR Reinsurance Debtors 25,000 / CR Ceded Premium 25,000.
    const posted = await app.inject({
      method: 'POST',
      url: `/api/accounting/ledgers/${ledgerId}/basis-adjustments`,
      headers: auth,
      payload: {
        description: 'IFRS17 LRC reclass',
        lines: [
          { accountCode: '1100', debitMinor: ADJ_MINOR, currency: 'USD', narrative: 'LRC reclass' },
          { accountCode: '4000', creditMinor: ADJ_MINOR, currency: 'USD', narrative: 'LRC reclass' },
        ],
      },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().ledgerCode).toBe(CODE);
    expect(posted.json().reference).toBeTruthy();

    // Parallel trial balance: primary balances plus this ledger's adjustment.
    const after = await app.inject({ method: 'GET', url: `/api/accounting/ledgers/${ledgerId}/trial-balance`, headers: auth });
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.ledger.code).toBe(CODE);
    const a1100 = (body.accounts as Array<{ code: string; adjustmentDebitMinor: number; primaryDebitMinor: number; debitMinor: number }>).find(
      (a) => a.code === '1100',
    )!;
    const a4000 = (body.accounts as Array<{ code: string; adjustmentCreditMinor: number; primaryCreditMinor: number; creditMinor: number }>).find(
      (a) => a.code === '4000',
    )!;
    expect(a1100.adjustmentDebitMinor).toBe(ADJ_MINOR);
    expect(a1100.debitMinor).toBe(a1100.primaryDebitMinor + ADJ_MINOR);
    expect(a4000.creditMinor).toBe(a4000.primaryCreditMinor + a4000.adjustmentCreditMinor);
    expect(a4000.adjustmentCreditMinor).toBe(ADJ_MINOR);
    expect(body.balanced).toBe(true);

    // The single-ledger path is untouched: the primary trial balance is
    // byte-identical to before the adjustment was posted.
    const primaryAfter = await app.inject({ method: 'GET', url: '/api/finance/trial-balance', headers: auth });
    expect(primaryAfter.json()).toEqual(primaryBefore.json());
  });

  it('rejects an unbalanced basis adjustment with 400', async () => {
    if (!dbUp) return;
    const bad = await app.inject({
      method: 'POST',
      url: `/api/accounting/ledgers/${ledgerId}/basis-adjustments`,
      headers: auth,
      payload: {
        lines: [
          { accountCode: '1100', debitMinor: 100, currency: 'USD' },
          { accountCode: '4000', creditMinor: 99, currency: 'USD' },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.json().error)).toMatch(/balance/i);
  });

  it('404s the trial balance of an unknown ledger and 400s a bad asOf', async () => {
    if (!dbUp) return;
    const missing = await app.inject({
      method: 'GET',
      url: '/api/accounting/ledgers/00000000-0000-0000-0000-000000000000/trial-balance',
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);

    const badDate = await app.inject({
      method: 'GET',
      url: `/api/accounting/ledgers/${ledgerId}/trial-balance?asOf=next-tuesday`,
      headers: auth,
    });
    expect(badDate.statusCode).toBe(400);
  });

  it('gates ledger management behind accounting:post (claims handler gets 403)', async () => {
    if (!dbUp) return;
    const claims = { authorization: `Bearer ${await token(app, 'claims@demo.rios')}` };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/accounting/ledgers',
      headers: claims,
      payload: { code: `NOPE_${Date.now()}`, name: 'Nope', basis: 'US_GAAP' },
    });
    expect(denied.statusCode).toBe(403);

    const deniedAdj = await app.inject({
      method: 'POST',
      url: `/api/accounting/ledgers/${ledgerId}/basis-adjustments`,
      headers: claims,
      payload: {
        lines: [
          { accountCode: '1100', debitMinor: 100, currency: 'USD' },
          { accountCode: '4000', creditMinor: 100, currency: 'USD' },
        ],
      },
    });
    expect(deniedAdj.statusCode).toBe(403);
  });

  it('consolidation view nets flagged intercompany accounts out as eliminations', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounting/consolidation?ledgerCode=${CODE}&intercompanyPrefix=11`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ledger.code).toBe(CODE);
    // 1100 (Reinsurance Debtors) is flagged intercompany by the '11' prefix …
    const elim = (body.eliminations as Array<{ code: string; netMinor: number }>).find((e) => e.code === '1100');
    expect(elim).toBeTruthy();
    // … and is therefore absent from the consolidated section.
    const consolidatedCodes = (body.consolidated as Array<{ code: string }>).map((a) => a.code);
    expect(consolidatedCodes).not.toContain('1100');
    expect(consolidatedCodes).toContain('4000');
    // Honest metadata: this is a view, not a legal-entity consolidation engine.
    expect(String(body.note)).toMatch(/not a legal-entity consolidation engine/i);

    // Unknown ledger code → 404.
    const missing = await app.inject({ method: 'GET', url: '/api/accounting/consolidation?ledgerCode=NO_SUCH', headers: auth });
    expect(missing.statusCode).toBe(404);
  });
});
