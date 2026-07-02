/**
 * Accounting module (brief §7.6, §9.8).
 *
 * Builds statements of account from immutable Financial Events and posts them to
 * the GL as balanced double-entry journals, then proves the technical→financial
 * chain reconciles using @rios/domain. The control account movement must equal
 * the statement balance (the reconciliation contract of §7.6 / §27).
 */

import type { FastifyInstance } from 'fastify';
import {
  buildStatement,
  reconcile,
  type FinancialEvent as DomainEvent,
  money,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { parsePaginationQuery, encodeCursor, decodeCursor } from '../lib/pagination.js';

const CONTROL_ACCOUNT = '1100'; // Reinsurance Debtors (Control)

/**
 * Posting rules: each financial-event type maps to the GL leg that faces the
 * counterparty (the control account) plus its income/expense leg. Configurable
 * reference data in the full platform (§10); a sound default here.
 */
const POSTING_RULES: Record<string, { drAccount: string; crAccount: string }> = {
  DEPOSIT_PREMIUM:        { drAccount: CONTROL_ACCOUNT, crAccount: '4000' },
  INSTALMENT_PREMIUM:     { drAccount: CONTROL_ACCOUNT, crAccount: '4000' },
  ADJUSTMENT_PREMIUM:     { drAccount: CONTROL_ACCOUNT, crAccount: '4000' },
  REINSTATEMENT_PREMIUM:  { drAccount: CONTROL_ACCOUNT, crAccount: '4000' },
  MINIMUM_PREMIUM:        { drAccount: CONTROL_ACCOUNT, crAccount: '4000' },
  CEDING_COMMISSION:      { drAccount: '5000', crAccount: CONTROL_ACCOUNT },
  OVERRIDING_COMMISSION:  { drAccount: '5000', crAccount: CONTROL_ACCOUNT },
  PROFIT_COMMISSION:      { drAccount: '5000', crAccount: CONTROL_ACCOUNT },
  BROKERAGE:              { drAccount: '5000', crAccount: CONTROL_ACCOUNT },
  TAX:                    { drAccount: '5000', crAccount: CONTROL_ACCOUNT },
  PAID_LOSS:              { drAccount: '5100', crAccount: CONTROL_ACCOUNT },
  CASH_LOSS:              { drAccount: '5100', crAccount: CONTROL_ACCOUNT },
  RECOVERY:               { drAccount: CONTROL_ACCOUNT, crAccount: '5100' },
};

export async function accountingModule(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/api/treaties/:id/financial-events',
    { preHandler: requirePermission('accounting:read') },
    async (req) => {
      const ctx = authContext(req);
      const { limit, cursor } = parsePaginationQuery(req.query as Record<string, unknown>);
      const decoded = cursor ? decodeCursor(cursor) : null;
      return runAs(ctx, async (db) => {
        // Keyset on (booked_at ASC, id ASC): financial events are ordered chronologically.
        // Cursor uses booked_at (timestamptz cast to text) + id (uuid) for stable ordering.
        const params: unknown[] = [req.params.id];
        let cursorClause = '';
        if (decoded) {
          params.push(decoded.createdAt, decoded.id);
          cursorClause = `AND (booked_at, id) > ($2::timestamptz, $3::uuid)`;
        }
        const { rows } = await db.query<{ id: string; bookedAt: string } & Record<string, unknown>>(
          `select id, contract_id as "contractId", event_type as "eventType", direction,
                  amount_minor as "amountMinor", currency, booked_at::text as "bookedAt", narrative
             from financial_event
            where contract_id = $1
              ${cursorClause}
            order by booked_at asc, id asc
            limit ${limit + 1}`,
          params,
        );
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        const last = rows[rows.length - 1];
        const nextCursor = hasMore && last ? encodeCursor(last.bookedAt, last.id) : null;
        return { events: rows, nextCursor };
      });
    },
  );

  // Build the statement of account for a contract and report whether the chain reconciles.
  app.get<{ Params: { id: string } }>(
    '/api/treaties/:id/statement',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { contract, events } = await loadEvents(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        const statement = buildStatement(events, contract.currency);

        // Reconcile against any posted ledger movements on the control account.
        const postings = await loadControlPostings(db, req.params.id, contract.currency);
        const rec = reconcile(statement, postings, CONTROL_ACCOUNT);

        return {
          contractId: req.params.id,
          currency: statement.currency,
          balanceMinor: statement.balance.amount,
          eventCount: statement.eventCount,
          lines: statement.lines.map((l) => ({ type: l.type, count: l.count, totalMinor: l.total.amount })),
          posted: postings.length > 0,
          reconciled: postings.length === 0 ? null : rec.reconciled,
          controlMovementMinor: rec.controlAccountMovement.amount,
        };
      });
    },
  );

  // Post all not-yet-posted financial events of a contract to the GL as balanced journals.
  app.post<{ Params: { id: string } }>(
    '/api/treaties/:id/post',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { contract, events } = await loadEvents(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        const accounts = await accountMap(db);

        // Only post events not already linked to a posting.
        const postedIds = new Set(
          (
            await db.query<{ source_event_id: string }>(
              `select distinct source_event_id from ledger_posting
                where source_event_id is not null and source_event_id = any($1::uuid[])`,
              [events.map((e) => e.id)],
            )
          ).rows.map((r) => r.source_event_id),
        );
        const toPost = events.filter((e) => !postedIds.has(e.id));
        if (toPost.length === 0) {
          return { posted: 0, message: 'All events already posted' };
        }

        const journal = await db.query<{ id: string }>(
          `insert into journal (tenant_id, reference, description, currency, source, created_by)
           values ($1, $2, $3, $4, 'technical_accounting', $5) returning id`,
          [ctx.tenantId, `JNL-${contract.reference ?? contract.id.slice(0, 8)}`, `Technical accounting for ${contract.name}`, contract.currency, ctx.userId],
        );
        const journalId = journal.rows[0]!.id;

        for (const e of toPost) {
          const rule = POSTING_RULES[e.type];
          if (!rule) continue;
          const drAcc = accounts.get(rule.drAccount);
          const crAcc = accounts.get(rule.crAccount);
          if (!drAcc || !crAcc) continue;
          await db.query(
            `insert into ledger_posting (tenant_id, journal_id, gl_account_id, debit_minor, credit_minor, currency, source_event_id, narrative)
             values ($1,$2,$3,$4,0,$5,$6,$7), ($1,$2,$8,0,$4,$5,$6,$7)`,
            [ctx.tenantId, journalId, drAcc, e.amount.amount, contract.currency, e.id, e.type, crAcc],
          );
        }

        await writeAudit(db, ctx, {
          action: 'post',
          entityType: 'journal',
          entityId: journalId,
          after: { events: toPost.length, contractId: contract.id },
          actorLabel: req.auth?.displayName,
        });

        // Re-verify reconciliation after posting.
        const statement = buildStatement(events, contract.currency);
        const postings = await loadControlPostings(db, req.params.id, contract.currency);
        const rec = reconcile(statement, postings, CONTROL_ACCOUNT);

        return {
          journalId,
          posted: toPost.length,
          reconciled: rec.reconciled,
          statementBalanceMinor: statement.balance.amount,
          controlMovementMinor: rec.controlAccountMovement.amount,
        };
      });
    },
  );
}

