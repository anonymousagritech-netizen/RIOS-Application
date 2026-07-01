/**
 * Financial statements module (brief §9.8) - P&L and balance sheet.
 *
 * Read-only reports derived from the same GL the trial balance proves
 * (`gl_account` + `ledger_posting` via posted `journal` rows), so the statements
 * reconcile with the ledger by construction. Sign conventions follow the trial
 * balance: every account carries raw debit/credit sums; presentation balances
 * are debit-normal for assets/expenses (debit - credit) and credit-normal for
 * liabilities/equity/income (credit - debit). All money is integer minor units.
 *
 * The balance sheet closes the accounting identity by rolling the cumulative
 * net result of the P&L accounts (income - expense) into equity as retained
 * earnings, so assets === liabilities + equity whenever every journal balances.
 */

import type { FastifyInstance } from 'fastify';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface AccountBalanceRow {
  id: string;
  code: string;
  name: string;
  type: string;
  debit_minor: string | number;
  credit_minor: string | number;
}

interface AccountLine {
  id: string;
  code: string;
  name: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

/**
 * Sum posted journal lines per account of the given types. Date bounds apply to
 * `journal.posted_at`; only journals with status 'posted' count (drafts and
 * reversed journals are excluded from the statements). The left join keeps
 * zero-activity accounts visible, matching the trial balance.
 */
async function accountBalances(
  db: Db,
  types: string[],
  from: string | null,
  to: string | null,
): Promise<AccountBalanceRow[]> {
  const { rows } = await db.query<AccountBalanceRow>(
    `select ga.id, ga.code, ga.name, ga.type,
            coalesce(sum(p.debit_minor),0)::bigint as debit_minor,
            coalesce(sum(p.credit_minor),0)::bigint as credit_minor
       from gl_account ga
       left join (
              select lp.gl_account_id, lp.debit_minor, lp.credit_minor
                from ledger_posting lp
                join journal j on j.id = lp.journal_id
               where j.status = 'posted'
                 and ($2::date is null or j.posted_at >= $2)
                 and ($3::date is null or j.posted_at <= $3)
            ) p on p.gl_account_id = ga.id
      where ga.type = any($1::text[])
      group by ga.id, ga.code, ga.name, ga.type
      order by ga.code`,
    [types, from, to],
  );
  return rows;
}

/** Present an account with its normal-balance sign applied. */
function toLine(r: AccountBalanceRow, normal: 'debit' | 'credit'): AccountLine {
  const debit = Number(r.debit_minor);
  const credit = Number(r.credit_minor);
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    debitMinor: debit,
    creditMinor: credit,
    balanceMinor: normal === 'debit' ? debit - credit : credit - debit,
  };
}

const sum = (lines: AccountLine[]): number => lines.reduce((a, l) => a + l.balanceMinor, 0);

export async function financialStatementsModule(app: FastifyInstance): Promise<void> {
  // Income statement: income (credit-normal) vs expense (debit-normal) accounts
  // over the period; netResultMinor = revenue - expenses.
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/financial-statements/profit-loss',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const { from, to } = req.query;
      if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
        reply.code(400);
        return { error: 'from/to must be ISO dates (YYYY-MM-DD)' };
      }
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const rows = await accountBalances(db, ['income', 'expense'], from ?? null, to ?? null);
        const revenue = rows.filter((r) => r.type === 'income').map((r) => toLine(r, 'credit'));
        const expenses = rows.filter((r) => r.type === 'expense').map((r) => toLine(r, 'debit'));
        const totalRevenueMinor = sum(revenue);
        const totalExpensesMinor = sum(expenses);
        return {
          from: from ?? null,
          to: to ?? null,
          sections: { revenue, expenses },
          totals: { revenueMinor: totalRevenueMinor, expensesMinor: totalExpensesMinor },
          netResultMinor: totalRevenueMinor - totalExpensesMinor,
        };
      });
    },
  );

  // Balance sheet as at a date: asset (debit-normal) vs liability/equity
  // (credit-normal) balances, plus retained earnings (the cumulative net result
  // of the P&L accounts) folded into equity so the sheet balances.
  app.get<{ Querystring: { asOf?: string } }>(
    '/api/financial-statements/balance-sheet',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const { asOf } = req.query;
      if (asOf && !DATE_RE.test(asOf)) {
        reply.code(400);
        return { error: 'asOf must be an ISO date (YYYY-MM-DD)' };
      }
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const rows = await accountBalances(
          db,
          ['asset', 'liability', 'equity', 'income', 'expense'],
          null,
          asOf ?? null,
        );
        const assets = rows.filter((r) => r.type === 'asset').map((r) => toLine(r, 'debit'));
        const liabilities = rows.filter((r) => r.type === 'liability').map((r) => toLine(r, 'credit'));
        const equity = rows.filter((r) => r.type === 'equity').map((r) => toLine(r, 'credit'));

        // Retained earnings: cumulative income (credit-normal) minus cumulative
        // expenses (debit-normal) across all P&L accounts up to asOf.
        const incomeNet = sum(rows.filter((r) => r.type === 'income').map((r) => toLine(r, 'credit')));
        const expenseNet = sum(rows.filter((r) => r.type === 'expense').map((r) => toLine(r, 'debit')));
        const retainedEarningsMinor = incomeNet - expenseNet;

        const assetsMinor = sum(assets);
        const liabilitiesMinor = sum(liabilities);
        const equityMinor = sum(equity) + retainedEarningsMinor;

        return {
          asOf: asOf ?? null,
          sections: { assets, liabilities, equity },
          retainedEarningsMinor,
          sectionTotals: {
            assetsMinor,
            liabilitiesMinor,
            equityMinor,
          },
          balanced: assetsMinor === liabilitiesMinor + equityMinor,
        };
      });
    },
  );
}
