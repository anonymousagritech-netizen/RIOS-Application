/**
 * Financial statements test (brief §9.8) - P&L and balance sheet.
 *
 * Proves the income statement and balance sheet derive correctly from posted GL
 * journals: posting a bound treaty's technical accounting shows up as revenue,
 * netResultMinor is revenue - expenses, and the balance sheet balances
 * (assets === liabilities + equity, with retained earnings closing the
 * identity). Skips cleanly when Postgres is unreachable.
 *
 * The module is registered by buildApp() (see server/src/app.ts
 * to server/src/app.ts).
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

interface AccountLine {
  id: string;
  code: string;
  name: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
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

describe('financial statements: P&L and balance sheet', () => {
  it('reports posted premium as revenue on the income statement', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    // Bind a treaty and post its technical accounting so the period has revenue.
    const created = await app.inject({
      method: 'POST', url: '/api/treaties', headers: auth,
      payload: { name: 'FinStmt P&L Treaty', basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD', terms: { depositPremium: 300000, currency: 'USD' } },
    });
    const id = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'QUOTED' } });
    await app.inject({ method: 'POST', url: `/api/treaties/${id}/transition`, headers: auth, payload: { to: 'BOUND' } });
    const posted = await app.inject({ method: 'POST', url: `/api/treaties/${id}/post`, headers: auth });
    expect(posted.json().reconciled).toBe(true);

    const res = await app.inject({ method: 'GET', url: '/api/financial-statements/profit-loss', headers: auth });
    expect(res.statusCode).toBe(200);
    const pl = res.json() as {
      sections: { revenue: AccountLine[]; expenses: AccountLine[] };
      totals: { revenueMinor: number; expensesMinor: number };
      netResultMinor: number;
    };

    expect(Array.isArray(pl.sections.revenue)).toBe(true);
    expect(Array.isArray(pl.sections.expenses)).toBe(true);

    // The posting rules credit 4000 (Ceded Premium Income) for deposit premium;
    // the $300,000.00 just posted guarantees at least 30,000,000 minor units.
    const premiumIncome = pl.sections.revenue.find((a) => a.code === '4000');
    expect(premiumIncome).toBeDefined();
    expect(premiumIncome!.balanceMinor).toBeGreaterThanOrEqual(30_000_000);

    expect(pl.totals.revenueMinor).toBe(pl.sections.revenue.reduce((a, l) => a + l.balanceMinor, 0));
    expect(pl.totals.expensesMinor).toBe(pl.sections.expenses.reduce((a, l) => a + l.balanceMinor, 0));
    expect(pl.netResultMinor).toBe(pl.totals.revenueMinor - pl.totals.expensesMinor);
  });

  it('returns a zero P&L for a period with no postings', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({
      method: 'GET',
      url: '/api/financial-statements/profit-loss?from=1990-01-01&to=1990-12-31',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.revenueMinor).toBe(0);
    expect(res.json().totals.expensesMinor).toBe(0);
    expect(res.json().netResultMinor).toBe(0);

    const bad = await app.inject({
      method: 'GET',
      url: '/api/financial-statements/profit-loss?from=not-a-date',
      headers: auth,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('produces a balance sheet that balances (assets = liabilities + equity)', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'admin@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const res = await app.inject({ method: 'GET', url: '/api/financial-statements/balance-sheet', headers: auth });
    expect(res.statusCode).toBe(200);
    const bs = res.json() as {
      sections: { assets: AccountLine[]; liabilities: AccountLine[]; equity: AccountLine[] };
      retainedEarningsMinor: number;
      sectionTotals: { assetsMinor: number; liabilitiesMinor: number; equityMinor: number };
      balanced: boolean;
    };

    expect(Array.isArray(bs.sections.assets)).toBe(true);
    expect(Array.isArray(bs.sections.liabilities)).toBe(true);
    expect(Array.isArray(bs.sections.equity)).toBe(true);

    // Every journal the platform books is balanced double-entry (the finance
    // trial-balance test proves total debits === total credits), so with
    // retained earnings folded into equity the identity must hold exactly.
    expect(bs.sectionTotals.assetsMinor).toBe(bs.sectionTotals.liabilitiesMinor + bs.sectionTotals.equityMinor);
    expect(bs.balanced).toBe(true);

    // The freshly posted premium sits in the control account (asset) and in
    // retained earnings via income, so both sides carry real, nonzero money.
    expect(bs.sectionTotals.assetsMinor).toBeGreaterThan(0);
  });

  it('denies access without accounting:read (portal user)', async () => {
    if (!dbUp) return;
    const tkn = await token(app, 'broker@demo.rios');
    const auth = { authorization: `Bearer ${tkn}` };

    const pl = await app.inject({ method: 'GET', url: '/api/financial-statements/profit-loss', headers: auth });
    expect(pl.statusCode).toBe(403);
    const bs = await app.inject({ method: 'GET', url: '/api/financial-statements/balance-sheet', headers: auth });
    expect(bs.statusCode).toBe(403);
  });
});
