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
import {
  portfolioSummary, computeLevies, bucketCashFlows,
  type Holding, type Levy, type ScheduledCashItem,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
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

const tradeSchema = z.object({
  instrument: z.string().min(1),
  tradeType: z.enum(['BUY', 'SELL']),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  settleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  quantity: z.number().positive(),
  priceMinor: z.number().int().nonnegative(),
  feesMinor: z.number().int().nonnegative().default(0),
  currency: z.string().length(3),
  counterpartyPartyId: z.string().uuid().nullable().optional(),
});

const forecastSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horizonDays: z.number().int().positive(),
  bucketDays: z.number().int().positive().default(30),
  currency: z.string().length(3).default('USD'),
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

  // ===========================================================================
  // Dealing / settlement sub-ledger (brief §13). Capture -> confirm -> settle;
  // settlement posts a balanced GL journal (cash 1000 <-> investment asset 1200)
  // replicating the accounting.ts journal+posting idiom locally.
  // ===========================================================================
  app.post('/api/treasury/trades', { preHandler: requirePermission('treasury:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = tradeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid trade', details: parsed.error.flatten() };
    }
    const t = parsed.data;
    // gross = qty*price + fees (integer minor; a quantity*price scalar, not money add).
    const grossMinor = Math.round(t.quantity * t.priceMinor) + t.feesMinor;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into investment_trade
           (tenant_id, instrument, trade_type, trade_date, settle_date, quantity, price_minor,
            gross_minor, fees_minor, currency, status, counterparty_party_id, created_by)
         values ($1,$2,$3,coalesce($4::date,current_date),coalesce($5::date,current_date),
                 $6,$7,$8,$9,$10,'CAPTURED',$11,$12)
         returning id`,
        [ctx.tenantId, t.instrument, t.tradeType, t.tradeDate ?? null, t.settleDate ?? null,
         t.quantity, t.priceMinor, grossMinor, t.feesMinor, t.currency, t.counterpartyPartyId ?? null, ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'investment_trade', entityId: id,
        after: { instrument: t.instrument, tradeType: t.tradeType, grossMinor, status: 'CAPTURED' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, status: 'CAPTURED', grossMinor };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/treasury/trades/:id/confirm',
    { preHandler: requirePermission('treasury:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const trade = await loadTrade(db, req.params.id);
        if (!trade) { reply.code(404); return { error: 'Trade not found' }; }
        if (trade.status !== 'CAPTURED') {
          reply.code(409);
          return { error: `Cannot confirm a ${trade.status} trade`, status: trade.status };
        }
        await db.query(`update investment_trade set status = 'CONFIRMED' where id = $1`, [trade.id]);
        await writeAudit(db, ctx, {
          action: 'confirm', entityType: 'investment_trade', entityId: trade.id,
          before: { status: 'CAPTURED' }, after: { status: 'CONFIRMED' }, actorLabel: req.auth?.displayName,
        });
        return { id: trade.id, status: 'CONFIRMED' };
      });
    },
  );

  // Settle a confirmed trade: book a balanced journal and mark SETTLED. Illegal
  // transitions (settling a non-CONFIRMED trade, incl. a double-settle) -> 409.
  app.post<{ Params: { id: string } }>(
    '/api/treasury/trades/:id/settle',
    { preHandler: requirePermission('treasury:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const trade = await loadTrade(db, req.params.id);
        if (!trade) { reply.code(404); return { error: 'Trade not found' }; }
        if (trade.status !== 'CONFIRMED') {
          reply.code(409);
          return { error: `Cannot settle a ${trade.status} trade`, status: trade.status };
        }
        const accounts = await accountMap(db);
        const cashAcc = accounts.get('1000');       // Cash at Bank
        const invAcc = accounts.get('1200');         // Investments (asset)
        if (!cashAcc || !invAcc) {
          reply.code(409);
          return { error: 'Settlement accounts (1000 cash / 1200 investments) not found in chart' };
        }
        // BUY: cash out, investment up  -> Dr 1200 / Cr 1000.
        // SELL: investment down, cash in -> Dr 1000 / Cr 1200.
        const drAcc = trade.trade_type === 'BUY' ? invAcc : cashAcc;
        const crAcc = trade.trade_type === 'BUY' ? cashAcc : invAcc;

        const journal = await db.query<{ id: string }>(
          `insert into journal (tenant_id, reference, description, currency, source, created_by)
           values ($1,$2,$3,$4,'treasury_dealing',$5) returning id`,
          [ctx.tenantId, `TRD-${trade.id.slice(0, 8)}`,
           `Settlement of ${trade.trade_type} ${trade.instrument}`, trade.currency, ctx.userId],
        );
        const journalId = journal.rows[0]!.id;
        await db.query(
          `insert into ledger_posting (tenant_id, journal_id, gl_account_id, debit_minor, credit_minor, currency, narrative)
           values ($1,$2,$3,$4,0,$5,$6), ($1,$2,$7,0,$4,$5,$6)`,
          [ctx.tenantId, journalId, drAcc, trade.gross_minor, trade.currency,
           `${trade.trade_type} ${trade.instrument}`, crAcc],
        );
        await db.query(
          `update investment_trade set status = 'SETTLED', journal_id = $2 where id = $1`,
          [trade.id, journalId],
        );
        await writeAudit(db, ctx, {
          action: 'settle', entityType: 'investment_trade', entityId: trade.id,
          before: { status: 'CONFIRMED' },
          after: { status: 'SETTLED', journalId, grossMinor: trade.gross_minor }, actorLabel: req.auth?.displayName,
        });
        return { id: trade.id, status: 'SETTLED', journalId, grossMinor: trade.gross_minor };
      });
    },
  );

  app.get('/api/treasury/trades', { preHandler: requirePermission('treasury:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, instrument, trade_type as "tradeType",
                to_char(trade_date,'YYYY-MM-DD') as "tradeDate",
                to_char(settle_date,'YYYY-MM-DD') as "settleDate",
                quantity::float8 as quantity, price_minor as "priceMinor", gross_minor as "grossMinor",
                fees_minor as "feesMinor", currency, status,
                counterparty_party_id as "counterpartyPartyId", journal_id as "journalId",
                to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "createdAt"
           from investment_trade order by trade_date desc, created_at desc`,
      );
      return { trades: rows };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/treasury/trades/:id',
    { preHandler: requirePermission('treasury:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, instrument, trade_type as "tradeType",
                  to_char(trade_date,'YYYY-MM-DD') as "tradeDate",
                  to_char(settle_date,'YYYY-MM-DD') as "settleDate",
                  quantity::float8 as quantity, price_minor as "priceMinor", gross_minor as "grossMinor",
                  fees_minor as "feesMinor", currency, status,
                  counterparty_party_id as "counterpartyPartyId", journal_id as "journalId"
             from investment_trade where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) { reply.code(404); return { error: 'Trade not found' }; }
        return rows[0];
      });
    },
  );

  // ===========================================================================
  // Market data. RIOS ships a DETERMINISTIC MOCK provider (source='MOCK') that
  // prices the instruments the portfolio holds/trades. A real vendor feed
  // (Bloomberg / Refinitiv / ICE) is the integration seam that would replace the
  // mock generator - it would write market_price rows with its own source label.
  // ===========================================================================
  app.post('/api/treasury/market-data/refresh', { preHandler: requirePermission('treasury:write') }, async (req) => {
    const ctx = authContext(req);
    const body = (req.body ?? {}) as { asOf?: string };
    const asOf = typeof body.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) ? body.asOf : null;
    return runAs(ctx, async (db) => {
      // Held/traded instruments: names of live holdings plus any instrument dealt.
      const { rows: instruments } = await db.query<{ instrument: string; currency: string }>(
        `select distinct instrument, currency from (
           select name as instrument, currency from investment_holding where status = 'HELD'
           union
           select instrument, currency from investment_trade
         ) s order by instrument`,
      );
      const prices: Array<{ instrument: string; priceMinor: number; currency: string }> = [];
      for (const inst of instruments) {
        const priceMinor = mockPriceMinor(inst.instrument);
        await db.query(
          `insert into market_price (tenant_id, instrument, as_of, price_minor, currency, source)
           values ($1,$2,coalesce($3::date,current_date),$4,$5,'MOCK')
           on conflict (tenant_id, instrument, as_of, source)
             do update set price_minor = excluded.price_minor, created_at = now()`,
          [ctx.tenantId, inst.instrument, asOf, priceMinor, inst.currency],
        );
        prices.push({ instrument: inst.instrument, priceMinor, currency: inst.currency });
      }
      await writeAudit(db, ctx, {
        action: 'refresh', entityType: 'market_price', entityId: ctx.tenantId,
        after: { count: prices.length, source: 'MOCK' }, actorLabel: req.auth?.displayName,
      });
      return {
        source: 'MOCK',
        note: 'Deterministic in-repo mock provider. Replace with a real market-data feed at this integration seam; the endpoint contract is unchanged.',
        refreshed: prices.length,
        prices,
      };
    });
  });

  app.get<{ Querystring: { instrument?: string } }>(
    '/api/treasury/market-data',
    { preHandler: requirePermission('treasury:read') },
    async (req) => {
      const ctx = authContext(req);
      const instrument = req.query?.instrument;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, instrument, to_char(as_of,'YYYY-MM-DD') as "asOf",
                  price_minor as "priceMinor", currency, source
             from market_price
            where ($1::text is null or instrument = $1)
            order by instrument, as_of desc`,
          [instrument ?? null],
        );
        return { prices: rows };
      });
    },
  );

  // ===========================================================================
  // Cash-flow forecast. Gathers scheduled cash items (premium/claim financial
  // events + investment-trade settlements) and buckets them via the pure
  // @rios/domain bucketCashFlows engine, then persists the forecast + lines.
  // ===========================================================================
  app.post('/api/treasury/cash-flow-forecast', { preHandler: requirePermission('treasury:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = forecastSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid forecast request', details: parsed.error.flatten() };
    }
    const { asOf, horizonDays, bucketDays, currency } = parsed.data;
    return runAs(ctx, async (db) => {
      const items = await gatherCashItems(db, asOf, horizonDays, currency);
      const result = bucketCashFlows({ asOf, horizonDays, bucketDays, currency, items });

      const header = await db.query<{ id: string }>(
        `insert into cash_flow_forecast (tenant_id, as_of, horizon_days, currency, created_by)
         values ($1,$2::date,$3,$4,$5) returning id`,
        [ctx.tenantId, asOf, horizonDays, currency, ctx.userId],
      );
      const forecastId = header.rows[0]!.id;
      for (const b of result.buckets) {
        await db.query(
          `insert into cash_flow_forecast_line
             (tenant_id, forecast_id, bucket_date, inflow_minor, outflow_minor, net_minor, currency, source)
           values ($1,$2,$3::date,$4,$5,$6,$7,$8)`,
          [ctx.tenantId, forecastId, b.bucketDate, b.inflowMinor, b.outflowMinor, b.netMinor, b.currency, b.source],
        );
      }
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'cash_flow_forecast', entityId: forecastId,
        after: { asOf, horizonDays, buckets: result.buckets.length, netMinor: result.netMinor },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: forecastId, ...result };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/treasury/cash-flow-forecast/:id',
    { preHandler: requirePermission('treasury:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const h = await db.query<{ id: string; asOf: string; horizonDays: number; currency: string }>(
          `select id, to_char(as_of,'YYYY-MM-DD') as "asOf", horizon_days as "horizonDays", currency
             from cash_flow_forecast where id = $1`,
          [req.params.id],
        );
        if (!h.rows[0]) { reply.code(404); return { error: 'Forecast not found' }; }
        const { rows: lines } = await db.query(
          `select to_char(bucket_date,'YYYY-MM-DD') as "bucketDate",
                  inflow_minor as "inflowMinor", outflow_minor as "outflowMinor",
                  net_minor as "netMinor", currency, source
             from cash_flow_forecast_line where forecast_id = $1 order by bucket_date`,
          [req.params.id],
        );
        const totalInflowMinor = lines.reduce((s, l) => s + Number(l.inflowMinor), 0);
        const totalOutflowMinor = lines.reduce((s, l) => s + Number(l.outflowMinor), 0);
        return {
          ...h.rows[0],
          buckets: lines,
          totalInflowMinor,
          totalOutflowMinor,
          netMinor: totalInflowMinor - totalOutflowMinor,
        };
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Dealing / forecast helpers (kept local; they replicate - not import - the
// accounting.ts posting idiom, per the module boundary).
// ---------------------------------------------------------------------------

interface TradeRow {
  id: string;
  trade_type: 'BUY' | 'SELL';
  instrument: string;
  gross_minor: number;
  currency: string;
  status: string;
}

async function loadTrade(db: Db, id: string): Promise<TradeRow | null> {
  const { rows } = await db.query<TradeRow>(
    `select id, trade_type, instrument, gross_minor, currency, status from investment_trade where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function accountMap(db: Db): Promise<Map<string, string>> {
  const { rows } = await db.query<{ code: string; id: string }>(`select code, id from gl_account`);
  return new Map(rows.map((r) => [r.code, r.id]));
}

/** Deterministic pseudo-price for the mock market-data provider: stable per instrument. */
function mockPriceMinor(instrument: string): number {
  let h = 2166136261;
  for (let i = 0; i < instrument.length; i++) {
    h ^= instrument.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map the hash into a plausible clean-price band 50.00 .. 150.00 (minor units).
  const band = Math.abs(h) % 10000; // 0 .. 9999 -> 0.00 .. 99.99
  return 5000 + band; // 50.00 .. 149.99
}

// Financial-event types classified for cash direction (technical mapping, same
// spirit as accounting.ts POSTING_RULES). Unknown types are skipped.
const PREMIUM_INFLOW = new Set([
  'DEPOSIT_PREMIUM', 'INSTALMENT_PREMIUM', 'ADJUSTMENT_PREMIUM', 'REINSTATEMENT_PREMIUM', 'MINIMUM_PREMIUM', 'RECOVERY',
]);
const CLAIM_OUTFLOW = new Set(['PAID_LOSS', 'CASH_LOSS']);
const EXPENSE_OUTFLOW = new Set([
  'CEDING_COMMISSION', 'OVERRIDING_COMMISSION', 'PROFIT_COMMISSION', 'BROKERAGE', 'TAX',
]);

/** Gather scheduled cash items (financial events + trade settlements) in the window. */
async function gatherCashItems(db: Db, asOf: string, horizonDays: number, currency: string): Promise<ScheduledCashItem[]> {
  const items: ScheduledCashItem[] = [];

  const { rows: fe } = await db.query<{ date: string; event_type: string; amount_minor: number }>(
    `select to_char(booked_at,'YYYY-MM-DD') as date, event_type, amount_minor
       from financial_event
      where currency = $1 and booked_at >= $2::date and booked_at < ($2::date + ($3 || ' days')::interval)`,
    [currency, asOf, String(horizonDays)],
  );
  for (const e of fe) {
    const type = e.event_type.toUpperCase();
    if (PREMIUM_INFLOW.has(type)) {
      items.push({ date: e.date, direction: 'INFLOW', amountMinor: Number(e.amount_minor), currency, source: 'PREMIUM' });
    } else if (CLAIM_OUTFLOW.has(type)) {
      items.push({ date: e.date, direction: 'OUTFLOW', amountMinor: Number(e.amount_minor), currency, source: 'CLAIM' });
    } else if (EXPENSE_OUTFLOW.has(type)) {
      items.push({ date: e.date, direction: 'OUTFLOW', amountMinor: Number(e.amount_minor), currency, source: 'EXPENSE' });
    }
  }

  const { rows: tr } = await db.query<{ date: string; trade_type: 'BUY' | 'SELL'; gross_minor: number }>(
    `select to_char(settle_date,'YYYY-MM-DD') as date, trade_type, gross_minor
       from investment_trade
      where currency = $1 and status <> 'CANCELLED'
        and settle_date >= $2::date and settle_date < ($2::date + ($3 || ' days')::interval)`,
    [currency, asOf, String(horizonDays)],
  );
  for (const t of tr) {
    items.push({
      date: t.date,
      direction: t.trade_type === 'BUY' ? 'OUTFLOW' : 'INFLOW',
      amountMinor: Number(t.gross_minor),
      currency,
      source: 'TRADE',
    });
  }

  return items;
}
