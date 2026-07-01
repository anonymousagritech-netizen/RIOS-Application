/**
 * Statements of Account module (brief §7.6, §28.5).
 *
 * The statement-of-account lifecycle: gather a contract's immutable Financial
 * Events that are not yet on a statement, net them with the @rios/domain
 * `buildStatement` function (the same one the unit tests prove correct), persist
 * a statement_of_account and stamp the events with its id, then drive the
 * statement through its ordered lifecycle (§28.5). Issuing a statement spins off
 * the matching AR or AP invoice so the financial sub-ledgers stay reconcilable
 * to the technical-accounting chain.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildStatement, money, agingReport, type FinancialEvent as DomainEvent, type AgingItem,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

/**
 * Ordered statement lifecycle (§28.5). Each step may only advance to the next,
 * plus UNDER_REVIEW and ISSUED may branch to DISPUTED.
 */
const STATEMENT_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['PREPARED'],
  PREPARED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['APPROVED', 'DISPUTED'],
  APPROVED: ['ISSUED'],
  ISSUED: ['SETTLED', 'DISPUTED'],
  SETTLED: ['CLOSED'],
  CLOSED: [],
  DISPUTED: [],
};

const generateSchema = z.object({
  contractId: z.string().uuid(),
  counterpartyId: z.string().uuid().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
});

const transitionSchema = z.object({ to: z.string().min(1) });

export async function statementsModule(app: FastifyInstance): Promise<void> {
  // Generate a statement from the contract's un-statemented financial events.
  app.post('/api/statements/generate', { preHandler: requirePermission('statement:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid statement request', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const contract = await db.query<{ id: string; currency: string; reference: string | null }>(
        `select id, currency, reference from contract where id = $1 and not is_deleted`,
        [b.contractId],
      );
      if (!contract.rows[0]) {
        reply.code(404);
        return { error: 'Treaty not found' };
      }
      const currency = contract.rows[0].currency;

      const eventRows = await db.query<{
        id: string;
        contract_id: string;
        event_type: string;
        direction: 'DR' | 'CR';
        amount_minor: number;
        currency: string;
        booked_at: string;
      }>(
        `select id, contract_id, event_type, direction, amount_minor, currency, booked_at
           from financial_event
          where contract_id = $1 and statement_id is null
            and ($2::date is null or booked_at >= $2)
            and ($3::date is null or booked_at <= $3)
          order by booked_at, created_at`,
        [b.contractId, b.periodStart ?? null, b.periodEnd ?? null],
      );
      if (eventRows.rows.length === 0) {
        reply.code(409);
        return { error: 'no unstatemented events' };
      }

      const events: DomainEvent[] = eventRows.rows.map((r) => ({
        id: r.id,
        contractId: r.contract_id,
        type: r.event_type as DomainEvent['type'],
        amount: money(r.amount_minor, r.currency),
        direction: r.direction,
        bookedAt: String(r.booked_at),
      }));
      const statement = buildStatement(events, currency);

      const reference = await nextReference(db, ctx.tenantId, 'statement_reference', 'SOA');
      const inserted = await db.query<{ id: string }>(
        `insert into statement_of_account
           (tenant_id, reference, contract_id, counterparty_id, period_start, period_end,
            currency, balance_minor, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'PREPARED',$9) returning id`,
        [
          ctx.tenantId, reference, b.contractId, b.counterpartyId ?? null,
          b.periodStart ?? null, b.periodEnd ?? null, currency, statement.balance.amount, ctx.userId,
        ],
      );
      const id = inserted.rows[0]!.id;

      await db.query(
        `update financial_event set statement_id = $1 where id = any($2::uuid[])`,
        [id, events.map((e) => e.id)],
      );

      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'statement_of_account',
        entityId: id,
        after: { reference, balanceMinor: statement.balance.amount, currency, eventCount: statement.eventCount },
        actorLabel: req.auth?.displayName,
      });

      reply.code(201);
      return {
        id,
        reference,
        balanceMinor: statement.balance.amount,
        currency,
        lines: statement.lines.map((l) => ({ type: l.type, count: l.count, totalMinor: l.total.amount })),
        eventCount: statement.eventCount,
      };
    });
  });

  app.get<{ Querystring: { contractId?: string; status?: string } }>(
    '/api/statements',
    { preHandler: requirePermission('statement:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select s.id, s.reference, s.contract_id as "contractId", s.counterparty_id as "counterpartyId",
                  s.period_start as "periodStart", s.period_end as "periodEnd", s.currency,
                  s.balance_minor as "balanceMinor", s.status, s.issued_at as "issuedAt", s.settled_at as "settledAt"
             from statement_of_account s
            where ($1::uuid is null or s.contract_id = $1)
              and ($2::citext is null or s.status = $2)
            order by s.created_at desc`,
          [req.query.contractId ?? null, req.query.status ?? null],
        );
        return { statements: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/statements/:id',
    { preHandler: requirePermission('statement:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const header = await db.query(
          `select s.id, s.reference, s.contract_id as "contractId", s.counterparty_id as "counterpartyId",
                  s.period_start as "periodStart", s.period_end as "periodEnd", s.currency,
                  s.balance_minor as "balanceMinor", s.status, s.issued_at as "issuedAt", s.settled_at as "settledAt"
             from statement_of_account s where s.id = $1`,
          [req.params.id],
        );
        if (!header.rows[0]) {
          reply.code(404);
          return { error: 'Statement not found' };
        }
        const events = await db.query(
          `select id, contract_id as "contractId", event_type as "eventType", direction,
                  amount_minor as "amountMinor", currency, booked_at as "bookedAt", narrative
             from financial_event where statement_id = $1 order by booked_at, created_at`,
          [req.params.id],
        );
        return { ...header.rows[0], events: events.rows };
      });
    },
  );

  // Drive the statement through its ordered lifecycle (§28.5).
  app.post<{ Params: { id: string } }>(
    '/api/statements/:id/transition',
    { preHandler: requirePermission('statement:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = transitionSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid transition', details: parsed.error.flatten() };
      }
      const to = parsed.data.to;
      return runAs(ctx, async (db) => {
        const cur = await db.query<{
          id: string;
          status: string;
          balance_minor: number;
          currency: string;
          counterparty_id: string | null;
        }>(
          `select id, status, balance_minor, currency, counterparty_id from statement_of_account where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Statement not found' };
        }
        const statement = cur.rows[0];
        const allowed = STATEMENT_TRANSITIONS[statement.status] ?? [];
        if (!allowed.includes(to)) {
          reply.code(409);
          return { error: `Illegal transition ${statement.status} → ${to}. Allowed: ${allowed.join(', ') || 'none'}` };
        }

        if (to === 'ISSUED') {
          await db.query(`update statement_of_account set status = $1, issued_at = now(), updated_at = now() where id = $2`, [to, statement.id]);
          await issueInvoice(db, ctx, statement, req.auth?.displayName);
        } else if (to === 'SETTLED') {
          await db.query(`update statement_of_account set status = $1, settled_at = now(), updated_at = now() where id = $2`, [to, statement.id]);
        } else {
          await db.query(`update statement_of_account set status = $1, updated_at = now() where id = $2`, [to, statement.id]);
        }

        await writeAudit(db, ctx, {
          action: 'transition',
          entityType: 'statement_of_account',
          entityId: statement.id,
          before: { status: statement.status },
          after: { status: to },
          actorLabel: req.auth?.displayName,
        });
        return { id: statement.id, status: to };
      });
    },
  );

  // AR/AP aging: bucket outstanding invoices by days past due through the tested
  // domain engine. kind=AR (default) ages receivables, kind=AP ages payables.
  app.get<{ Querystring: { kind?: string; asOf?: string } }>(
    '/api/statements/aging',
    { preHandler: requirePermission('statement:read') },
    async (req) => {
      const ctx = authContext(req);
      const kind = String(req.query.kind ?? 'AR').toUpperCase() === 'AP' ? 'AP' : 'AR';
      const table = kind === 'AP' ? 'ap_invoice' : 'ar_invoice';
      const asOf = (req.query.asOf ?? new Date().toISOString()).slice(0, 10);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          id: string;
          party_id: string | null;
          currency: string;
          amount_minor: number;
          settled_minor: number;
          due_date: string | null;
          status: string;
        }>(
          // to_char keeps the date as ISO text: node-postgres would otherwise
          // hand back a JS Date whose String() ("Fri Jul 31 ...") fails the
          // domain engine's strict ISO validation (defect D-3).
          `select id, party_id, currency, amount_minor, settled_minor,
                  to_char(due_date, 'YYYY-MM-DD') as due_date, status
             from ${table} where status <> 'SETTLED'`,
        );
        const items: AgingItem[] = rows
          .filter((r) => r.due_date != null)
          .map((r) => ({
            ref: r.id,
            outstandingMinor: Number(r.amount_minor) - Number(r.settled_minor),
            dueDate: r.due_date as string,
          }));
        const report = agingReport(items, asOf);
        return { kind, ...report };
      });
    },
  );
}

