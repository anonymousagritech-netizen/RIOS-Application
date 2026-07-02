/**
 * Multi-GAAP parallel ledgers module (industry-gap-analysis §Tier-3 item 11).
 *
 * The same economic events reported under multiple accounting bases (e.g.
 * LOCAL_GAAP, IFRS17, US_GAAP) using the standard **parallel ledger = core +
 * adjustment layer** model used by FS-RI-class general ledgers: the primary GL
 * (journal / ledger_posting) remains the single source of booked postings, and
 * each parallel ledger carries only *basis-adjustment* journals on top of it.
 * A parallel ledger's trial balance is therefore
 *
 *     primary-ledger balances  +  that ledger's basis adjustments
 *
 * so the parallel views reconcile to the core GL by construction and the
 * existing single-ledger path (posting, trial balance, P&L, balance sheet,
 * statement reconciliation) is untouched - basis adjustments live in their own
 * tables (migration 0058) and never enter `ledger_posting`.
 *
 * The consolidation endpoint is a simple intercompany-elimination VIEW over a
 * trial balance - accounts flagged as intercompany (by code prefix or an
 * explicit list) are netted out and shown as eliminations. It is honest about
 * what it is: not a legal-entity consolidation engine (no entity hierarchy,
 * no FX translation, no minority interests); the response metadata says so.
 *
 * Balance rule: adjustment lines must balance to zero per currency - enforced
 * through the same tested @rios/domain `assertBalanced` double-entry rule the
 * GL reconciliation chain relies on. All money is integer minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertBalanced, money, UnbalancedPostingError, type PostingLeg } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CONSOLIDATION_NOTE =
  'Simplified consolidation view: flagged intercompany accounts are netted out of the trial balance ' +
  'and shown as eliminations. This is a reporting view, not a legal-entity consolidation engine ' +
  '(no entity hierarchy, no FX translation, no minority interests).';

const ledgerSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1),
  basis: z.string().min(1),
  currency: z.string().length(3).optional(),
  isPrimary: z.boolean().optional(),
});

const adjustmentSchema = z.object({
  reference: z.string().optional(),
  description: z.string().optional(),
  postedAt: z.string().regex(DATE_RE).optional(),
  lines: z
    .array(
      z.object({
        accountCode: z.string().min(1),
        debitMinor: z.number().int().nonnegative().default(0),
        creditMinor: z.number().int().nonnegative().default(0),
        currency: z.string().length(3),
        narrative: z.string().optional(),
      }),
    )
    .min(2),
});

interface LedgerRow {
  id: string;
  code: string;
  name: string;
  basis: string;
  currency: string | null;
  is_primary: boolean;
  active: boolean;
}

interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: string;
  primary_debit_minor: number;
  primary_credit_minor: number;
  adjustment_debit_minor: number;
  adjustment_credit_minor: number;
}

async function loadLedger(db: Db, id: string): Promise<LedgerRow | null> {
  const { rows } = await db.query<LedgerRow>(
    `select id, code, name, basis, currency, is_primary, active from gl_ledger where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The parallel-ledger trial balance: per account, posted primary-GL sums plus
 * the given ledger's posted basis-adjustment sums, both bounded by asOf
 * (journal.posted_at / gl_basis_adjustment.posted_at). Zero-activity accounts
 * stay visible, matching the existing trial balance. Pass ledgerId = null for
 * the core (primary) ledger only.
 */
async function parallelTrialBalance(db: Db, ledgerId: string | null, asOf: string | null): Promise<TrialBalanceRow[]> {
  // Each layer is aggregated per account BEFORE the join: joining two line-level
  // sets on the same account would multiply the sums (fan-out).
  const { rows } = await db.query<TrialBalanceRow>(
    `select ga.id, ga.code, ga.name, ga.type,
            coalesce(p.debit_minor,0)::bigint  as primary_debit_minor,
            coalesce(p.credit_minor,0)::bigint as primary_credit_minor,
            coalesce(a.debit_minor,0)::bigint  as adjustment_debit_minor,
            coalesce(a.credit_minor,0)::bigint as adjustment_credit_minor
       from gl_account ga
       left join (
              select lp.gl_account_id,
                     sum(lp.debit_minor)  as debit_minor,
                     sum(lp.credit_minor) as credit_minor
                from ledger_posting lp
                join journal j on j.id = lp.journal_id
               where j.status = 'posted'
                 and ($2::date is null or j.posted_at <= $2)
               group by lp.gl_account_id
            ) p on p.gl_account_id = ga.id
       left join (
              select l.gl_account_id,
                     sum(l.debit_minor)  as debit_minor,
                     sum(l.credit_minor) as credit_minor
                from gl_basis_adjustment_line l
                join gl_basis_adjustment ba on ba.id = l.adjustment_id
               where ba.status = 'posted'
                 and $1::uuid is not null and ba.ledger_id = $1
                 and ($2::date is null or ba.posted_at <= $2)
               group by l.gl_account_id
            ) a on a.gl_account_id = ga.id
      order by ga.code`,
    [ledgerId, asOf],
  );
  return rows;
}

