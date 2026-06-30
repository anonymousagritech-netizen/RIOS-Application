/**
 * Finance module (brief §9.8) - GL / AR / AP / cash / bank.
 *
 * The read side exposes the general-ledger chart and a trial balance that proves
 * the GL self-balances (total debits === total credits). The sub-ledgers (AR/AP)
 * list outstanding invoices with an overdue flag. The write side records cash
 * receipts/payments, allocates them against AR/AP invoices (advancing their
 * settlement status), and reconciles bank lines. Money on the wire is MAJOR
 * units, converted to minor via @rios/domain `fromMajor`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromMajor } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const cashSchema = z.object({
  bankAccountId: z.string().uuid().optional(),
  direction: z.enum(['IN', 'OU']),
  amount: z.number(),
  currency: z.string().length(3),
  counterpartyId: z.string().uuid().optional(),
  arInvoiceId: z.string().uuid().optional(),
  apInvoiceId: z.string().uuid().optional(),
  narrative: z.string().optional(),
});

export async function financeModule(app: FastifyInstance): Promise<void> {
  app.get('/api/finance/gl-accounts', { preHandler: requirePermission('finance:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, code, name, type, is_control as "isControl", is_active as "isActive", parent_id as "parentId"
           from gl_account order by code`,
      );
      return { glAccounts: rows };
    });
  });

  // Trial balance: per-account debit/credit sums plus totals. balanced proves the GL self-balances.
  app.get('/api/finance/trial-balance', { preHandler: requirePermission('finance:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        id: string;
        code: string;
        name: string;
        type: string;
        debit_minor: number;
        credit_minor: number;
      }>(
        `select ga.id, ga.code, ga.name, ga.type,
                coalesce(sum(lp.debit_minor),0)::bigint as debit_minor,
                coalesce(sum(lp.credit_minor),0)::bigint as credit_minor
           from gl_account ga
           left join ledger_posting lp on lp.gl_account_id = ga.id
          group by ga.id, ga.code, ga.name, ga.type
          order by ga.code`,
      );
      const totalDebits = rows.reduce((a, r) => a + Number(r.debit_minor), 0);
      const totalCredits = rows.reduce((a, r) => a + Number(r.credit_minor), 0);
      return {
        accounts: rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          type: r.type,
          debitMinor: Number(r.debit_minor),
          creditMinor: Number(r.credit_minor),
        })),
        totalDebitsMinor: totalDebits,
        totalCreditsMinor: totalCredits,
        balanced: totalDebits === totalCredits,
      };
    });
  });

  app.get<{ Querystring: { status?: string } }>(
    '/api/finance/ar-invoices',
    { preHandler: requirePermission('finance:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select i.id, i.reference, i.party_id as "partyId", p.short_name as "partyName",
                  i.statement_id as "statementId", i.currency, i.amount_minor as "amountMinor",
                  i.settled_minor as "settledMinor", i.due_date as "dueDate", i.status,
                  (i.due_date is not null and i.due_date < current_date and i.status <> 'SETTLED') as overdue
             from ar_invoice i
             left join party p on p.id = i.party_id
            where ($1::citext is null or i.status = $1)
            order by i.created_at desc`,
          [req.query.status ?? null],
        );
        return { invoices: rows };
      });
    },
  );

  app.get<{ Querystring: { status?: string } }>(
    '/api/finance/ap-invoices',
    { preHandler: requirePermission('finance:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select i.id, i.reference, i.party_id as "partyId", p.short_name as "partyName",
                  i.statement_id as "statementId", i.currency, i.amount_minor as "amountMinor",
                  i.settled_minor as "settledMinor", i.due_date as "dueDate", i.status,
                  (i.due_date is not null and i.due_date < current_date and i.status <> 'SETTLED') as overdue
             from ap_invoice i
             left join party p on p.id = i.party_id
            where ($1::citext is null or i.status = $1)
            order by i.created_at desc`,
          [req.query.status ?? null],
        );
        return { invoices: rows };
      });
    },
  );

  app.get('/api/finance/bank-accounts', { preHandler: requirePermission('finance:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, currency, gl_account_id as "glAccountId", iban,
                balance_minor as "balanceMinor", is_active as "isActive"
           from bank_account order by name`,
      );
      return { bankAccounts: rows };
    });
  });

  // Record a cash receipt/payment and allocate it to an AR/AP invoice.
  app.post('/api/finance/cash', { preHandler: requirePermission('finance:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = cashSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid cash transaction', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const amount = fromMajor(b.amount, b.currency);
    return runAs(ctx, async (db) => {
      const tx = await db.query<{ id: string }>(
        `insert into cash_transaction
           (tenant_id, bank_account_id, direction, amount_minor, currency, counterparty_id,
            ar_invoice_id, ap_invoice_id, narrative, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [
          ctx.tenantId, b.bankAccountId ?? null, b.direction, amount.amount, amount.currency,
          b.counterpartyId ?? null, b.arInvoiceId ?? null, b.apInvoiceId ?? null, b.narrative ?? null, ctx.userId,
        ],
      );
      const id = tx.rows[0]!.id;

      let invoiceStatus: string | null = null;
      if (b.arInvoiceId) {
        invoiceStatus = await allocateInvoice(db, 'ar_invoice', b.arInvoiceId, amount.amount);
      } else if (b.apInvoiceId) {
        invoiceStatus = await allocateInvoice(db, 'ap_invoice', b.apInvoiceId, amount.amount);
      }

      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'cash_transaction',
        entityId: id,
        after: { direction: b.direction, amountMinor: amount.amount, currency: amount.currency, arInvoiceId: b.arInvoiceId ?? null, apInvoiceId: b.apInvoiceId ?? null },
        actorLabel: req.auth?.displayName,
      });

      reply.code(201);
      return {
        id,
        direction: b.direction,
        amountMinor: amount.amount,
        currency: amount.currency,
        invoiceStatus,
      };
    });
  });

  // Bank reconciliation: mark a cash line reconciled against the statement.
  app.post<{ Params: { id: string } }>(
    '/api/finance/cash/:id/reconcile',
    { preHandler: requirePermission('finance:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `update cash_transaction set is_reconciled = true where id = $1 returning id`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Cash transaction not found' };
        }
        await writeAudit(db, ctx, {
          action: 'reconcile',
          entityType: 'cash_transaction',
          entityId: req.params.id,
          after: { isReconciled: true },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, isReconciled: true };
      });
    },
  );
}

/**
 * Apply a cash amount to an invoice: bump settled_minor and advance status to
 * SETTLED once fully covered, else PART_PAID.
 */
async function allocateInvoice(
  db: Db,
  table: 'ar_invoice' | 'ap_invoice',
  invoiceId: string,
  amountMinor: number,
): Promise<string | null> {
  const cur = await db.query<{ amount_minor: number; settled_minor: number }>(
    `select amount_minor, settled_minor from ${table} where id = $1`,
    [invoiceId],
  );
  if (!cur.rows[0]) return null;
  const settled = Number(cur.rows[0].settled_minor) + amountMinor;
  const status = settled >= Number(cur.rows[0].amount_minor) ? 'SETTLED' : 'PART_PAID';
  await db.query(
    `update ${table} set settled_minor = $1, status = $2 where id = $3`,
    [settled, status, invoiceId],
  );
  return status;
}