/**
 * On issue, spin off the matching sub-ledger invoice: a positive balance is owed
 * by the cedent to the reinsurer (AR); a negative balance is owed the other way (AP).
 */
async function issueInvoice(
  db: Db,
  ctx: { tenantId: string; userId: string },
  statement: { id: string; balance_minor: number; currency: string; counterparty_id: string | null },
  actorLabel?: string,
): Promise<void> {
  const balance = statement.balance_minor;
  if (balance === 0) return;

  if (balance > 0) {
    const reference = await nextReference(db, ctx.tenantId, 'ar_invoice_reference', 'ARI');
    const { rows } = await db.query<{ id: string }>(
      `insert into ar_invoice
         (tenant_id, reference, party_id, statement_id, currency, amount_minor, due_date, status)
       values ($1,$2,$3,$4,$5,$6, current_date + 30, 'OPEN') returning id`,
      [ctx.tenantId, reference, statement.counterparty_id, statement.id, statement.currency, balance],
    );
    await writeAudit(db, ctx, {
      action: 'create',
      entityType: 'ar_invoice',
      entityId: rows[0]!.id,
      after: { statementId: statement.id, amountMinor: balance, currency: statement.currency },
      actorLabel,
    });
  } else {
    const reference = await nextReference(db, ctx.tenantId, 'ap_invoice_reference', 'API');
    const { rows } = await db.query<{ id: string }>(
      `insert into ap_invoice
         (tenant_id, reference, party_id, statement_id, currency, amount_minor, due_date, status)
       values ($1,$2,$3,$4,$5,$6, current_date + 30, 'OPEN') returning id`,
      [ctx.tenantId, reference, statement.counterparty_id, statement.id, statement.currency, Math.abs(balance)],
    );
    await writeAudit(db, ctx, {
      action: 'create',
      entityType: 'ap_invoice',
      entityId: rows[0]!.id,
      after: { statementId: statement.id, amountMinor: Math.abs(balance), currency: statement.currency },
      actorLabel,
    });
  }
}
