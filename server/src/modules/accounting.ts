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

  // ---------------------------------------------------------------------------
  // GL Journal drill-down: paginated list of posted journal entries (P2-05)
  // ---------------------------------------------------------------------------
  app.get<{
    Querystring: { from?: string; to?: string; treatyRef?: string; eventType?: string; page?: string; limit?: string };
  }>(
    '/api/accounting/journals',
    { preHandler: requirePermission('accounting:read') },
    async (req) => {
      const ctx = authContext(req);
      const { from, to, treatyRef, eventType } = req.query;
      const pageLimit = Math.min(Number(req.query.limit) || 25, 100);
      const pageOffset = (Math.max(Number(req.query.page) || 0, 0)) * pageLimit;

      return runAs(ctx, async (db) => {
        // Build dynamic filter for parameterized query
        const conditions: string[] = ['lp_dr.debit_minor > 0'];
        const params: unknown[] = [];
        let p = 0;
        const add = (v: unknown) => { params.push(v); return `$${++p}`; };

        if (from) conditions.push(`j.posted_at >= ${add(from)}::date`);
        if (to)   conditions.push(`j.posted_at <= ${add(to)}::date`);
        if (treatyRef) conditions.push(`c.reference ILIKE ${add(`%${treatyRef}%`)}`);
        if (eventType) conditions.push(`fe.event_type = ${add(eventType)}`);

        const limitP  = add(pageLimit + 1);
        const offsetP = add(pageOffset);

        const { rows } = await db.query<{
          journal_reference: string | null;
          posted_at: string;
          currency: string;
          treaty_reference: string | null;
          event_type: string | null;
          debit_account: string | null;
          credit_account: string | null;
          amount_minor: number;
        }>(
          `SELECT
             j.reference       AS journal_reference,
             j.posted_at::text AS posted_at,
             lp_dr.currency,
             c.reference       AS treaty_reference,
             fe.event_type,
             dr_acc.code       AS debit_account,
             cr_acc.code       AS credit_account,
             lp_dr.debit_minor AS amount_minor
           FROM ledger_posting lp_dr
           JOIN journal       j      ON j.id      = lp_dr.journal_id
           JOIN gl_account    dr_acc ON dr_acc.id = lp_dr.gl_account_id
           LEFT JOIN ledger_posting lp_cr
                  ON lp_cr.journal_id      = lp_dr.journal_id
                 AND lp_cr.source_event_id = lp_dr.source_event_id
                 AND lp_cr.credit_minor    > 0
           LEFT JOIN gl_account    cr_acc ON cr_acc.id = lp_cr.gl_account_id
           LEFT JOIN financial_event fe   ON fe.id     = lp_dr.source_event_id
           LEFT JOIN contract        c    ON c.id      = fe.contract_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY j.posted_at DESC, lp_dr.id ASC
           LIMIT ${limitP} OFFSET ${offsetP}`,
          params,
        );

        const hasMore = rows.length > pageLimit;
        if (hasMore) rows.pop();
        return {
          entries: rows.map((r) => ({
            journalReference: r.journal_reference,
            postedAt: r.posted_at,
            currency: r.currency,
            treatyReference: r.treaty_reference,
            eventType: r.event_type,
            debitAccount: r.debit_account,
            creditAccount: r.credit_account,
            amountMinor: Number(r.amount_minor),
          })),
          hasMore,
          page: Math.max(Number(req.query.page) || 0, 0),
        };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Trial balance: aggregated account balances for a period (P2-05)
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/accounting/trial-balance',
    { preHandler: requirePermission('accounting:read') },
    async (req) => {
      const ctx = authContext(req);
      // Default: current month
      const now = new Date();
      const from = req.query.from ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const to   = req.query.to   ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;

      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          account_code: string;
          account_name: string;
          debit_minor: number;
          credit_minor: number;
          net_minor: number;
        }>(
          `SELECT
             ga.code AS account_code,
             ga.name AS account_name,
             SUM(lp.debit_minor)                         AS debit_minor,
             SUM(lp.credit_minor)                        AS credit_minor,
             SUM(lp.debit_minor) - SUM(lp.credit_minor) AS net_minor
           FROM ledger_posting lp
           JOIN gl_account ga ON ga.id = lp.gl_account_id
           JOIN journal    j  ON j.id  = lp.journal_id
           WHERE j.posted_at BETWEEN $1::date AND $2::date
           GROUP BY ga.code, ga.name
           ORDER BY ga.code`,
          [from, to],
        );

        return {
          rows: rows.map((r) => ({
            accountCode:  r.account_code,
            accountName:  r.account_name,
            debitMinor:   Number(r.debit_minor),
            creditMinor:  Number(r.credit_minor),
            netMinor:     Number(r.net_minor),
          })),
          from,
          to,
        };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // CSV export of GL journal entries (P2-05)
  // ---------------------------------------------------------------------------
  app.get<{
    Querystring: { from?: string; to?: string; treatyRef?: string; eventType?: string };
  }>(
    '/api/accounting/export.csv',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const { from, to, treatyRef, eventType } = req.query;

      return runAs(ctx, async (db) => {
        const conditions: string[] = ['lp_dr.debit_minor > 0'];
        const params: unknown[] = [];
        let p = 0;
        const add = (v: unknown) => { params.push(v); return `$${++p}`; };

        if (from) conditions.push(`j.posted_at >= ${add(from)}::date`);
        if (to)   conditions.push(`j.posted_at <= ${add(to)}::date`);
        if (treatyRef) conditions.push(`c.reference ILIKE ${add(`%${treatyRef}%`)}`);
        if (eventType) conditions.push(`fe.event_type = ${add(eventType)}`);

        const { rows } = await db.query<{
          journal_reference: string | null;
          posted_at: string;
          currency: string;
          treaty_reference: string | null;
          event_type: string | null;
          debit_account: string | null;
          credit_account: string | null;
          amount_minor: number;
        }>(
          `SELECT
             j.reference       AS journal_reference,
             j.posted_at::text AS posted_at,
             lp_dr.currency,
             c.reference       AS treaty_reference,
             fe.event_type,
             dr_acc.code       AS debit_account,
             cr_acc.code       AS credit_account,
             lp_dr.debit_minor AS amount_minor
           FROM ledger_posting lp_dr
           JOIN journal       j      ON j.id      = lp_dr.journal_id
           JOIN gl_account    dr_acc ON dr_acc.id = lp_dr.gl_account_id
           LEFT JOIN ledger_posting lp_cr
                  ON lp_cr.journal_id      = lp_dr.journal_id
                 AND lp_cr.source_event_id = lp_dr.source_event_id
                 AND lp_cr.credit_minor    > 0
           LEFT JOIN gl_account    cr_acc ON cr_acc.id = lp_cr.gl_account_id
           LEFT JOIN financial_event fe   ON fe.id     = lp_dr.source_event_id
           LEFT JOIN contract        c    ON c.id      = fe.contract_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY j.posted_at DESC, lp_dr.id ASC
           LIMIT 10000`,
          params,
        );

        const escape = (v: unknown) => {
          const s = v == null ? '' : String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n')
            ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = 'Journal Reference,Posted At,Currency,Treaty Reference,Event Type,Debit Account,Credit Account,Amount';
        const csvRows = rows.map((r) =>
          [
            r.journal_reference, r.posted_at, r.currency, r.treaty_reference,
            r.event_type, r.debit_account, r.credit_account,
            (Number(r.amount_minor) / 100).toFixed(2),
          ].map(escape).join(','),
        );
        const csv = [header, ...csvRows].join('\r\n');

        void reply.header('Content-Type', 'text/csv; charset=utf-8');
        void reply.header('Content-Disposition', 'attachment; filename="gl-journal.csv"');
        return reply.send(csv);
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Unposted financial events (not yet in any ledger_posting) (P2-05)
  // ---------------------------------------------------------------------------
  app.get(
    '/api/accounting/unposted',
    { preHandler: requirePermission('accounting:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          id: string;
          contract_id: string;
          contract_reference: string | null;
          contract_name: string;
          event_type: string;
          direction: string;
          amount_minor: number;
          currency: string;
          booked_at: string;
          narrative: string | null;
        }>(
          `SELECT
             fe.id,
             fe.contract_id,
             c.reference   AS contract_reference,
             c.name        AS contract_name,
             fe.event_type,
             fe.direction,
             fe.amount_minor,
             fe.currency,
             fe.booked_at::text AS booked_at,
             fe.narrative
           FROM financial_event fe
           JOIN contract c ON c.id = fe.contract_id AND NOT c.is_deleted
           WHERE NOT EXISTS (
             SELECT 1 FROM ledger_posting lp WHERE lp.source_event_id = fe.id
           )
           ORDER BY fe.booked_at, fe.created_at
           LIMIT 500`,
        );

        return {
          events: rows.map((r) => ({
            id: r.id,
            contractId: r.contract_id,
            contractReference: r.contract_reference,
            contractName: r.contract_name,
            eventType: r.event_type,
            direction: r.direction,
            amountMinor: Number(r.amount_minor),
            currency: r.currency,
            bookedAt: r.booked_at,
            narrative: r.narrative,
          })),
          count: rows.length,
        };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Post ALL unposted events across all contracts (P2-05)
  // ---------------------------------------------------------------------------
  app.post(
    '/api/accounting/post-all',
    { preHandler: requirePermission('accounting:post') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        // Find all contracts that have at least one unposted financial event
        const { rows: contractRows } = await db.query<{ contract_id: string }>(
          `SELECT DISTINCT fe.contract_id
           FROM financial_event fe
           WHERE NOT EXISTS (
             SELECT 1 FROM ledger_posting lp WHERE lp.source_event_id = fe.id
           )
           ORDER BY fe.contract_id`,
        );

        if (contractRows.length === 0) {
          return { posted: 0, journals: 0, message: 'Nothing to post' };
        }

        const accounts = await accountMap(db);
        let totalPosted = 0;
        const journalIds: string[] = [];

        for (const { contract_id } of contractRows) {
          const { contract, events } = await loadEvents(db, contract_id);
          if (!contract) continue;

          const postedIds = new Set(
            (
              await db.query<{ source_event_id: string }>(
                `SELECT DISTINCT source_event_id FROM ledger_posting
                  WHERE source_event_id IS NOT NULL AND source_event_id = ANY($1::uuid[])`,
                [events.map((e) => e.id)],
              )
            ).rows.map((r) => r.source_event_id),
          );

          const toPost = events.filter((e) => !postedIds.has(e.id));
          if (toPost.length === 0) continue;

          const journal = await db.query<{ id: string }>(
            `INSERT INTO journal (tenant_id, reference, description, currency, source, created_by)
             VALUES ($1, $2, $3, $4, 'technical_accounting', $5) RETURNING id`,
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
              `INSERT INTO ledger_posting (tenant_id, journal_id, gl_account_id, debit_minor, credit_minor, currency, source_event_id, narrative)
               VALUES ($1,$2,$3,$4,0,$5,$6,$7), ($1,$2,$8,0,$4,$5,$6,$7)`,
              [ctx.tenantId, journalId, drAcc, e.amount.amount, contract.currency, e.id, e.type, crAcc],
            );
          }

          await writeAudit(db, ctx, {
            action: 'post',
            entityType: 'journal',
            entityId: journalId,
            after: { events: toPost.length, contractId: contract.id },
            actorLabel: (req as { auth?: { displayName?: string } }).auth?.displayName,
          });

          totalPosted += toPost.length;
          journalIds.push(journalId);
        }

        return { posted: totalPosted, journals: journalIds.length, journalIds };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Existing per-treaty endpoints (below)
  // ---------------------------------------------------------------------------

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
