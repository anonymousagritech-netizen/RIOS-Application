/**
 * Legal-entity consolidation ENGINE integration test (Legal Entities: moved from
 * a reporting VIEW to a real multi-entity consolidation). Creates a parent (100%)
 * and a subsidiary (80%) legal entity, seeds each with primary-GL postings tagged
 * to it (via the additive journal.entity_id) including a mirrored intercompany
 * receivable/payable, runs a consolidation, and asserts:
 *   - intercompany balances (1100 receivable / 2100 payable) are eliminated and
 *     absent from the consolidated group trial balance;
 *   - the mirrored eliminations net to zero;
 *   - non-intercompany accounts aggregate line-by-line and the group TB ties out;
 *   - the simple minority-interest model applies 20% of the sub's net assets;
 *   - the run + its eliminations are persisted and readable;
 *   - the run is gated behind accounting:post (claims handler gets 403).
 *
 * Requires a migrated + seeded database; skips cleanly when Postgres is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerQuery } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

const SUFFIX = Date.now();
const AS_OF = '2026-12-31';
const POSTED_AT = '2026-06-30';

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

/** Seed one balanced posted journal tagged to an entity, via the owner connection. */
async function seedJournal(
  tenantId: string,
  entityId: string,
  reference: string,
  legs: Array<{ code: string; debitMinor: number; creditMinor: number }>,
  accountIds: Map<string, string>,
): Promise<void> {
  const j = await ownerQuery<{ id: string }>(
    `insert into journal (tenant_id, reference, description, posted_at, currency, status, source, entity_id)
     values ($1,$2,$3,$4::date,'USD','posted','test_seed',$5) returning id`,
    [tenantId, reference, 'consolidation test seed', POSTED_AT, entityId],
  );
  const journalId = j.rows[0]!.id;
  for (const leg of legs) {
    await ownerQuery(
      `insert into ledger_posting (tenant_id, journal_id, gl_account_id, debit_minor, credit_minor, currency)
       values ($1,$2,$3,$4,$5,'USD')`,
      [tenantId, journalId, accountIds.get(leg.code), leg.debitMinor, leg.creditMinor],
    );
  }
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('legal-entity consolidation engine', () => {
  let auth: { authorization: string };
  let tenantId: string;
  let parentId: string;
  let subId: string;

  it('creates a parent and a subsidiary legal entity and lists them', async () => {
    if (!dbUp) return;
    auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const parent = await app.inject({
      method: 'POST', url: '/api/accounting/legal-entities', headers: auth,
      payload: { code: `GRP_${SUFFIX}`, name: 'Group Parent', functionalCurrency: 'USD', ownershipPct: 100 },
    });
    expect(parent.statusCode).toBe(201);
    parentId = parent.json().id as string;

    const sub = await app.inject({
      method: 'POST', url: '/api/accounting/legal-entities', headers: auth,
      payload: { code: `SUB_${SUFFIX}`, name: 'Subsidiary 80pct', functionalCurrency: 'USD', ownershipPct: 80, parentEntityId: parentId },
    });
    expect(sub.statusCode).toBe(201);
    subId = sub.json().id as string;

    const list = await app.inject({ method: 'GET', url: '/api/accounting/legal-entities', headers: auth });
    expect(list.statusCode).toBe(200);
    const found = (list.json().entities as Array<{ id: string; parentCode: string | null }>).find((e) => e.id === subId);
    expect(found).toBeTruthy();
    expect(found!.parentCode).toBe(`GRP_${SUFFIX}`);
  });

  it('seeds intercompany balances, runs consolidation, eliminates them and ties out', async () => {
    if (!dbUp) return;

    tenantId = (await ownerQuery<{ tenant_id: string }>(
      `select tenant_id from legal_entity where id = $1`, [parentId],
    )).rows[0]!.tenant_id;

    // Resolve the seeded GL account ids for this tenant.
    const accts = await ownerQuery<{ code: string; id: string }>(
      `select code::text as code, id from gl_account where tenant_id = $1`, [tenantId],
    );
    const accountIds = new Map(accts.rows.map((r) => [r.code, r.id]));

    // Parent: cash 5,000,000 + intercompany receivable (1100) 1,000,000 = income (4000) 6,000,000.
    await seedJournal(tenantId, parentId, `PJ_${SUFFIX}`, [
      { code: '1000', debitMinor: 5_000_000, creditMinor: 0 },
      { code: '1100', debitMinor: 1_000_000, creditMinor: 0 },
      { code: '4000', debitMinor: 0, creditMinor: 6_000_000 },
    ], accountIds);

    // Subsidiary: cash 3,000,000 + expense (5100) 2,000,000 = intercompany payable (2100) 1,000,000 + income (4000) 4,000,000.
    await seedJournal(tenantId, subId, `SJ_${SUFFIX}`, [
      { code: '1000', debitMinor: 3_000_000, creditMinor: 0 },
      { code: '5100', debitMinor: 2_000_000, creditMinor: 0 },
      { code: '2100', debitMinor: 0, creditMinor: 1_000_000 },
      { code: '4000', debitMinor: 0, creditMinor: 4_000_000 },
    ], accountIds);

    const run = await app.inject({
      method: 'POST', url: '/api/accounting/consolidation/run', headers: auth,
      payload: { asOf: AS_OF, groupEntityId: parentId, intercompanyAccounts: ['1100', '2100'] },
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();

    // Intercompany accounts are eliminated (recorded) and absent from consolidated.
    const consolidatedCodes = (body.consolidated as Array<{ code: string }>).map((a) => a.code);
    expect(consolidatedCodes).not.toContain('1100');
    expect(consolidatedCodes).not.toContain('2100');
    expect((body.eliminations as Array<{ accountCode: string }>).map((e) => e.accountCode).sort()).toEqual(['1100', '2100']);
    // Mirrored receivable/payable net to zero.
    expect(body.eliminationNetMinor).toBe(0);
    expect(body.eliminationsBalanced).toBe(true);

    // Non-intercompany accounts aggregate line-by-line.
    const cash = (body.consolidated as Array<{ code: string; debitMinor: number }>).find((a) => a.code === '1000')!;
    expect(cash.debitMinor).toBe(8_000_000); // 5,000,000 + 3,000,000
    const income = (body.consolidated as Array<{ code: string; creditMinor: number }>).find((a) => a.code === '4000')!;
    expect(income.creditMinor).toBe(10_000_000); // 6,000,000 + 4,000,000

    // The consolidated group trial balance ties out.
    expect(body.totalDebitsMinor).toBe(body.totalCreditsMinor);
    expect(body.balanced).toBe(true);

    // Simple minority interest: 20% of the sub's net assets (3,000,000 cash - 1,000,000 payable = 2,000,000).
    const mi = (body.minorityInterest as Array<{ entityId: string; netAssetsMinor: number; minorityInterestMinor: number }>).find(
      (m) => m.entityId === subId,
    )!;
    expect(mi.netAssetsMinor).toBe(2_000_000);
    expect(mi.minorityInterestMinor).toBe(400_000);
    expect(body.minorityInterestMinor).toBe(400_000);

    // The run + its eliminations are persisted and readable.
    const runId = body.runId as string;
    const runs = await app.inject({ method: 'GET', url: '/api/accounting/consolidation/runs', headers: auth });
    expect(runs.statusCode).toBe(200);
    expect((runs.json().runs as Array<{ id: string; eliminationCount: number }>).find((r) => r.id === runId)!.eliminationCount).toBe(2);

    const detail = await app.inject({ method: 'GET', url: `/api/accounting/consolidation/runs/${runId}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.id).toBe(runId);
    expect((detail.json().eliminations as unknown[]).length).toBe(2);
  });

  it('validates the run payload and gates it behind accounting:post', async () => {
    if (!dbUp) return;
    // Bad payload (missing groupEntityId) => 400.
    const bad = await app.inject({
      method: 'POST', url: '/api/accounting/consolidation/run', headers: auth, payload: { asOf: AS_OF },
    });
    expect(bad.statusCode).toBe(400);

    // Unknown group entity => 404.
    const missing = await app.inject({
      method: 'POST', url: '/api/accounting/consolidation/run', headers: auth,
      payload: { groupEntityId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(missing.statusCode).toBe(404);

    // Claims handler lacks accounting:post => 403 on both the entity create and the run.
    const claims = { authorization: `Bearer ${await token(app, 'claims@demo.rios')}` };
    const deniedCreate = await app.inject({
      method: 'POST', url: '/api/accounting/legal-entities', headers: claims,
      payload: { code: `NOPE_${SUFFIX}`, name: 'Nope' },
    });
    expect(deniedCreate.statusCode).toBe(403);
    const deniedRun = await app.inject({
      method: 'POST', url: '/api/accounting/consolidation/run', headers: claims,
      payload: { groupEntityId: parentId },
    });
    expect(deniedRun.statusCode).toBe(403);
  });
});