async function loadEvents(
  db: Db,
  contractId: string,
): Promise<{ contract: { id: string; name: string; currency: string; reference: string | null } | null; events: DomainEvent[] }> {
  const c = await db.query<{ id: string; name: string; currency: string; reference: string | null }>(
    `select id, name, currency, reference from contract where id = $1 and not is_deleted`,
    [contractId],
  );
  if (!c.rows[0]) return { contract: null, events: [] };

  const { rows } = await db.query<{
    id: string;
    contract_id: string;
    event_type: string;
    direction: 'DR' | 'CR';
    amount_minor: number;
    currency: string;
    booked_at: string;
  }>(
    `select id, contract_id, event_type, direction, amount_minor, currency, booked_at
       from financial_event where contract_id = $1 order by booked_at, created_at`,
    [contractId],
  );
  const events: DomainEvent[] = rows.map((r) => ({
    id: r.id,
    contractId: r.contract_id,
    type: r.event_type as DomainEvent['type'],
    amount: money(r.amount_minor, r.currency),
    direction: r.direction,
    bookedAt: String(r.booked_at),
  }));
  return { contract: c.rows[0], events };
}

async function loadControlPostings(db: Db, contractId: string, currency: string) {
  const { rows } = await db.query<{ account: string; debit_minor: number; credit_minor: number }>(
    `select ga.code as account, lp.debit_minor, lp.credit_minor
       from ledger_posting lp
       join gl_account ga on ga.id = lp.gl_account_id
       join financial_event fe on fe.id = lp.source_event_id
      where fe.contract_id = $1`,
    [contractId],
  );
  if (rows.length === 0) return [];
  // All legs for the contract form one balanced set (each journal balances), so a
  // single posting suffices; reconcile() reads the control-account legs from it.
  return [
    {
      sourceEventIds: [],
      legs: rows.map((r) => ({
        account: r.account,
        debit: money(r.debit_minor, currency),
        credit: money(r.credit_minor, currency),
      })),
    },
  ];
}

async function accountMap(db: Db): Promise<Map<string, string>> {
  const { rows } = await db.query<{ code: string; id: string }>(`select code, id from gl_account`);
  return new Map(rows.map((r) => [r.code, r.id]));
}
