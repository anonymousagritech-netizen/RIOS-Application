/**
 * Jurisdiction report packs integration test (industry-gap-analysis Tier-3 #12):
 *   list the shipped packs (honest 'template, not certified content' labels) →
 *   build a ceded book (bind inward treaty → claim → cash call → retro
 *   allocation cedes the CASH_LOSS to a rated and an unrated retrocessionaire)
 *   → assemble NAIC Schedule F (security-driven provision: the unrated
 *   counterparty's uncollateralized exposure is provisioned, the secure-rated
 *   one is not) → assemble the Solvency II QRT skeletons (S.02.01 GL tie +
 *   S.31.01 rated/unrated split) → assemble the IRDAI inward/outward summary.
 *   Plus the permission gate (403) and unknown-pack/invalid-body guards.
 *
 * Requires a migrated + seeded database; skips cleanly when Postgres is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools } from '../src/db.js';

let app: FastifyInstance;
let dbUp = true;

const LOB = `jur_packs_${Date.now()}`;
const DEPOSIT_MINOR = 10_000_000; // $100,000 deposit premium on the inward treaty
const CASH_LOSS_MINOR = 4_000_000; // $40,000 cash call on the inward claim
const UNRATED_CEDED_MINOR = 2_000_000; // 50% ceded to the unrated retrocessionaire
const RATED_CEDED_MINOR = 1_000_000; // 25% ceded to the rated retrocessionaire
const COLLATERAL_MINOR = 500_000; // $5,000 LOC held from the unrated party

const today = new Date().toISOString().slice(0, 10);

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

type PackResult = {
  code: string;
  complete: boolean;
  errors: string[];
  values: Record<string, number>;
  overdueProvisionRate?: number;
  detail?: { counterparties?: DetailRow[]; reinsurers?: DetailRow[] };
};
type DetailRow = {
  counterparty: string;
  partyId: string | null;
  authorized: boolean;
  rating: { agency: string; rating: string } | null;
  recoverableMinor: number;
  collateralMinor: number;
  uncollateralizedMinor: number;
  provisionMinor: number;
  netMinor: number;
};

describe('jurisdiction report packs (content over the report-pack assembler)', () => {
  let auth: { authorization: string };
  let unratedPartyId: string;
  let ratedPartyId: string;

  it('lists the three shipped packs with honest template labels', async () => {
    if (!dbUp) return; // environment without Postgres
    auth = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };

    const res = await app.inject({ method: 'GET', url: '/api/regulatory/packs/jurisdictions', headers: auth });
    expect(res.statusCode).toBe(200);
    const packs = res.json().packs as Array<{
      code: string; jurisdiction: string; title: string; description: string; disclaimer: string;
      templates: Array<{ code: string; sections: number; lines: number }>;
    }>;
    expect(packs.map((p) => p.code)).toEqual(['NAIC_SCHEDULE_F', 'SOLVENCY2_QRT', 'IRDAI_REINSURANCE_RETURNS']);
    for (const p of packs) {
      // HONESTY RULE: every pack is labelled template, not certified content.
      expect(p.title).toMatch(/template, not certified content/i);
      expect(p.description).toMatch(/template, not certified content/i);
      expect(p.disclaimer).toMatch(/not for filing/i);
      expect(p.templates.length).toBeGreaterThan(0);
    }
    // The Solvency II pack ships both QRT skeletons.
    const s2 = packs.find((p) => p.code === 'SOLVENCY2_QRT')!;
    expect(s2.templates.map((t) => t.code)).toEqual(['S.02.01', 'S.31.01']);
    expect(s2.jurisdiction).toBe('EU');
  });

  it('gates both endpoints behind the regulatory permissions (403 for portal users)', async () => {
    if (!dbUp) return;
    const portal = { authorization: `Bearer ${await token(app, 'broker@demo.rios')}` };
    const list = await app.inject({ method: 'GET', url: '/api/regulatory/packs/jurisdictions', headers: portal });
    expect(list.statusCode).toBe(403);
    const assemble = await app.inject({
      method: 'POST',
      url: '/api/regulatory/packs/NAIC_SCHEDULE_F/assemble',
      headers: portal,
      payload: { asOf: today },
    });
    expect(assemble.statusCode).toBe(403);
  });

  it('builds a ceded book: inward CASH_LOSS allocated to a rated and an unrated retrocessionaire', async () => {
    if (!dbUp) return;

    // Two retrocessionaire counterparties: one secure-rated, one unrated.
    const unrated = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: `Unrated Retro ${LOB}`, roles: ['reinsurer'] },
    });
    expect(unrated.statusCode).toBe(201);
    unratedPartyId = unrated.json().id as string;

    const rated = await app.inject({
      method: 'POST', url: '/api/parties', headers: auth,
      payload: { legalName: `Rated Retro ${LOB}`, roles: ['reinsurer'] },
    });
    expect(rated.statusCode).toBe(201);
    ratedPartyId = rated.json().id as string;
    const rating = await app.inject({
      method: 'POST', url: `/api/parties/${ratedPartyId}/ratings`, headers: auth,
      payload: { agency: 'SP', rating: 'AA-' },
    });
    expect(rating.statusCode).toBe(201);

    // The unrated party posts partial collateral (an LOC).
    const loc = await app.inject({
      method: 'POST', url: `/api/parties/${unratedPartyId}/collateral`, headers: auth,
      payload: { kind: 'LOC', amountMinor: COLLATERAL_MINOR, currency: 'USD' },
    });
    expect(loc.statusCode).toBe(201);

    // Inward treaty on this run's unique LOB, bound (books the deposit premium).
    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: {
        name: `Jurisdiction Packs Inward ${LOB}`,
        basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD',
        lineOfBusiness: LOB,
        terms: { currency: 'USD', depositPremium: 100000 },
      },
    });
    expect(created.statusCode).toBe(201);
    const inwardId = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${inwardId}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    const bound = await app.inject({ method: 'POST', url: `/api/treaties/${inwardId}/transition`, headers: auth, payload: { to: 'BOUND' } });
    expect(bound.statusCode).toBe(200);

    // Outward retro protections held with each counterparty.
    const mkRetro = async (name: string, partyId: string): Promise<string> => {
      const r = await app.inject({
        method: 'POST', url: '/api/retrocession', headers: auth,
        payload: { name, basis: 'PROPORTIONAL', currency: 'USD', retrocessionairePartyId: partyId },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id as string;
    };
    const unratedRetroId = await mkRetro(`Unrated Retro Protection ${LOB}`, unratedPartyId);
    const ratedRetroId = await mkRetro(`Rated Retro Protection ${LOB}`, ratedPartyId);

    // Claim cession rules scoped to this run's LOB: 50% unrated, 25% rated.
    for (const [retroId, pct] of [[unratedRetroId, 50], [ratedRetroId, 25]] as Array<[string, number]>) {
      const rule = await app.inject({
        method: 'POST', url: '/api/retrocession/allocation-rules', headers: auth,
        payload: { retroContractId: retroId, name: `claims ${pct}% ${LOB}`, appliesTo: 'CLAIM', lob: LOB, cessionPct: pct },
      });
      expect(rule.statusCode).toBe(201);
    }

    // Inward claim + cash call books the CASH_LOSS the rules then cede.
    const claim = await app.inject({
      method: 'POST', url: '/api/claims', headers: auth,
      payload: { contractId: inwardId, currency: 'USD', grossLoss: 500000, description: 'Jurisdiction packs claim' },
    });
    expect(claim.statusCode).toBe(201);
    const call = await app.inject({
      method: 'POST', url: `/api/claims/${claim.json().id as string}/cash-call`, headers: auth,
      payload: { amount: 40000 },
    });
    expect(call.statusCode).toBe(200);
    expect(call.json().amountMinor).toBe(CASH_LOSS_MINOR);

    const run = await app.inject({ method: 'POST', url: '/api/retrocession/allocation/run', headers: auth, payload: {} });
    expect(run.statusCode).toBe(200);
    // Tenant-wide idempotent run: under parallel tests a concurrent run may have
    // already inserted these two cessions (reported as skipped), so assert the
    // robust invariant. The Schedule F assembly below verifies the ceded book.
    expect(run.json().allocated + run.json().skipped).toBeGreaterThanOrEqual(2);
  });

  it('assembles NAIC Schedule F with the security-driven provision for reinsurance', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/NAIC_SCHEDULE_F/assemble', headers: auth,
      payload: { asOf: today },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { disclaimer: string; asOf: string; packs: PackResult[] };
    expect(body.disclaimer).toMatch(/template, not certified content/i);
    expect(body.asOf).toBe(today);

    const pack = body.packs[0]!;
    expect(pack.code).toBe('SCHEDULE_F');
    expect(pack.errors).toEqual([]);
    expect(pack.complete).toBe(true); // includes the total-recoverable control tie

    // Structural identities of the template.
    const v = pack.values;
    expect(v.SF_TOTAL_RECOVERABLE).toBe(v.SF_AUTH_RECOVERABLE! + v.SF_UNAUTH_RECOVERABLE!);
    expect(v.SF_PROVISION_TOTAL).toBe(v.SF_PROVISION_AUTH! + v.SF_PROVISION_UNAUTH!);
    expect(v.SF_NET_RECOVERABLE).toBe(v.SF_TOTAL_RECOVERABLE! - v.SF_PROVISION_TOTAL!);

    // The unrated counterparty: ceded 50% of the CASH_LOSS, partially
    // collateralized, nothing overdue → provision = uncollateralized shortfall.
    const rows = pack.detail!.counterparties!;
    const unrated = rows.find((r) => r.partyId === unratedPartyId)!;
    expect(unrated).toBeDefined();
    expect(unrated.authorized).toBe(false); // unrated ⇒ treated as unauthorized
    expect(unrated.rating).toBeNull();
    expect(unrated.recoverableMinor).toBe(UNRATED_CEDED_MINOR);
    expect(unrated.collateralMinor).toBe(COLLATERAL_MINOR);
    expect(unrated.uncollateralizedMinor).toBe(UNRATED_CEDED_MINOR - COLLATERAL_MINOR);
    expect(unrated.provisionMinor).toBe(UNRATED_CEDED_MINOR - COLLATERAL_MINOR);
    expect(unrated.netMinor).toBe(COLLATERAL_MINOR);

    // The secure-rated counterparty: authorized, nothing overdue → no provision.
    const rated = rows.find((r) => r.partyId === ratedPartyId)!;
    expect(rated).toBeDefined();
    expect(rated.authorized).toBe(true);
    expect(rated.rating).toMatchObject({ agency: 'SP', rating: 'AA-' });
    expect(rated.recoverableMinor).toBe(RATED_CEDED_MINOR);
    expect(rated.provisionMinor).toBe(0);

    // The provision factor is surfaced as an illustrative, configurable rate.
    expect(pack.overdueProvisionRate).toBe(0.2);
    expect(v.SF_UNAUTH_RECOVERABLE).toBeGreaterThanOrEqual(UNRATED_CEDED_MINOR);
    expect(v.SF_AUTH_RECOVERABLE).toBeGreaterThanOrEqual(RATED_CEDED_MINOR);
  });

  it('assembles the Solvency II QRT skeletons: S.02.01 GL tie and S.31.01 rated/unrated split', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/SOLVENCY2_QRT/assemble', headers: auth,
      payload: { asOf: today },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { disclaimer: string; packs: PackResult[] };
    expect(body.disclaimer).toMatch(/template, not certified content/i);
    expect(body.packs.map((p) => p.code)).toEqual(['S.02.01', 'S.31.01']);

    // S.02.01: assets - liabilities ties to equity + retained earnings whenever
    // every posted journal balances (same source as the balance sheet).
    const s02 = body.packs[0]!;
    expect(s02.errors).toEqual([]);
    expect(s02.complete).toBe(true);
    expect(s02.values.S02_EXCESS_ASSETS_OVER_LIABILITIES).toBe(
      s02.values.S02_TOTAL_ASSETS! - s02.values.S02_TOTAL_LIABILITIES!,
    );
    expect(s02.values.S02_EXCESS_ASSETS_OVER_LIABILITIES).toBe(s02.values.S02_EQUITY_CHECK);

    // S.31.01: our rated and unrated shares land in the right buckets.
    const s31 = body.packs[1]!;
    expect(s31.complete).toBe(true);
    expect(s31.values.S31_RECOVERABLE_RATED).toBeGreaterThanOrEqual(RATED_CEDED_MINOR);
    expect(s31.values.S31_RECOVERABLE_UNRATED).toBeGreaterThanOrEqual(UNRATED_CEDED_MINOR);
    expect(s31.values.S31_TOTAL_RECOVERABLE).toBe(
      s31.values.S31_RECOVERABLE_RATED! + s31.values.S31_RECOVERABLE_UNRATED!,
    );
    const reinsurers = s31.detail!.reinsurers!;
    expect(reinsurers.some((r) => r.partyId === ratedPartyId && r.rating?.rating === 'AA-')).toBe(true);
    expect(reinsurers.some((r) => r.partyId === unratedPartyId && r.rating === null)).toBe(true);
  });

  it('assembles the IRDAI inward/outward summary with the net-premium tie', async () => {
    if (!dbUp) return;
    const res = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/IRDAI_REINSURANCE_RETURNS/assemble', headers: auth,
      payload: { asOf: today },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { disclaimer: string; packs: PackResult[] };
    expect(body.disclaimer).toMatch(/template, not certified content/i);

    const pack = body.packs[0]!;
    expect(pack.code).toBe('IRDAI_RI_SUMMARY');
    expect(pack.errors).toEqual([]);
    expect(pack.complete).toBe(true);

    const v = pack.values;
    // Our bound treaty's deposit premium is in the inward aggregate; the ceded
    // CASH_LOSS copies are in the outward recoveries aggregate.
    expect(v.IRDAI_INWARD_PREMIUM).toBeGreaterThanOrEqual(DEPOSIT_MINOR);
    expect(v.IRDAI_INWARD_CLAIMS_PAID).toBeGreaterThanOrEqual(CASH_LOSS_MINOR);
    expect(v.IRDAI_OUTWARD_RECOVERIES).toBeGreaterThanOrEqual(UNRATED_CEDED_MINOR + RATED_CEDED_MINOR);
    expect(v.IRDAI_NET_PREMIUM).toBe(v.IRDAI_INWARD_PREMIUM! - v.IRDAI_OUTWARD_PREMIUM!);
    expect(v.IRDAI_NET_INCURRED).toBe(v.IRDAI_INWARD_CLAIMS_PAID! - v.IRDAI_OUTWARD_RECOVERIES!);
  });

  it('rejects unknown pack codes (404) and malformed asOf (400)', async () => {
    if (!dbUp) return;
    const unknown = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/NOT_A_PACK/assemble', headers: auth, payload: { asOf: today },
    });
    expect(unknown.statusCode).toBe(404);

    const badDate = await app.inject({
      method: 'POST', url: '/api/regulatory/packs/NAIC_SCHEDULE_F/assemble', headers: auth, payload: { asOf: 'yesterday' },
    });
    expect(badDate.statusCode).toBe(400);
  });
});
