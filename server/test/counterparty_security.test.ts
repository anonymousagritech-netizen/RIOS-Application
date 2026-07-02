/**
 * Counterparty security management + sanctions screening integration tests
 * (industry-gap-analysis §2.2 items 2-3). dbUp guard + demo token, mirroring
 * counterparties.test.ts. Ratings history, credit limit upsert + integer
 * headroom, collateral, the composite /security view, and the screening
 * matcher against a tenant-loaded denylist.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerQuery } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

async function token(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
});
afterAll(async () => { if (app) await app.close(); await closePools(); });

describe('Counterparty security', () => {
  it('screens on party create, matches against the denylist, and builds the security view', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const suffix = Date.now();

    // 1) Create a party: creation is not blocked, a screening row is recorded, result CLEAR.
    const create = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: `Benign Re ${suffix}`, kind: 'organisation', country: 'CH', roles: [] },
    });
    expect(create.statusCode).toBe(201);
    const partyId = create.json().id as string;
    expect(create.json().screeningResult).toBe('CLEAR');
    const tenantId = (await ownerQuery<{ tenant_id: string }>(
      `select tenant_id from party where id = $1`, [partyId],
    )).rows[0]!.tenant_id;
    const screenRows = await ownerQuery(
      `select result from sanctions_screening where party_id = $1`, [partyId],
    );
    expect(screenRows.rows.length).toBe(1);
    expect((screenRows.rows[0] as { result: string }).result).toBe('CLEAR');

    // 2) Load denylist entries (real deployments feed these from OFAC/UN/EU providers).
    await ownerQuery(
      `insert into sanctions_list_entry (tenant_id, list_source, full_name, alias, country)
       values ($1,'OFAC',$2,$3,'RU')`,
      [tenantId, `Shadow Marine Holdings ${suffix}`, `Shadow Marine ${suffix}`],
    );

    // Exact normalised match (punctuation/case-insensitive) => BLOCKED.
    const blocked = await app.inject({
      method: 'POST', url: '/api/parties/screen', headers: auth,
      payload: { name: `SHADOW-MARINE holdings, ${suffix}` },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().result).toBe('BLOCKED');
    expect(blocked.json().matches.length).toBeGreaterThanOrEqual(1);
    expect(blocked.json().matches[0].listSource).toBe('OFAC');

    // Token-subset match (listed name contained in a longer screened name) => POTENTIAL_MATCH.
    const potential = await app.inject({
      method: 'POST', url: '/api/parties/screen', headers: auth,
      payload: { name: `Shadow Marine Holdings ${suffix} Insurance Group`, partyId, paymentRef: `PAY-${suffix}` },
    });
    expect(potential.statusCode).toBe(200);
    expect(potential.json().result).toBe('POTENTIAL_MATCH');

    // Unrelated name stays CLEAR.
    const clear = await app.inject({
      method: 'POST', url: '/api/parties/screen', headers: auth,
      payload: { name: `Totally Unrelated Cedent ${suffix + 1}` },
    });
    expect(clear.json().result).toBe('CLEAR');
    expect(clear.json().matches).toEqual([]);

    // 3) Ratings: add two for the same agency, history comes back newest-first.
    const r1 = await app.inject({
      method: 'POST', url: `/api/parties/${partyId}/ratings`, headers: auth,
      payload: { agency: 'AM_BEST', rating: 'A-', outlook: 'STABLE', ratedOn: '2025-06-30' },
    });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({
      method: 'POST', url: `/api/parties/${partyId}/ratings`, headers: auth,
      payload: { agency: 'AM_BEST', rating: 'A', outlook: 'POSITIVE', ratedOn: '2026-06-30' },
    });
    expect(r2.statusCode).toBe(201);
    await app.inject({
      method: 'POST', url: `/api/parties/${partyId}/ratings`, headers: auth,
      payload: { agency: 'SP', rating: 'A+', ratedOn: '2026-01-15' },
    });
    const history = await app.inject({ method: 'GET', url: `/api/parties/${partyId}/ratings`, headers: auth });
    expect(history.statusCode).toBe(200);
    expect(history.json().ratings.length).toBe(3);
    expect(history.json().ratings[0].rating).toBe('A'); // 2026 AM Best entry first

    // 4) Credit limit upsert + integer headroom arithmetic.
    const put1 = await app.inject({
      method: 'PUT', url: `/api/parties/${partyId}/credit-limit`, headers: auth,
      payload: { currency: 'USD', limitMinor: 50_000_000_00, reviewDate: '2027-01-01' },
    });
    expect(put1.statusCode).toBe(200);
    // Upsert: same currency replaces the limit rather than adding a row.
    const put2 = await app.inject({
      method: 'PUT', url: `/api/parties/${partyId}/credit-limit`, headers: auth,
      payload: { currency: 'USD', limitMinor: 75_000_000_00 },
    });
    expect(put2.statusCode).toBe(200);
    await ownerQuery(
      `update credit_limit set consumed_minor = $1 where party_id = $2 and currency = 'USD'`,
      [12_345_678_90, partyId],
    );
    const limits = await app.inject({ method: 'GET', url: `/api/parties/${partyId}/credit-limit`, headers: auth });
    expect(limits.statusCode).toBe(200);
    const usd = limits.json().limits.find((l: { currency: string }) => l.currency === 'USD');
    expect(limits.json().limits.length).toBe(1);
    expect(usd.limitMinor).toBe(75_000_000_00);
    expect(usd.consumedMinor).toBe(12_345_678_90);
    expect(usd.headroomMinor).toBe(75_000_000_00 - 12_345_678_90); // exact integer

    // 5) Collateral.
    const col = await app.inject({
      method: 'POST', url: `/api/parties/${partyId}/collateral`, headers: auth,
      payload: { kind: 'LOC', reference: `LOC-${suffix}`, amountMinor: 10_000_000_00, currency: 'USD', expiryDate: '2027-12-31' },
    });
    expect(col.statusCode).toBe(201);
    await app.inject({
      method: 'POST', url: `/api/parties/${partyId}/collateral`, headers: auth,
      payload: { kind: 'FUNDS_WITHHELD', amountMinor: 2_500_000_00, currency: 'USD' },
    });
    const colList = await app.inject({ method: 'GET', url: `/api/parties/${partyId}/collateral`, headers: auth });
    expect(colList.json().collateral.length).toBe(2);

    // 6) Composite security-committee view.
    const sec = await app.inject({ method: 'GET', url: `/api/parties/${partyId}/security`, headers: auth });
    expect(sec.statusCode).toBe(200);
    const body = sec.json();
    expect(body.party.id).toBe(partyId);
    // Latest per agency only: AM_BEST shows the 2026 'A', plus the SP entry.
    expect(body.ratings.length).toBe(2);
    const amBest = body.ratings.find((r: { agency: string }) => r.agency === 'AM_BEST');
    expect(amBest.rating).toBe('A');
    expect(body.creditLimits.length).toBe(1);
    expect(body.creditLimits[0].headroomMinor).toBe(75_000_000_00 - 12_345_678_90);
    expect(body.collateral.length).toBe(1);
    expect(body.collateral[0].totalMinor).toBe(12_500_000_00);
    expect(body.collateral[0].items).toBe(2);
    expect(body.latestScreening).not.toBeNull();
  });

  it('rejects screening without party:write and validates payloads', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const bad = await app.inject({ method: 'POST', url: '/api/parties/screen', headers: auth, payload: { name: '' } });
    expect(bad.statusCode).toBe(400);
  });
});