function presentTrialBalance(rows: TrialBalanceRow[]) {
  const accounts = rows.map((r) => {
    const primaryDebit = Number(r.primary_debit_minor);
    const primaryCredit = Number(r.primary_credit_minor);
    const adjDebit = Number(r.adjustment_debit_minor);
    const adjCredit = Number(r.adjustment_credit_minor);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      primaryDebitMinor: primaryDebit,
      primaryCreditMinor: primaryCredit,
      adjustmentDebitMinor: adjDebit,
      adjustmentCreditMinor: adjCredit,
      debitMinor: primaryDebit + adjDebit,
      creditMinor: primaryCredit + adjCredit,
    };
  });
  const totalDebits = accounts.reduce((a, r) => a + r.debitMinor, 0);
  const totalCredits = accounts.reduce((a, r) => a + r.creditMinor, 0);
  return { accounts, totalDebitsMinor: totalDebits, totalCreditsMinor: totalCredits, balanced: totalDebits === totalCredits };
}

export async function multiGaapModule(app: FastifyInstance): Promise<void> {
  // Create a parallel ledger (tenant configuration - nothing is seeded).
  app.post('/api/accounting/ledgers', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = ledgerSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid ledger', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const dup = await db.query(`select 1 from gl_ledger where code = $1`, [b.code]);
      if (dup.rows.length > 0) {
        reply.code(409);
        return { error: `Ledger code ${b.code} already exists` };
      }
      if (b.isPrimary) {
        const primary = await db.query<{ code: string }>(`select code from gl_ledger where is_primary`);
        if (primary.rows.length > 0) {
          reply.code(409);
          return { error: `A primary ledger already exists (${primary.rows[0]!.code})` };
        }
      }
      const inserted = await db.query<{ id: string }>(
        `insert into gl_ledger (tenant_id, code, name, basis, currency, is_primary, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, b.code, b.name, b.basis, b.currency ?? null, b.isPrimary ?? false, ctx.userId],
      );
      const id = inserted.rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'gl_ledger',
        entityId: id,
        after: { code: b.code, name: b.name, basis: b.basis, isPrimary: b.isPrimary ?? false },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, code: b.code, name: b.name, basis: b.basis, currency: b.currency ?? null, isPrimary: b.isPrimary ?? false };
    });
  });

  app.get('/api/accounting/ledgers', { preHandler: requirePermission('accounting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, code, name, basis, currency, is_primary as "isPrimary", active,
                to_char(created_at, 'YYYY-MM-DD') as "createdAt"
           from gl_ledger order by code`,
      );
      return { ledgers: rows };
    });
  });

  // Post a balanced basis-adjustment journal to one parallel ledger only.
  app.post<{ Params: { id: string } }>(
    '/api/accounting/ledgers/:id/basis-adjustments',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = adjustmentSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid basis adjustment', details: parsed.error.flatten() };
      }
      const b = parsed.data;

      // Each line must be exactly one of debit or credit (the GL leg rule).
      for (const l of b.lines) {
        if ((l.debitMinor > 0) === (l.creditMinor > 0)) {
          reply.code(400);
          return { error: `Line for account ${l.accountCode} must have exactly one of debitMinor/creditMinor > 0` };
        }
      }

      // Same balance rule the existing GL enforces: debits equal credits, per
      // currency, checked by the tested @rios/domain double-entry rule.
      const byCurrency = new Map<string, PostingLeg[]>();
      for (const l of b.lines) {
        const legs = byCurrency.get(l.currency) ?? [];
        legs.push({ account: l.accountCode, debit: money(l.debitMinor, l.currency), credit: money(l.creditMinor, l.currency) });
        byCurrency.set(l.currency, legs);
      }
      try {
        for (const legs of byCurrency.values()) {
          assertBalanced({ sourceEventIds: [], legs });
        }
      } catch (err) {
        if (err instanceof UnbalancedPostingError) {
          reply.code(400);
          return { error: `Basis adjustment does not balance: ${err.message}` };
        }
        throw err;
      }

      return runAs(ctx, async (db) => {
        const ledger = await loadLedger(db, req.params.id);
        if (!ledger) {
          reply.code(404);
          return { error: 'Ledger not found' };
        }

        const accounts = await db.query<{ code: string; id: string }>(`select code, id from gl_account`);
        const accountMap = new Map(accounts.rows.map((r) => [r.code, r.id]));
        for (const l of b.lines) {
          if (!accountMap.has(l.accountCode)) {
            reply.code(400);
            return { error: `Unknown GL account code ${l.accountCode}` };
          }
        }

        const reference = b.reference ?? (await nextReference(db, ctx.tenantId, 'basis_adjustment_reference', 'BAJ'));
        const header = await db.query<{ id: string }>(
          `insert into gl_basis_adjustment
             (tenant_id, ledger_id, reference, description, posted_at, currency, source, created_by)
           values ($1,$2,$3,$4, coalesce($5::date, current_date), $6, 'basis_adjustment', $7) returning id`,
          [ctx.tenantId, ledger.id, reference, b.description ?? null, b.postedAt ?? null, b.lines[0]!.currency, ctx.userId],
        );
        const adjustmentId = header.rows[0]!.id;

        for (const l of b.lines) {
          await db.query(
            `insert into gl_basis_adjustment_line
               (tenant_id, adjustment_id, gl_account_id, debit_minor, credit_minor, currency, narrative)
             values ($1,$2,$3,$4,$5,$6,$7)`,
            [ctx.tenantId, adjustmentId, accountMap.get(l.accountCode), l.debitMinor, l.creditMinor, l.currency, l.narrative ?? null],
          );
        }

        await writeAudit(db, ctx, {
          action: 'post',
          entityType: 'gl_basis_adjustment',
          entityId: adjustmentId,
          after: { ledgerId: ledger.id, ledgerCode: ledger.code, reference, lines: b.lines.length },
          actorLabel: req.auth?.displayName,
        });

        reply.code(201);
        return { id: adjustmentId, ledgerId: ledger.id, ledgerCode: ledger.code, reference, lines: b.lines.length };
      });
    },
  );

  // Parallel trial balance: primary-ledger balances plus this ledger's basis
  // adjustments (the core + adjustment-layer model in the module docblock).
  app.get<{ Params: { id: string }; Querystring: { asOf?: string } }>(
    '/api/accounting/ledgers/:id/trial-balance',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const { asOf } = req.query;
      if (asOf && !DATE_RE.test(asOf)) {
        reply.code(400);
        return { error: 'asOf must be an ISO date (YYYY-MM-DD)' };
      }
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const ledger = await loadLedger(db, req.params.id);
        if (!ledger) {
          reply.code(404);
          return { error: 'Ledger not found' };
        }
        const rows = await parallelTrialBalance(db, ledger.id, asOf ?? null);
        return {
          ledger: { id: ledger.id, code: ledger.code, name: ledger.name, basis: ledger.basis },
          asOf: asOf ?? null,
          model: 'primary ledger + basis-adjustment layer',
          ...presentTrialBalance(rows),
        };
      });
    },
  );

  // Simple intercompany/consolidation elimination view. ledgerCode picks the
  // parallel ledger (core + adjustments); omit it for the core ledger alone.
  // Intercompany accounts are flagged by code prefix (intercompanyPrefix) or an
  // explicit comma-separated list (intercompanyAccounts).
  app.get<{ Querystring: { ledgerCode?: string; asOf?: string; intercompanyPrefix?: string; intercompanyAccounts?: string } }>(
    '/api/accounting/consolidation',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const { ledgerCode, asOf, intercompanyPrefix, intercompanyAccounts } = req.query;
      if (asOf && !DATE_RE.test(asOf)) {
        reply.code(400);
        return { error: 'asOf must be an ISO date (YYYY-MM-DD)' };
      }
      const icList = (intercompanyAccounts ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        let ledger: LedgerRow | null = null;
        if (ledgerCode) {
          const { rows } = await db.query<LedgerRow>(
            `select id, code, name, basis, currency, is_primary, active from gl_ledger where code = $1`,
            [ledgerCode],
          );
          ledger = rows[0] ?? null;
          if (!ledger) {
            reply.code(404);
            return { error: `Ledger ${ledgerCode} not found` };
          }
        }
        const rows = await parallelTrialBalance(db, ledger?.id ?? null, asOf ?? null);
        const tb = presentTrialBalance(rows);

        const isIntercompany = (code: string): boolean =>
          icList.includes(code) || (!!intercompanyPrefix && code.startsWith(intercompanyPrefix));

        const consolidated = tb.accounts.filter((a) => !isIntercompany(a.code));
        const eliminations = tb.accounts
          .filter((a) => isIntercompany(a.code))
          .map((a) => ({ ...a, netMinor: a.debitMinor - a.creditMinor }));
        // If intercompany balances truly mirror each other, they net to zero.
        const eliminationNetMinor = eliminations.reduce((s, e) => s + e.netMinor, 0);

        return {
          ledger: ledger ? { id: ledger.id, code: ledger.code, basis: ledger.basis } : { code: 'PRIMARY (core GL)', basis: 'core' },
          asOf: asOf ?? null,
          intercompanyFlaggedBy: {
            prefix: intercompanyPrefix ?? null,
            accounts: icList,
          },
          consolidated,
          eliminations,
          eliminationNetMinor,
          eliminationsBalanced: eliminationNetMinor === 0,
          totals: {
            consolidatedDebitsMinor: consolidated.reduce((s, a) => s + a.debitMinor, 0),
            consolidatedCreditsMinor: consolidated.reduce((s, a) => s + a.creditMinor, 0),
          },
          note: CONSOLIDATION_NOTE,
        };
      });
    },
  );
}
