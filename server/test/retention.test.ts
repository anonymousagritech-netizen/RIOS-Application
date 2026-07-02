/**
 * Data retention & right-to-erasure integration test (brief §14, §16.2).
 *
 * Covers the delivered retention surface:
 *   - retention schedules (create + list),
 *   - the legacy disposition evaluation (a legal hold overriding an aged-out
 *     record) and the permission gate (kept green),
 *   - the maker/checker right-to-erasure workflow on a real party:
 *       request -> execute BLOCKED_BY_HOLD (409) while an ACTIVE hold covers it
 *       -> release the hold -> self-approve 403 -> cross-user approve
 *       -> execute anonymises the party's PII while its id + audit survive,
 *   - the due-candidate scan returning candidates (never auto-deleting).
 *
 * Requires a migrated (through 0072) + seeded database. Skips cleanly if no
 * Postgres is reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerQuery } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;
let tenantId = '';
let secondUserId = '';
const SECOND_EMAIL = `retention.checker.${Date.now()}@demo.rios`;

async function loginToken(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234', tenantCode: 'demo' } });
  return res.json().token as string;
}

beforeAll(async () => {
  try { await appPool.query('select 1'); } catch { dbUp = false; return; }
  app = await buildApp();
  // Resolve the demo tenant and mint a SECOND admin-permissioned user (distinct
  // id, same 'demo1234' hash as admin) so we can prove cross-user approval.
  const t = await ownerQuery<{ id: string }>(`select id from tenant where code = 'demo'`);
  tenantId = t.rows[0]!.id;
  const u = await ownerQuery<{ id: string }>(
    `insert into app_user (tenant_id, email, display_name, password_hash, status)
     select tenant_id, $2, 'Retention Checker', password_hash, 'active'
       from app_user where email = 'admin@demo.rios' and tenant_id = $1
     returning id`,
    [tenantId, SECOND_EMAIL],
  );
  secondUserId = u.rows[0]!.id;
  await ownerQuery(
    `insert into user_role (tenant_id, user_id, role_id)
     select $1, $2, r.id from role r where r.tenant_id = $1 and r.code = 'ADMIN'`,
    [tenantId, secondUserId],
  );
});

afterAll(async () => {
  if (dbUp && secondUserId) {
    await ownerQuery(`delete from app_user where id = $1`, [secondUserId]);
  }
  if (app) await app.close();
  await closePools();
});

/** Create a party via the API and give it a contact (PII we can later erase). */
async function makeParty(auth: Record<string, string>, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/parties', headers: auth,
    payload: { legalName: name, shortName: 'PII Co', kind: 'organisation', roles: ['cedent'], identifiers: { LEI: 'ABC123' } },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  await ownerQuery(
    `insert into party_contact (tenant_id, party_id, kind, value, is_primary)
     values ($1, $2, 'email', 'privacy@example.com', true)`,
    [tenantId, id],
  );
  return id;
}

