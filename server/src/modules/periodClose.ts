/**
 * Period-close module (brief §9.8, §7.6).
 *
 * Accounting periods are opened, then closed (locked) at month/quarter end and
 * may be reopened with audit. FX revaluation restates non-base-currency balances
 * at current rates via @rios/domain `revalue`, summing the gain/loss in the base
 * currency and recording the per-currency working. Money on the wire is MAJOR
 * units (balances), converted to minor via `fromMajor`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { revalue, fromMajor, money } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createPeriodSchema = z.object({
  code: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

const fxRevalueSchema = z.object({
  baseCurrency: z.string().length(3),
  asAt: z.string().optional(),
  balances: z
    .array(
      z.object({
        currency: z.string().length(3),
        amount: z.number(),
        bookedRate: z.number().positive(),
        currentRate: z.number().positive(),
      }),
    )
    .default([]),
});

// ---- Governed period-close orchestration (workbook gap; migration 0066) -------
//
// A period_close runs the standard close checklist in order. Each step is
// executed by CALLING the real engine already in the server (the UPR/DAC run,
// the SOA verifier, the FX revaluation, the trial-balance tie-out) over an
// internal HTTP inject that forwards the caller's token - so the engine's own
// permission gate, audit and persistence run unchanged and the close never
// re-implements the maths. When every non-SKIPPED step is DONE the close may be
// LOCKED; a LOCKED close may be REOPENED with an audited reason.

/** The fixed close checklist, in order, naming the real engine each step invokes. */
const CLOSE_STEPS: { key: string; sequence: number; engine: string }[] = [
  { key: 'UPR_DAC', sequence: 1, engine: 'POST /api/accounting/upr/run' },
  { key: 'SOA_VERIFY', sequence: 2, engine: 'POST /api/statements/:id/verify' },
  { key: 'FX_REVAL', sequence: 3, engine: 'POST /api/finance/fx-revalue' },
  { key: 'GL_TIE_OUT', sequence: 4, engine: 'GET /api/finance/trial-balance' },
];

const openCloseSchema = z.object({
  period: z.string().min(1),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be YYYY-MM-DD'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
});
const runStepSchema = z.object({ stepKey: z.string().min(1) });
const reopenSchema = z.object({ reason: z.string().min(1) });

