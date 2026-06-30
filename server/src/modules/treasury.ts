/**
 * Treasury, investments & tax (brief §9, §13). Manages the investment portfolio
 * backing reserves and the configurable premium-tax / levy stack. All valuation
 * and levy maths run in the pure @rios/domain engines (portfolioSummary,
 * computeLevies); this module only orchestrates persistence and exposes the
 * computed views. Money is integer minor units. Reads need treasury:read;
 * mutations need treasury:write and are audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { portfolioSummary, computeLevies, type Holding, type Levy } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const holdingSchema = z.object({
  name: z.string().min(1),
  portfolio: z.string().default('GENERAL'),
  instrumentType: z.enum(['BOND', 'BILL', 'EQUITY', 'CASH', 'FUND']),
  currency: z.string().length(3),
  faceValueMinor: z.number().int().nonnegative().default(0),
  bookValueMinor: z.number().int().nonnegative().default(0),
  marketValueMinor: z.number().int().nonnegative().default(0),
  couponRate: z.number().nonnegative().nullable().optional(),
  maturityDate: z.string().nullable().optional(),
});

const levySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  jurisdiction: z.string().nullable().optional(),
  rate: z.number().nonnegative(),
  basis: z.string().default('premium'),
  active: z.boolean().default(true),
});

export async function treasuryModule(app: FastifyInstance): Promise<void> {
  // List holdings plus a domain-computed portfolio summary (per currency).
  app.get('/api/treasury/holdings', { preHandler: requirePermission('treasury:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, portfolio, name, instrument_type as "instrumentType", currency,
                face_value_minor as "faceValueMinor", book_value_minor as "bookValueMinor",
                market_value_minor as "marketValueMinor", coupon_rate as "couponRate",
                maturity_date as "maturityDate", status
           from investment_holding
          where status = 'HELD'
          order by book_value_minor desc`,
      );
      // Summarise per currency so we never cross-add (the domain helper throws otherwise).
      const byCcy = new Map<string, Holding[]>();
      for (const r of rows as Holding[]) {
        const list = byCcy.get(r.currency) ?? [];
        list.push(r);
        byCcy.set(r.currency, list);
      }
      const summaries = [...byCcy.entries()].map(([currency, list]) => ({ currency, ...portfolioSummary(list) }));
      return { holdings: rows, summaries };
    });
  });

  app.post('/api/treasury/holdings', { preHandler: requirePermission('treasury:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = holdingSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid holding', details: parsed.error.flatten() };
    }
    const h = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into investment_holding
           (tenant_id, portfolio, name, instrument_type, currency, face_value_minor,
            book_value_minor, market_value_minor, coupon_rate, maturity_date, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [ctx.tenantId, h.portfolio, h.name, h.instrumentType, h.currency, h.faceValueMinor,
         h.bookValueMinor, h.marketValueMinor, h.couponRate ?? null, h.maturityDate ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'investment_holding', entityId: rows[0]!.id,
        after: { name: h.name, instrumentType: h.instrumentType, bookValueMinor: h.bookValueMinor },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // List the active levy configuration.
  app.get('/api/treasury/levies', { preHandler: requirePermission('treasury:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, code, name, jurisdiction, rate, basis, active
           from tax_levy order by active desc, code`,
      );
      return { levies: rows };
    });
  });

  app.post('/api/treasury/levies', { preHandler: requirePermission('treasury:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = levySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid levy', details: parsed.error.flatten() };
    }
    const l = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into tax_levy (tenant_id, code, name, jurisdiction, rate, basis, active)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, code) do update set
           name = excluded.name, jurisdiction = excluded.jurisdiction,
           rate = excluded.rate, basis = excluded.basis, active = excluded.active
         returning id`,
        [ctx.tenantId, l.code, l.name, l.jurisdiction ?? null, l.rate, l.basis, l.active],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'tax_levy', entityId: rows[0]!.id,
        after: { code: l.code, rate: l.rate, active: l.active }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Compute the levy stack on a premium base using the active levies.
  app.post<{ Body: { baseMinor: number; basis?: string } }>(
    '/api/treasury/levies/compute',
    { preHandler: requirePermission('treasury:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const baseMinor = Number(req.body?.baseMinor);
      if (!Number.isFinite(baseMinor) || baseMinor < 0) {
        reply.code(400);
        return { error: 'baseMinor must be a non-negative number' };
      }
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<Levy & { basis: string }>(
          `select code, name, rate::float8 as rate, basis from tax_levy where active order by code`,
        );
        const applicable = req.body?.basis ? rows.filter((r) => r.basis === req.body!.basis) : rows;
        return { result: computeLevies(Math.round(baseMinor), applicable) };
      });
    },
  );
}
