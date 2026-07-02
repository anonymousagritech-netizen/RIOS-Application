/**
 * Account-current, dunning & disputed items, and ISO 20022 payment runs
 * (industry-gap-analysis Tier-2 item 9).
 *
 * The account current nets a counterparty's open AR/AP invoices per currency,
 * ages the receivables through the pure @rios/domain aging engine, and shows
 * the dunning ladder position per open item. Disputed items pause dunning
 * (both in the view and in the dunning run). Payment runs are maker-checker:
 * DRAFT (maker) → APPROVED (a different checker) → RELEASED, and release
 * generates the pain.001.001.03 XML via the pure domain builder and stores it
 * on the run. All maths (XML, control sum, dunning ladder, aging) lives in
 * @rios/domain; this module only orchestrates and persists.
 *
 * Permissions: reads need finance:read (as the finance module); mutations need
 * accounting:post (as the accounting module's write side - the technical
 * accountant is the natural dunning/settlement/checker persona). Money on the
 * wire is integer minor units (…Minor) or MAJOR via `amount`, converted with
 * @rios/domain fromMajor. Every mutation is audited in the same transaction.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  fromMajor,
  agingReport,
  dunningLevel,
  buildPain001,
  DEFAULT_DUNNING_LEVELS,
  type AgingItem,
  type Pain001Item,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const today = (): string => new Date().toISOString().slice(0, 10);

const disputeSchema = z
  .object({
    invoiceId: z.string().uuid().optional(),
    statementId: z.string().uuid().optional(),
    reason: z.string().min(1),
  })
  .refine((b) => b.invoiceId || b.statementId, { message: 'invoiceId or statementId is required' });

const resolveSchema = z.object({
  outcome: z.enum(['RESOLVED', 'WRITTEN_OFF']),
  note: z.string().optional(),
});

const dunningLadderSchema = z
  .array(z.object({ level: z.number().int().positive(), afterDaysOverdue: z.number().int().positive(), label: z.string().optional() }))
  .min(1)
  .optional();

const dunningRunSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  levels: dunningLadderSchema, // configurable ladder; defaults to the domain ladder
});

const paymentRunSchema = z.object({
  currency: z.string().length(3),
  items: z
    .array(
      z.object({
        partyId: z.string().uuid().optional(),
        amountMinor: z.number().int().positive().optional(),
        amount: z.number().positive().optional(), // MAJOR units alternative
        creditorName: z.string().min(1),
        creditorIban: z.string().min(1),
        creditorBic: z.string().optional(),
        invoiceId: z.string().uuid().optional(),
        remittance: z.string().optional(),
      }),
    )
    .min(1),
});

const releaseSchema = z.object({
  debtorName: z.string().min(1).optional(),
  debtorIban: z.string().min(1).optional(),
  debtorBic: z.string().optional(),
  executionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

interface OpenInvoiceRow {
  id: string;
  reference: string | null;
  statement_id: string | null;
  currency: string;
  amount_minor: string | number;
  settled_minor: string | number;
  due_date: string | null;
  status: string;
  disputed: boolean;
}

export async function accountCurrentModule(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------
  // Account current: open AR/AP per counterparty, net per currency, aging,
  // dunning ladder position (paused while disputed), open disputes.
  // ---------------------------------------------------------------------
  app.get<{ Params: { partyId: string }; Querystring: { asOf?: string } }>(
    '/api/finance/account-current/:partyId',
    { preHandler: requirePermission('finance:read') },
    async (req) => {
      const ctx = authContext(req);
      const asOf = /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf ?? '') ? req.query.asOf! : today();
      return runAs(ctx, async (db) => {
        // An item is "disputed" when an OPEN disputed_item points at the invoice
        // itself or at the statement it came from - either pauses dunning.
        const openInvoices = (table: 'ar_invoice' | 'ap_invoice') =>
          db.query<OpenInvoiceRow>(
            `select i.id, i.reference, i.statement_id, i.currency, i.amount_minor, i.settled_minor,
                    to_char(i.due_date, 'YYYY-MM-DD') as due_date, i.status,
                    exists (select 1 from disputed_item d
                             where d.status = 'OPEN'
                               and (${table === 'ar_invoice' ? 'd.invoice_id = i.id or' : ''}
                                    (d.statement_id is not null and d.statement_id = i.statement_id))) as disputed
               from ${table} i
              where i.party_id = $1 and i.status <> 'SETTLED'
              order by i.due_date nulls last, i.created_at`,
            [req.params.partyId],
          );

        const [ar, ap, disputes] = [
          await openInvoices('ar_invoice'),
          await openInvoices('ap_invoice'),
          await db.query(
            `select d.id, d.invoice_id as "invoiceId", d.statement_id as "statementId", d.reason,
                    d.status, d.created_at as "createdAt"
               from disputed_item d
               left join ar_invoice i on i.id = d.invoice_id
               left join statement_of_account s on s.id = d.statement_id
              where d.status = 'OPEN' and (i.party_id = $1 or s.counterparty_id = $1)
              order by d.created_at desc`,
            [req.params.partyId],
          ),
        ];

        const mapItem = (r: OpenInvoiceRow, withDunning: boolean) => {
          const outstanding = Number(r.amount_minor) - Number(r.settled_minor);
          const level = r.due_date && !r.disputed ? dunningLevel({ dueDate: r.due_date, asOf }) : 0;
          return {
            id: r.id,
            reference: r.reference,
            statementId: r.statement_id,
            currency: r.currency,
            amountMinor: Number(r.amount_minor),
            settledMinor: Number(r.settled_minor),
            outstandingMinor: outstanding,
            dueDate: r.due_date,
            status: r.status,
            disputed: r.disputed,
            ...(withDunning ? { dunningLevel: level, dunningPaused: r.disputed } : {}),
          };
        };
        const receivables = ar.rows.map((r) => mapItem(r, true));
        const payables = ap.rows.map((r) => mapItem(r, false));

        // Net balance per currency: receivable − payable outstanding (integer minor).
        const net = new Map<string, { receivableMinor: number; payableMinor: number }>();
        for (const r of receivables) {
          const e = net.get(r.currency) ?? { receivableMinor: 0, payableMinor: 0 };
          e.receivableMinor += r.outstandingMinor;
          net.set(r.currency, e);
        }
        for (const p of payables) {
          const e = net.get(p.currency) ?? { receivableMinor: 0, payableMinor: 0 };
          e.payableMinor += p.outstandingMinor;
          net.set(p.currency, e);
        }
        const netByCurrency = [...net.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, e]) => ({ currency, ...e, netMinor: e.receivableMinor - e.payableMinor }));

        // Overdue buckets via the domain aging engine (receivables side; items
        // without a due date are treated as current, i.e. due asOf).
        const agingItems: AgingItem[] = receivables.map((r) => ({
          ref: r.reference ?? r.id,
          outstandingMinor: r.outstandingMinor,
          dueDate: r.dueDate ?? asOf,
        }));
        return {
          partyId: req.params.partyId,
          asOf,
          receivables,
          payables,
          netByCurrency,
          aging: agingReport(agingItems, asOf),
          disputes: disputes.rows,
        };
      });
    },
  );

  // ---------------------------------------------------------------------
  // Disputed items: raise + resolve. An OPEN dispute pauses dunning.
  // ---------------------------------------------------------------------
  app.post('/api/finance/disputes', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = disputeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid dispute', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      if (b.invoiceId) {
        const inv = await db.query(`select id from ar_invoice where id = $1`, [b.invoiceId]);
        if (!inv.rows[0]) { reply.code(404); return { error: 'AR invoice not found' }; }
      }
      if (b.statementId) {
        const stm = await db.query(`select id from statement_of_account where id = $1`, [b.statementId]);
        if (!stm.rows[0]) { reply.code(404); return { error: 'Statement not found' }; }
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into disputed_item (tenant_id, invoice_id, statement_id, reason, raised_by)
         values ($1,$2,$3,$4,$5) returning id`,
        [ctx.tenantId, b.invoiceId ?? null, b.statementId ?? null, b.reason, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'disputed_item', entityId: rows[0]!.id,
        after: { invoiceId: b.invoiceId ?? null, statementId: b.statementId ?? null, reason: b.reason, status: 'OPEN' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, status: 'OPEN' };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/finance/disputes/:id/resolve',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = resolveSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid resolution', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(`select status from disputed_item where id = $1`, [req.params.id]);
        if (!cur.rows[0]) { reply.code(404); return { error: 'Disputed item not found' }; }
        if (cur.rows[0].status !== 'OPEN') {
          reply.code(409);
          return { error: `Dispute is ${cur.rows[0].status}; only an OPEN dispute can be resolved` };
        }
        await db.query(
          `update disputed_item
              set status = $2, resolution_note = $3, resolved_by = $4, resolved_at = now()
            where id = $1`,
          [req.params.id, b.outcome, b.note ?? null, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'resolve', entityType: 'disputed_item', entityId: req.params.id,
          before: { status: 'OPEN' }, after: { status: b.outcome, note: b.note ?? null },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: b.outcome };
      });
    },
  );

  // ---------------------------------------------------------------------
  // Dunning run: level every overdue, undisputed open AR item and record a
  // notice - idempotent per (invoice, level) via the partial unique index.
  // ---------------------------------------------------------------------
  app.post('/api/finance/dunning/run', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = dunningRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid dunning run', details: parsed.error.flatten() };
    }
    const asOf = parsed.data.asOf ?? today();
    const ladder = parsed.data.levels ?? [...DEFAULT_DUNNING_LEVELS];
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string; party_id: string | null; reference: string | null; due_date: string }>(
        `select i.id, i.party_id, i.reference, to_char(i.due_date, 'YYYY-MM-DD') as due_date
           from ar_invoice i
          where i.status <> 'SETTLED' and i.due_date is not null and i.due_date < $1::date
            and not exists (select 1 from disputed_item d
                             where d.status = 'OPEN'
                               and (d.invoice_id = i.id
                                    or (d.statement_id is not null and d.statement_id = i.statement_id)))
          order by i.due_date, i.id`,
        [asOf],
      );
      const notices: Array<{ id: string; invoiceId: string; partyId: string | null; reference: string | null; level: number }> = [];
      for (const inv of rows) {
        const level = dunningLevel({ dueDate: inv.due_date, asOf, levels: ladder });
        if (level === 0) continue;
        const label = ladder.find((l) => l.level === level)?.label ?? `Level ${level}`;
        const ins = await db.query<{ id: string }>(
          `insert into dunning_notice (tenant_id, party_id, invoice_id, level, note)
           values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, invoice_id, level) where invoice_id is not null do nothing
           returning id`,
          [ctx.tenantId, inv.party_id, inv.id, level, `${label} - ${inv.reference ?? inv.id} overdue as of ${asOf}`],
        );
        if (!ins.rows[0]) continue; // this level was already sent for this invoice
        await writeAudit(db, ctx, {
          action: 'create', entityType: 'dunning_notice', entityId: ins.rows[0].id,
          after: { invoiceId: inv.id, partyId: inv.party_id, level, asOf },
          actorLabel: req.auth?.displayName,
        });
        notices.push({ id: ins.rows[0].id, invoiceId: inv.id, partyId: inv.party_id, reference: inv.reference, level });
      }
      return { asOf, created: notices.length, notices };
    });
  });

  // ---------------------------------------------------------------------
  // Payment runs (maker-checker): DRAFT → APPROVED (different user) → RELEASED
  // (generates + stores the pain.001 XML).
  // ---------------------------------------------------------------------
  app.post('/api/finance/payment-runs', { preHandler: requirePermission('accounting:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = paymentRunSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payment run', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const currency = b.currency.toUpperCase();
    const amounts: number[] = [];
    for (const it of b.items) {
      const minor = it.amountMinor ?? (it.amount !== undefined ? fromMajor(it.amount, currency).amount : NaN);
      if (!Number.isInteger(minor) || minor <= 0) {
        reply.code(400);
        return { error: 'Each item needs a positive amountMinor (or major amount)' };
      }
      amounts.push(minor);
    }
    return runAs(ctx, async (db) => {
      const reference = await nextReference(db, ctx.tenantId, 'payment_run_reference', 'PAY');
      const total = amounts.reduce((a, x) => a + x, 0);
      const run = await db.query<{ id: string }>(
        `insert into payment_run (tenant_id, reference, status, currency, total_minor, created_by)
         values ($1,$2,'DRAFT',$3,$4,$5) returning id`,
        [ctx.tenantId, reference, currency, total, ctx.userId],
      );
      const runId = run.rows[0]!.id;
      for (let i = 0; i < b.items.length; i++) {
        const it = b.items[i]!;
        await db.query(
          `insert into payment_run_item
             (tenant_id, run_id, party_id, invoice_id, amount_minor, currency,
              creditor_name, creditor_iban, creditor_bic, remittance)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [ctx.tenantId, runId, it.partyId ?? null, it.invoiceId ?? null, amounts[i], currency,
           it.creditorName, it.creditorIban, it.creditorBic ?? null, it.remittance ?? null],
        );
      }
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'payment_run', entityId: runId,
        after: { reference, currency, totalMinor: total, items: b.items.length, status: 'DRAFT' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: runId, reference, status: 'DRAFT', currency, totalMinor: total, items: b.items.length };
    });
  });

  // Approve a payment run (maker/checker: the approver must not be the creator).
  app.post<{ Params: { id: string } }>(
    '/api/finance/payment-runs/:id/approve',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string; created_by: string | null }>(
          `select status, created_by from payment_run where id = $1`, [req.params.id],
        );
        if (!cur.rows[0]) { reply.code(404); return { error: 'Payment run not found' }; }
        if (cur.rows[0].status !== 'DRAFT') {
          reply.code(409);
          return { error: `Payment run is ${cur.rows[0].status}; only a DRAFT run can be approved` };
        }
        if (cur.rows[0].created_by && cur.rows[0].created_by === ctx.userId) {
          reply.code(403);
          return { error: 'Segregation of duties: the requester cannot approve their own payment run' };
        }
        await db.query(
          `update payment_run set status = 'APPROVED', approved_by = $2, approved_at = now() where id = $1`,
          [req.params.id, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'approve', entityType: 'payment_run', entityId: req.params.id,
          before: { status: 'DRAFT' }, after: { status: 'APPROVED' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'APPROVED' };
      });
    },
  );

  // Release an approved run: generate the pain.001 file and store it on the run.
  app.post<{ Params: { id: string } }>(
    '/api/finance/payment-runs/:id/release',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = releaseSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid release request', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string; reference: string; currency: string }>(
          `select status, reference, currency from payment_run where id = $1`, [req.params.id],
        );
        if (!cur.rows[0]) { reply.code(404); return { error: 'Payment run not found' }; }
        if (cur.rows[0].status !== 'APPROVED') {
          reply.code(409);
          return { error: `Payment run is ${cur.rows[0].status}; only an APPROVED run can be released` };
        }
        const run = cur.rows[0];

        // Debtor account: explicit in the request, else the tenant's bank
        // account in the run currency.
        let debtorName = b.debtorName;
        let debtorIban = b.debtorIban;
        let debtorBic = b.debtorBic;
        if (!debtorName || !debtorIban) {
          const bank = await db.query<{ name: string; iban: string | null }>(
            `select name, iban from bank_account
              where currency = $1 and is_active and iban is not null
              order by name limit 1`,
            [run.currency],
          );
          if (!bank.rows[0]) {
            reply.code(409);
            return { error: `No ${run.currency} debtor account: supply debtorName/debtorIban or configure a bank account` };
          }
          debtorName = debtorName ?? bank.rows[0].name;
          debtorIban = debtorIban ?? bank.rows[0].iban!;
        }

        const itemRows = await db.query<{
          id: string; amount_minor: string | number; currency: string;
          creditor_name: string; creditor_iban: string; creditor_bic: string | null; remittance: string | null;
        }>(
          `select id, amount_minor, currency, creditor_name, creditor_iban, creditor_bic, remittance
             from payment_run_item where run_id = $1 order by created_at, id`,
          [req.params.id],
        );
        const items: Pain001Item[] = itemRows.rows.map((r, i) => ({
          endToEndId: `${run.reference}-${String(i + 1).padStart(3, '0')}`,
          amountMinor: Number(r.amount_minor),
          currency: r.currency,
          creditorName: r.creditor_name,
          creditorIban: r.creditor_iban,
          creditorBic: r.creditor_bic ?? undefined,
          remittanceInfo: r.remittance ?? undefined,
        }));
        const xml = buildPain001({
          messageId: run.reference,
          debtorName,
          debtorIban,
          debtorBic,
          executionDate: b.executionDate ?? today(),
          items,
        });

        await db.query(
          `update payment_run set status = 'RELEASED', released_at = now(), xml = $2 where id = $1`,
          [req.params.id, xml],
        );
        await writeAudit(db, ctx, {
          action: 'release', entityType: 'payment_run', entityId: req.params.id,
          before: { status: 'APPROVED' },
          after: { status: 'RELEASED', transactions: items.length, xmlBytes: xml.length },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'RELEASED', transactions: items.length, xml };
      });
    },
  );

  app.get('/api/finance/payment-runs', { preHandler: requirePermission('finance:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select r.id, r.reference, r.status, r.currency, r.total_minor as "totalMinor",
                r.created_by as "createdBy", r.approved_by as "approvedBy",
                r.created_at as "createdAt", r.approved_at as "approvedAt", r.released_at as "releasedAt",
                (select count(*) from payment_run_item i where i.run_id = r.id)::int as "itemCount"
           from payment_run r order by r.created_at desc`,
      );
      return { paymentRuns: rows };
    });
  });

  // Detail view carries the stored pain.001 XML (list view deliberately does not).
  app.get<{ Params: { id: string } }>(
    '/api/finance/payment-runs/:id',
    { preHandler: requirePermission('finance:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const run = await db.query(
          `select r.id, r.reference, r.status, r.currency, r.total_minor as "totalMinor",
                  r.created_by as "createdBy", r.approved_by as "approvedBy",
                  r.created_at as "createdAt", r.approved_at as "approvedAt", r.released_at as "releasedAt", r.xml
             from payment_run r where r.id = $1`,
          [req.params.id],
        );
        if (!run.rows[0]) { reply.code(404); return { error: 'Payment run not found' }; }
        const items = await db.query(
          `select id, party_id as "partyId", invoice_id as "invoiceId", amount_minor as "amountMinor",
                  currency, creditor_name as "creditorName", creditor_iban as "creditorIban",
                  creditor_bic as "creditorBic", remittance
             from payment_run_item where run_id = $1 order by created_at, id`,
          [req.params.id],
        );
        return { ...(run.rows[0] as Record<string, unknown>), items: items.rows };
      });
    },
  );
}