export async function periodCloseModule(app: FastifyInstance): Promise<void> {
  // List accounting periods.
  app.get('/api/finance/periods', { preHandler: requirePermission('finance:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, code, start_date as "startDate", end_date as "endDate", status,
                closed_by as "closedBy", closed_at as "closedAt", created_at as "createdAt"
           from accounting_period order by start_date desc, code desc`,
      );
      return { periods: rows };
    });
  });

  // Open a new accounting period.
  app.post('/api/finance/periods', { preHandler: requirePermission('finance:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createPeriodSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid period', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into accounting_period (tenant_id, code, start_date, end_date, status)
         values ($1,$2,$3,$4,'open') returning id`,
        [ctx.tenantId, b.code, b.startDate, b.endDate],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'accounting_period',
        entityId: id,
        after: { code: b.code, status: 'open' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, code: b.code, status: 'open' };
    });
  });

  // Close (lock) a period.
  app.post<{ Params: { id: string } }>(
    '/api/finance/periods/:id/close',
    { preHandler: requirePermission('finance:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(
          `select status from accounting_period where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Period not found' };
        }
        if (cur.rows[0].status === 'closed') {
          reply.code(409);
          return { error: 'Period is already closed' };
        }
        await db.query(
          `update accounting_period set status = 'closed', closed_by = $2, closed_at = now() where id = $1`,
          [req.params.id, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'close',
          entityType: 'accounting_period',
          entityId: req.params.id,
          before: { status: cur.rows[0].status },
          after: { status: 'closed' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'closed' };
      });
    },
  );

  // Reopen a previously closed period.
  app.post<{ Params: { id: string } }>(
    '/api/finance/periods/:id/reopen',
    { preHandler: requirePermission('finance:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(
          `select status from accounting_period where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) {
          reply.code(404);
          return { error: 'Period not found' };
        }
        await db.query(`update accounting_period set status = 'reopened' where id = $1`, [req.params.id]);
        await writeAudit(db, ctx, {
          action: 'reopen',
          entityType: 'accounting_period',
          entityId: req.params.id,
          before: { status: cur.rows[0].status },
          after: { status: 'reopened' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'reopened' };
      });
    },
  );

  // FX revaluation run (§7.6): restate non-base balances and book the net gain/loss.
  app.post('/api/finance/fx-revalue', { preHandler: requirePermission('finance:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = fxRevalueSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid FX revaluation', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const base = b.baseCurrency.toUpperCase();

    let totalMinor = 0;
    const detail: Array<{
      currency: string;
      amountMinor: number;
      bookedRate: number;
      currentRate: number;
      atBookedMinor: number;
      atCurrentMinor: number;
      gainLossMinor: number;
    }> = [];

    for (const bal of b.balances) {
      if (bal.currency.toUpperCase() === base) continue;
      const original = fromMajor(bal.amount, bal.currency);
      const r = revalue(original, base, bal.bookedRate, bal.currentRate);
      totalMinor += r.gainLoss.amount;
      detail.push({
        currency: bal.currency.toUpperCase(),
        amountMinor: original.amount,
        bookedRate: bal.bookedRate,
        currentRate: bal.currentRate,
        atBookedMinor: r.atBooked.amount,
        atCurrentMinor: r.atCurrent.amount,
        gainLossMinor: r.gainLoss.amount,
      });
    }

    const gainLoss = money(totalMinor, base);

    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into fx_revaluation (tenant_id, as_at, base_currency, gain_loss_minor, detail, created_by)
         values ($1, coalesce($2, current_date), $3, $4, $5, $6) returning id`,
        [ctx.tenantId, b.asAt ?? null, base, gainLoss.amount, JSON.stringify(detail), ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'fx_revaluation',
        entityId: id,
        after: { baseCurrency: base, gainLossMinor: gainLoss.amount },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, gainLossMinor: gainLoss.amount, detail };
    });
  });

  // List past revaluations.
  app.get('/api/finance/fx-revaluations', { preHandler: requirePermission('finance:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, as_at as "asAt", base_currency as "baseCurrency",
                gain_loss_minor as "gainLossMinor", detail, created_at as "createdAt"
           from fx_revaluation order by as_at desc, created_at desc`,
      );
      return { revaluations: rows };
    });
  });

  // Open a governed period close with the standard checklist seeded PENDING.
  app.post('/api/period-close', { preHandler: requirePermission('finance:post') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = openCloseSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid period close', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const ins = await db.query<{ id: string }>(
        `insert into period_close (tenant_id, period, period_start, period_end, status, created_by)
         values ($1,$2,$3,$4,'OPEN',$5) returning id`,
        [ctx.tenantId, b.period, b.periodStart, b.periodEnd, ctx.userId],
      );
      const id = ins.rows[0]!.id;
      for (const s of CLOSE_STEPS) {
        await db.query(
          `insert into period_close_step (tenant_id, close_id, step_key, status, sequence)
           values ($1,$2,$3,'PENDING',$4)`,
          [ctx.tenantId, id, s.key, s.sequence],
        );
      }
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'period_close',
        entityId: id,
        after: { period: b.period, status: 'OPEN', steps: CLOSE_STEPS.map((s) => s.key) },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return {
        id,
        period: b.period,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        status: 'OPEN',
        steps: CLOSE_STEPS.map((s) => ({ stepKey: s.key, sequence: s.sequence, status: 'PENDING', engine: s.engine })),
      };
    });
  });

  // Run one close step by invoking its real engine over an internal inject.
  app.post<{ Params: { id: string } }>(
    '/api/period-close/:id/run-step',
    { preHandler: requirePermission('finance:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = runStepSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid run-step request', details: parsed.error.flatten() };
      }
      const stepKey = parsed.data.stepKey;

      // Read the close + target step (and, for SOA_VERIFY, the in-period
      // statements) in a tenant transaction before touching the engine.
      const loaded = await runAs(ctx, async (db) => {
        const c = await db.query<{
          id: string; period: string; period_start: string; period_end: string; status: string;
        }>(
          `select id, period, to_char(period_start,'YYYY-MM-DD') as period_start,
                  to_char(period_end,'YYYY-MM-DD') as period_end, status
             from period_close where id = $1`,
          [req.params.id],
        );
        if (!c.rows[0]) return { kind: 'notfound' as const };
        const close = c.rows[0];
        const s = await db.query<{ id: string; step_key: string; status: string }>(
          `select id, step_key, status from period_close_step where close_id = $1 and step_key = $2`,
          [req.params.id, stepKey],
        );
        if (!s.rows[0]) return { kind: 'nostep' as const };
        let statementIds: string[] = [];
        if (stepKey === 'SOA_VERIFY') {
          const st = await db.query<{ id: string }>(
            `select id from statement_of_account
              where period_start is not null and period_end is not null
                and period_start >= $1::date and period_end <= $2::date
              order by created_at`,
            [close.period_start, close.period_end],
          );
          statementIds = st.rows.map((r) => r.id);
        }
        return { kind: 'ok' as const, close, step: s.rows[0], statementIds };
      });

      if (loaded.kind === 'notfound') {
        reply.code(404);
        return { error: 'Period close not found' };
      }
      if (loaded.kind === 'nostep') {
        reply.code(404);
        return { error: `Unknown close step ${stepKey}` };
      }
      if (loaded.close.status === 'LOCKED') {
        reply.code(409);
        return { error: 'Period close is LOCKED; reopen it before running steps' };
      }

      const authHeader = req.headers.authorization;
      const headers = authHeader ? { authorization: authHeader } : {};

      let status: 'DONE' | 'FAILED' | 'SKIPPED';
      let detail: Record<string, unknown>;

      if (stepKey === 'UPR_DAC') {
        // Real engine: the UPR/DAC accrual as of the period end.
        const engine = 'POST /api/accounting/upr/run';
        const r = await app.inject({
          method: 'POST',
          url: '/api/accounting/upr/run',
          headers,
          payload: { asOf: loaded.close.period_end },
        });
        const body = r.json();
        if (r.statusCode === 201) {
          status = 'DONE';
          detail = {
            engine,
            uprRunId: body.id,
            asOf: body.asOf,
            lineCount: body.lineCount,
            totalsByCurrency: body.totalsByCurrency,
          };
        } else {
          status = 'FAILED';
          detail = { engine, httpStatus: r.statusCode, error: body };
        }
      } else if (stepKey === 'SOA_VERIFY') {
        // Real engine: recompute + verify each statement that falls in the period.
        const engine = 'POST /api/statements/:id/verify';
        if (loaded.statementIds.length === 0) {
          status = 'DONE';
          detail = { engine, statements: 0, note: 'no statements fall within the close period; nothing to verify' };
        } else {
          let verified = 0, deviations = 0, failed = 0, httpErrors = 0;
          const results: Array<Record<string, unknown>> = [];
          for (const sid of loaded.statementIds) {
            const r = await app.inject({ method: 'POST', url: `/api/statements/${sid}/verify`, headers, payload: {} });
            if (r.statusCode === 201) {
              const b = r.json();
              if (b.status === 'VERIFIED') verified++;
              else if (b.status === 'DEVIATIONS') deviations++;
              else failed++;
              results.push({ statementId: sid, status: b.status, verificationId: b.id });
            } else {
              httpErrors++;
              results.push({ statementId: sid, httpStatus: r.statusCode });
            }
          }
          status = httpErrors > 0 ? 'FAILED' : 'DONE';
          detail = { engine, statements: loaded.statementIds.length, verified, deviations, failed, httpErrors, results };
        }
      } else if (stepKey === 'FX_REVAL') {
        // The FX revaluation engine (POST /api/finance/fx-revalue) is wired and
        // callable, but it expects the open non-base-currency balances and their
        // booked/current rates in the request body. Automatically gathering those
        // from the GL and an FX-rate source into a close-driven reval run is NOT
        // wired, so this step is honestly SKIPPED rather than faked DONE with an
        // empty (zero gain/loss) run. Follow-on: wire the balance + rate source.
        status = 'SKIPPED';
        detail = {
          engine: 'POST /api/finance/fx-revalue',
          note:
            'FX revaluation engine is available and callable, but automatic gathering of open ' +
            'non-base-currency GL balances and their booked/current rates into a close-driven reval ' +
            'is not wired. Run POST /api/finance/fx-revalue manually with balances (follow-on).',
        };
      } else if (stepKey === 'GL_TIE_OUT') {
        // Real engine: the trial balance proves the GL self-balances.
        const engine = 'GET /api/finance/trial-balance';
        const r = await app.inject({ method: 'GET', url: '/api/finance/trial-balance', headers });
        const body = r.json();
        if (r.statusCode === 200 && body.balanced === true) {
          status = 'DONE';
          detail = {
            engine,
            totalDebitsMinor: body.totalDebitsMinor,
            totalCreditsMinor: body.totalCreditsMinor,
            balanced: true,
            accounts: Array.isArray(body.accounts) ? body.accounts.length : null,
          };
        } else {
          status = 'FAILED';
          detail = {
            engine,
            httpStatus: r.statusCode,
            balanced: body.balanced ?? false,
            totalDebitsMinor: body.totalDebitsMinor,
            totalCreditsMinor: body.totalCreditsMinor,
          };
        }
      } else {
        reply.code(400);
        return { error: `Step ${stepKey} has no engine binding` };
      }

      return runAs(ctx, async (db) => {
        await db.query(
          `update period_close_step set status = $3, detail = $4, ran_at = now()
            where close_id = $1 and step_key = $2`,
          [req.params.id, stepKey, status, JSON.stringify(detail)],
        );
        // First executed step moves the close from OPEN/REOPENED to IN_PROGRESS.
        await db.query(
          `update period_close set status = 'IN_PROGRESS' where id = $1 and status in ('OPEN','REOPENED')`,
          [req.params.id],
        );
        await writeAudit(db, ctx, {
          action: 'run',
          entityType: 'period_close_step',
          entityId: loaded.step.id,
          before: { status: loaded.step.status },
          after: { stepKey, status, engine: detail.engine },
          actorLabel: req.auth?.displayName,
        });
        reply.code(200);
        return { closeId: req.params.id, stepKey, status, detail };
      });
    },
  );

  // Lock the close: 409 unless every non-SKIPPED step is DONE.
  app.post<{ Params: { id: string } }>(
    '/api/period-close/:id/lock',
    { preHandler: requirePermission('finance:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const c = await db.query<{ status: string }>(
          `select status from period_close where id = $1`,
          [req.params.id],
        );
        if (!c.rows[0]) {
          reply.code(404);
          return { error: 'Period close not found' };
        }
        if (c.rows[0].status === 'LOCKED') {
          reply.code(409);
          return { error: 'Period close is already LOCKED' };
        }
        const outstanding = await db.query<{ step_key: string; status: string }>(
          `select step_key, status from period_close_step
            where close_id = $1 and status not in ('DONE','SKIPPED') order by sequence`,
          [req.params.id],
        );
        if (outstanding.rows.length > 0) {
          reply.code(409);
          return {
            error: 'Cannot lock: not every step is DONE or SKIPPED',
            outstanding: outstanding.rows.map((r) => ({ stepKey: r.step_key, status: r.status })),
          };
        }
        await db.query(
          `update period_close set status = 'LOCKED', locked_by = $2, locked_at = now() where id = $1`,
          [req.params.id, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'lock',
          entityType: 'period_close',
          entityId: req.params.id,
          before: { status: c.rows[0].status },
          after: { status: 'LOCKED' },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'LOCKED' };
      });
    },
  );

  // Reopen a LOCKED close with an audited reason.
  app.post<{ Params: { id: string } }>(
    '/api/period-close/:id/reopen',
    { preHandler: requirePermission('finance:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = reopenSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid reopen request (a reason is required)', details: parsed.error.flatten() };
      }
      return runAs(ctx, async (db) => {
        const c = await db.query<{ status: string }>(
          `select status from period_close where id = $1`,
          [req.params.id],
        );
        if (!c.rows[0]) {
          reply.code(404);
          return { error: 'Period close not found' };
        }
        if (c.rows[0].status !== 'LOCKED') {
          reply.code(409);
          return { error: 'Only a LOCKED period close can be reopened' };
        }
        await db.query(
          `update period_close set status = 'REOPENED', reopen_reason = $2, locked_by = null, locked_at = null
            where id = $1`,
          [req.params.id, parsed.data.reason],
        );
        await writeAudit(db, ctx, {
          action: 'reopen',
          entityType: 'period_close',
          entityId: req.params.id,
          before: { status: c.rows[0].status },
          after: { status: 'REOPENED', reason: parsed.data.reason },
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'REOPENED', reason: parsed.data.reason };
      });
    },
  );

  // List period closes with a step-status summary.
  app.get('/api/period-close', { preHandler: requirePermission('finance:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select pc.id, pc.period,
                to_char(pc.period_start,'YYYY-MM-DD') as "periodStart",
                to_char(pc.period_end,'YYYY-MM-DD') as "periodEnd",
                pc.status, pc.locked_by as "lockedBy", pc.locked_at as "lockedAt",
                pc.created_at as "createdAt",
                count(s.*) filter (where s.status = 'DONE')    as "stepsDone",
                count(s.*) filter (where s.status = 'SKIPPED') as "stepsSkipped",
                count(s.*)                                     as "stepsTotal"
           from period_close pc
           left join period_close_step s on s.close_id = pc.id
          group by pc.id
          order by pc.period_start desc, pc.created_at desc`,
      );
      return { closes: rows };
    });
  });

  // One period close with its ordered checklist.
  app.get<{ Params: { id: string } }>(
    '/api/period-close/:id',
    { preHandler: requirePermission('finance:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const c = await db.query(
          `select id, period,
                  to_char(period_start,'YYYY-MM-DD') as "periodStart",
                  to_char(period_end,'YYYY-MM-DD') as "periodEnd",
                  status, created_by as "createdBy", locked_by as "lockedBy",
                  locked_at as "lockedAt", reopen_reason as "reopenReason", created_at as "createdAt"
             from period_close where id = $1`,
          [req.params.id],
        );
        if (!c.rows[0]) {
          reply.code(404);
          return { error: 'Period close not found' };
        }
        const steps = await db.query(
          `select id, step_key as "stepKey", status, sequence, detail,
                  ran_at as "ranAt"
             from period_close_step where close_id = $1 order by sequence`,
          [req.params.id],
        );
        return { ...c.rows[0], steps: steps.rows };
      });
    },
  );
}