describe('Retention schedules', () => {
  it('creates and lists a schedule', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const created = await app.inject({
      method: 'POST', url: '/api/retention/schedules', headers: auth,
      payload: { entity: 'party', retentionMonths: 0, basis: 'CREATED', action: 'ANONYMISE' },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/retention/schedules', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().schedules.some((s: { entity: string }) => s.entity === 'party')).toBe(true);
  });
});

describe('Disposition evaluation (legacy surface stays green)', () => {
  it('keeps an aged-out claim because a legal hold covers claims', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/retention/evaluate', headers: auth,
      payload: { entityType: 'claim', recordedAt: '2000-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict.onHold).toBe(true);
    expect(res.json().verdict.eligible).toBe(false);
  });

  it('forbids authoring without retention:write', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('claims@demo.rios')}` };
    const res = await app.inject({
      method: 'POST', url: '/api/retention/schedules', headers: auth,
      payload: { entity: 'x', retentionMonths: 1, action: 'ARCHIVE' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Right-to-erasure (maker/checker, hold-aware)', () => {
  it('blocks erasure under an ACTIVE legal hold, then erases after release with cross-user approval', async () => {
    if (!dbUp) return;
    const admin = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    const checker = { authorization: `Bearer ${await loginToken(SECOND_EMAIL)}` };

    const partyId = await makeParty(admin, 'Sensitive Cedent Plc');

    // Place a legal hold on this exact party.
    const hold = await app.inject({
      method: 'POST', url: '/api/retention/legal-holds', headers: admin,
      payload: { name: 'Litigation hold', entity: 'party', entityId: partyId, reason: 'Pending dispute' },
    });
    expect(hold.statusCode).toBe(201);
    const holdId = hold.json().id as string;

    // Request erasure (maker = admin).
    const req1 = await app.inject({
      method: 'POST', url: '/api/retention/erasure', headers: admin,
      payload: { subjectEntity: 'party', subjectId: partyId, reason: 'GDPR erasure request' },
    });
    expect(req1.statusCode).toBe(201);
    const erasureId = req1.json().id as string;

    // Approve with the second user (checker != maker).
    const approve1 = await app.inject({ method: 'POST', url: `/api/retention/erasure/${erasureId}/approve`, headers: checker });
    expect(approve1.statusCode).toBe(200);

    // Execute is BLOCKED_BY_HOLD (409) while the hold is active.
    const blocked = await app.inject({ method: 'POST', url: `/api/retention/erasure/${erasureId}/execute`, headers: admin });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('BLOCKED_BY_HOLD');
    expect(blocked.json().status).toBe('BLOCKED_BY_HOLD');

    // Party PII is still intact while blocked.
    const beforeErase = await ownerQuery<{ legal_name: string }>(`select legal_name from party where id = $1`, [partyId]);
    expect(beforeErase.rows[0]!.legal_name).toBe('Sensitive Cedent Plc');

    // Release the hold.
    const release = await app.inject({ method: 'POST', url: `/api/retention/legal-holds/${holdId}/release`, headers: admin });
    expect(release.statusCode).toBe(200);
    expect(release.json().status).toBe('RELEASED');

    // A fresh request (the previous one is now BLOCKED_BY_HOLD, a terminal-ish
    // state) to exercise the full maker/checker path again.
    const req2 = await app.inject({
      method: 'POST', url: '/api/retention/erasure', headers: admin,
      payload: { subjectEntity: 'party', subjectId: partyId, reason: 'GDPR erasure request (retry)' },
    });
    const erasureId2 = req2.json().id as string;

    // Self-approval by the maker is forbidden (segregation of duties).
    const selfApprove = await app.inject({ method: 'POST', url: `/api/retention/erasure/${erasureId2}/approve`, headers: admin });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error).toContain('Segregation of duties');

    // Cross-user approve, then execute.
    const approve2 = await app.inject({ method: 'POST', url: `/api/retention/erasure/${erasureId2}/approve`, headers: checker });
    expect(approve2.statusCode).toBe(200);
    const exec = await app.inject({ method: 'POST', url: `/api/retention/erasure/${erasureId2}/execute`, headers: admin });
    expect(exec.statusCode).toBe(200);
    expect(exec.json().status).toBe('EXECUTED');

    // PII anonymised; id + row survive; contacts removed.
    const after = await ownerQuery<{ id: string; legal_name: string; short_name: string; identifiers: unknown }>(
      `select id, legal_name, short_name, identifiers from party where id = $1`, [partyId],
    );
    expect(after.rows[0]!.id).toBe(partyId);
    expect(after.rows[0]!.legal_name).toBe('[erased]');
    expect(after.rows[0]!.short_name).toBe('[erased]');
    expect(after.rows[0]!.identifiers).toEqual({});
    const contacts = await ownerQuery(`select 1 from party_contact where party_id = $1`, [partyId]);
    expect(contacts.rowCount).toBe(0);

    // The audit trail for the erasure survives and links to the subject id.
    const audit = await ownerQuery<{ entity_id: string }>(
      `select entity_id from audit_log where tenant_id = $1 and entity_type = 'erasure_request' and action = 'execute' and entity_id = $2`,
      [tenantId, erasureId2],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe('Due candidates', () => {
  it('lists records past their retention schedule as candidates (no auto-delete)', async () => {
    if (!dbUp) return;
    const auth = { authorization: `Bearer ${await loginToken('admin@demo.rios')}` };
    // Ensure a zero-month party schedule exists (created above), then scan as of
    // tomorrow so every existing party is a candidate.
    const partyId = await makeParty(auth, 'Due Candidate Ltd');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await app.inject({ method: 'GET', url: `/api/retention/due?asOf=${tomorrow}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.some((c: { id: string; entity: string }) => c.id === partyId && c.entity === 'party')).toBe(true);
    expect(body.note).toContain('never auto-deletes');
  });
});
