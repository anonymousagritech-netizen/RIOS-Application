/**
 * Account-current / dunning / payment-run integration test (industry-gap-analysis
 * Tier-2 item 9):
 *   payment run maker-checker (create → self-approve 403 → release-early 409 →
 *   approve by a second user → release generates pain.001 with the right control
 *   sum), dunning run idempotency, and dispute-pauses-dunning, all reflected in
 *   the account-current view.
 *
 * Requires a migrated (through 0056) + seeded database. Skips cleanly if no
 * Postgres is reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { appPool, closePools, ownerQuery } from '../src/db.js';

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

/** YYYY-MM-DD for today − n days. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
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

describe('payment runs: maker-checker release with pain.001 generation', () => {
  it('enforces DRAFT→APPROVED→RELEASED with segregation of duties and emits valid XML', async () => {
    if (!dbUp) return; // environment without Postgres
    const admin = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const suffix = Date.now();

    const created = await app.inject({
      method: 'POST',
      url: '/api/finance/payment-runs',
      headers: admin,
      payload: {
        currency: 'USD',
        items: [
          {
            creditorName: `Global Broker & Co ${suffix}`,
            creditorIban: 'DE89370400440532013000',
            creditorBic: 'COBADEFF',
            amountMinor: 123456, // 1234.56
            remittance: 'Q2 balance',
          },
          {
            creditorName: 'Cedent Re',
            creditorIban: 'FR1420041010050500013M02606',
            amountMinor: 10, // 0.10 - exercises exact decimal control sum
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('DRAFT');
    expect(created.json().totalMinor).toBe(123_466);
    const runId = created.json().id as string;

    // Governed release: releasing before approval is rejected.
    const early = await app.inject({ method: 'POST', url: `/api/finance/payment-runs/${runId}/release`, headers: admin });
    expect(early.statusCode).toBe(409);

    // Maker/checker: the creator cannot approve their own run.
    const selfApprove = await app.inject({ method: 'POST', url: `/api/finance/payment-runs/${runId}/approve`, headers: admin });
    expect(selfApprove.statusCode).toBe(403);

    // A different user (the technical accountant) approves.
    const acct = { authorization: `Bearer ${await token(app, 'acct@demo.rios')}` };
    const approved = await app.inject({ method: 'POST', url: `/api/finance/payment-runs/${runId}/approve`, headers: acct });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('APPROVED');

    // Double-approve is rejected (no longer DRAFT).
    const again = await app.inject({ method: 'POST', url: `/api/finance/payment-runs/${runId}/approve`, headers: acct });
    expect(again.statusCode).toBe(409);

    // Release generates + stores the pain.001 file.
    const released = await app.inject({
      method: 'POST',
      url: `/api/finance/payment-runs/${runId}/release`,
      headers: admin,
      payload: { debtorName: 'Demo Reinsurance AG', debtorIban: 'CH9300762011623852957', debtorBic: 'DEMOCHZZ' },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().status).toBe('RELEASED');
    const xml = released.json().xml as string;
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.03');
    expect(xml).toContain('<IBAN>DE89370400440532013000</IBAN>');
    expect(xml).toContain('<IBAN>FR1420041010050500013M02606</IBAN>');
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs>');
    // Exact decimal control sum: 1234.56 + 0.10 = 1234.66.
    expect(xml).toContain('<CtrlSum>1234.66</CtrlSum>');
    expect(xml).toContain('<InstdAmt Ccy="USD">1234.56</InstdAmt>');
    // Escaped creditor name (raw & never appears).
    expect(xml).toContain(`Global Broker &amp; Co ${suffix}`);

    // Detail view returns the stored XML + items; list view omits the XML.
    const detail = await app.inject({ method: 'GET', url: `/api/finance/payment-runs/${runId}`, headers: admin });
    expect(detail.json().xml).toBe(xml);
    expect(detail.json().items.length).toBe(2);
    const list = await app.inject({ method: 'GET', url: '/api/finance/payment-runs', headers: admin });
    const listed = (list.json().paymentRuns as Array<Record<string, unknown>>).find((r) => r.id === runId);
    expect(listed).toBeTruthy();
    expect(listed!.status).toBe('RELEASED');
    expect('xml' in listed!).toBe(false);
  });
});

describe('dunning + disputes + account current', () => {
  it('duns overdue undisputed items exactly once per level; disputes pause dunning', async () => {
    if (!dbUp) return;
    const admin = { authorization: `Bearer ${await token(app, 'admin@demo.rios')}` };
    const suffix = Date.now();

    // Counterparty with two overdue receivables (seeded via the owner
    // connection: invoices normally arise from statement settlement).
    const party = await app.inject({
      method: 'POST',
      url: '/api/parties',
      headers: admin,
      payload: { legalName: `Slow Payer Re ${suffix}`, kind: 'organisation', country: 'DE', roles: [] },
    });
    expect(party.statusCode).toBe(201);
    const partyId = party.json().id as string;
    const tenantId = (
      await ownerQuery<{ tenant_id: string }>(`select tenant_id from party where id = $1`, [partyId])
    ).rows[0]!.tenant_id;

    const mkInvoice = async (ref: string, dueDaysAgo: number, amountMinor: number): Promise<string> => {
      const r = await ownerQuery<{ id: string }>(
        `insert into ar_invoice (tenant_id, reference, party_id, currency, amount_minor, due_date, status)
         values ($1,$2,$3,'USD',$4,$5,'OPEN') returning id`,
        [tenantId, ref, partyId, amountMinor, daysAgo(dueDaysAgo)],
      );
      return r.rows[0]!.id;
    };
    // 40 days overdue → level 2 (formal notice); 5 days overdue → level 1 (reminder).
    const invA = await mkInvoice(`AC-A-${suffix}`, 40, 500_000);
    const invB = await mkInvoice(`AC-B-${suffix}`, 5, 250_000);

    // Dispute invoice B before the dunning run.
    const dispute = await app.inject({
      method: 'POST',
      url: '/api/finance/disputes',
      headers: admin,
      payload: { invoiceId: invB, reason: 'Commission rate on Q2 statement contested' },
    });
    expect(dispute.statusCode).toBe(201);
    const disputeId = dispute.json().id as string;

    // Dunning run: only the undisputed invoice A gets a notice, at level 2.
    const run1 = await app.inject({ method: 'POST', url: '/api/finance/dunning/run', headers: admin, payload: {} });
    expect(run1.statusCode).toBe(200);
    const mine1 = (run1.json().notices as Array<{ invoiceId: string; level: number }>).filter(
      (n) => n.invoiceId === invA || n.invoiceId === invB,
    );
    expect(mine1).toEqual([{ id: expect.any(String), invoiceId: invA, partyId, reference: `AC-A-${suffix}`, level: 2 }]);

    // Idempotent per level: a second run creates nothing new for these items.
    const run2 = await app.inject({ method: 'POST', url: '/api/finance/dunning/run', headers: admin, payload: {} });
    const mine2 = (run2.json().notices as Array<{ invoiceId: string }>).filter(
      (n) => n.invoiceId === invA || n.invoiceId === invB,
    );
    expect(mine2).toEqual([]);

    // Account current: net per currency, ladder position, dispute pause visible.
    const ac = await app.inject({ method: 'GET', url: `/api/finance/account-current/${partyId}`, headers: admin });
    expect(ac.statusCode).toBe(200);
    const body = ac.json();
    const recvA = body.receivables.find((r: { id: string }) => r.id === invA);
    const recvB = body.receivables.find((r: { id: string }) => r.id === invB);
    expect(recvA.dunningLevel).toBe(2);
    expect(recvA.disputed).toBe(false);
    expect(recvB.dunningLevel).toBe(0); // paused
    expect(recvB.disputed).toBe(true);
    expect(recvB.dunningPaused).toBe(true);
    const usd = body.netByCurrency.find((n: { currency: string }) => n.currency === 'USD');
    expect(usd.receivableMinor).toBe(750_000);
    expect(usd.netMinor).toBe(750_000);
    expect(body.aging.overdueMinor).toBe(750_000);
    expect(body.disputes.map((d: { id: string }) => d.id)).toContain(disputeId);

    // Resolve the dispute; dunning resumes and B is now noticed at level 1.
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/finance/disputes/${disputeId}/resolve`,
      headers: admin,
      payload: { outcome: 'RESOLVED', note: 'Rate confirmed against treaty terms' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('RESOLVED');
    // Resolving twice is rejected.
    const reResolve = await app.inject({
      method: 'POST',
      url: `/api/finance/disputes/${disputeId}/resolve`,
      headers: admin,
      payload: { outcome: 'WRITTEN_OFF' },
    });
    expect(reResolve.statusCode).toBe(409);

    const run3 = await app.inject({ method: 'POST', url: '/api/finance/dunning/run', headers: admin, payload: {} });
    const mine3 = (run3.json().notices as Array<{ invoiceId: string; level: number }>).filter(
      (n) => n.invoiceId === invA || n.invoiceId === invB,
    );
    expect(mine3).toEqual([{ id: expect.any(String), invoiceId: invB, partyId, reference: `AC-B-${suffix}`, level: 1 }]);
  });
});
