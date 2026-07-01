/**
 * Negative multi-tenant isolation test (brief §5 / ADR 0002 - RLS).
 *
 * Creates a SECOND live tenant (owner connection, same shapes as
 * db/seed/seed.sql) with its own admin, then proves Postgres RLS actually
 * separates the tenants through the real API surface:
 *   - tenant B sees none of tenant A's seeded treaties or parties,
 *   - tenant B cannot fetch a tenant-A treaty by id (404),
 *   - a treaty created by tenant B is invisible to tenant A (list + by-id).
 * Skips cleanly when Postgres is unreachable. Setup is idempotent
 * (on conflict do nothing) so reruns against the same database pass.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, ownerQuery, closePools } from '../src/db.js';

const TENANT_A_ID = '11111111-1111-1111-1111-111111111111'; // seeded 'demo'
const TENANT_B_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_B_CODE = 'isotestb';
const TENANT_B_ADMIN = 'admin@isotestb.rios';

let app: FastifyInstance;
let dbUp = true;

async function login(email: string, tenantCode: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'demo1234', tenantCode },
  });
  expect(res.statusCode).toBe(200);
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

  // Provision tenant B on the owner connection (RLS-bypassing, like the seed).
  await ownerQuery(
    `insert into tenant (id, code, name, default_currency, default_locale)
     values ($1, $2, 'Isolation Test Reinsurance B', 'USD', 'en-US')
     on conflict do nothing`,
    [TENANT_B_ID, TENANT_B_CODE],
  );
  await ownerQuery(
    `insert into app_user (tenant_id, email, display_name, password_hash)
     values ($1, $2, 'Tenant B Administrator', crypt('demo1234', gen_salt('bf')))
     on conflict (tenant_id, email) do nothing`,
    [TENANT_B_ID, TENANT_B_ADMIN],
  );
  await ownerQuery(
    `insert into role (tenant_id, code, name, is_system)
     values ($1, 'ADMIN', 'Administrator', true)
     on conflict (tenant_id, code) do nothing`,
    [TENANT_B_ID],
  );
  await ownerQuery(
    `insert into role_permission (tenant_id, role_id, permission)
     select $1, r.id, 'admin:manage' from role r
      where r.tenant_id = $1 and r.code = 'ADMIN'
     on conflict do nothing`,
    [TENANT_B_ID],
  );
  await ownerQuery(
    `insert into user_role (tenant_id, user_id, role_id)
     select $1, u.id, r.id
       from app_user u
       join role r on r.tenant_id = u.tenant_id and r.code = 'ADMIN'
      where u.tenant_id = $1 and u.email = $2
     on conflict do nothing`,
    [TENANT_B_ID, TENANT_B_ADMIN],
  );
});

afterAll(async () => {
  if (app) await app.close();
  await closePools();
});

describe('multi-tenant isolation (negative, second live tenant)', () => {
  it('hides all of tenant A data from tenant B (lists and by-id)', async () => {
    if (!dbUp) return;

    // Ground truth from the owner connection: everything tenant A owns.
    const aContracts = await ownerQuery<{ id: string }>(
      `select id from contract where tenant_id = $1`, [TENANT_A_ID],
    );
    const aParties = await ownerQuery<{ id: string }>(
      `select id from party where tenant_id = $1`, [TENANT_A_ID],
    );
    const aContractIds = new Set(aContracts.rows.map((r) => r.id));
    const aPartyIds = new Set(aParties.rows.map((r) => r.id));
    expect(aContractIds.size).toBeGreaterThan(0); // seed guarantees a BOUND treaty
    expect(aPartyIds.size).toBeGreaterThan(0);

    const bToken = await login(TENANT_B_ADMIN, TENANT_B_CODE);
    const bAuth = { authorization: `Bearer ${bToken}` };

    // Treaty list: not a single tenant-A row may leak.
    const treaties = await app.inject({ method: 'GET', url: '/api/treaties', headers: bAuth });
    expect(treaties.statusCode).toBe(200);
    const bTreaties = treaties.json().treaties as Array<{ id: string }>;
    for (const t of bTreaties) expect(aContractIds.has(t.id)).toBe(false);

    // Party list: same - zero rows or only tenant-B rows.
    const parties = await app.inject({ method: 'GET', url: '/api/parties', headers: bAuth });
    expect(parties.statusCode).toBe(200);
    const bParties = parties.json().parties as Array<{ id: string }>;
    for (const p of bParties) expect(aPartyIds.has(p.id)).toBe(false);

    // Direct fetch of a tenant-A treaty by id must 404 (RLS returns no row).
    const aTreatyId = aContracts.rows[0]!.id;
    const byId = await app.inject({ method: 'GET', url: `/api/treaties/${aTreatyId}`, headers: bAuth });
    expect(byId.statusCode).toBe(404);
  });

  it('keeps a treaty created by tenant B invisible to tenant A', async () => {
    if (!dbUp) return;

    const bToken = await login(TENANT_B_ADMIN, TENANT_B_CODE);
    const bAuth = { authorization: `Bearer ${bToken}` };

    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: bAuth,
      payload: { name: 'Tenant B Secret CAT XL', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD' },
    });
    expect(created.statusCode).toBe(201);
    const bTreatyId = created.json().id as string;

    // Tenant B itself can read it back.
    const own = await app.inject({ method: 'GET', url: `/api/treaties/${bTreatyId}`, headers: bAuth });
    expect(own.statusCode).toBe(200);

    // The row really belongs to tenant B (owner-connection ground truth).
    const row = await ownerQuery<{ tenant_id: string }>(
      `select tenant_id from contract where id = $1`, [bTreatyId],
    );
    expect(row.rows[0]?.tenant_id).toBe(TENANT_B_ID);

    // Tenant A's admin cannot see it: not in the list, 404 by id.
    const aToken = await login('admin@demo.rios', 'demo');
    const aAuth = { authorization: `Bearer ${aToken}` };

    const aList = await app.inject({ method: 'GET', url: '/api/treaties', headers: aAuth });
    expect(aList.statusCode).toBe(200);
    const aVisible = aList.json().treaties as Array<{ id: string }>;
    expect(aVisible.some((t) => t.id === bTreatyId)).toBe(false);

    const aById = await app.inject({ method: 'GET', url: `/api/treaties/${bTreatyId}`, headers: aAuth });
    expect(aById.statusCode).toBe(404);
  });
});
