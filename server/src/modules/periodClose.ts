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
}
