/**
 * Reference-data / configuration module (brief §10.3).
 * Serves code lists, currencies and config documents from the database so the
 * UI and rules are driven by metadata, never literals in source.
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

export async function referenceModule(app: FastifyInstance): Promise<void> {
  // All code lists with their active values, keyed by list key.
  app.get('/api/config/code-lists', { preHandler: requirePermission('config:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        key: string;
        code: string;
        label: string;
        meta: Record<string, unknown>;
        sort_order: number;
      }>(
        `select cl.key, cv.code, cv.label, cv.meta, cv.sort_order
           from code_value cv join code_list cl on cl.id = cv.code_list_id
          where cv.is_active
            and (cv.effective_to is null or cv.effective_to > current_date)
          order by cl.key, cv.sort_order`,
      );
      const lists: Record<string, { code: string; label: string; meta: Record<string, unknown>; sortOrder: number }[]> = {};
      for (const r of rows) {
        (lists[r.key] ??= []).push({ code: r.code, label: r.label, meta: r.meta, sortOrder: r.sort_order });
      }
      return { lists };
    });
  });

  // A single code list by key.
  app.get<{ Params: { key: string } }>(
    '/api/config/code-lists/:key',
    { preHandler: requirePermission('config:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select cv.code, cv.label, cv.meta, cv.sort_order as "sortOrder"
             from code_value cv join code_list cl on cl.id = cv.code_list_id
            where cl.key = $1 and cv.is_active
            order by cv.sort_order`,
          [req.params.key],
        );
        return { key: req.params.key, values: rows };
      });
    },
  );

  // Add a code value WITHOUT a deployment - the core configurability proof (§10, §20).
  app.post<{ Params: { key: string }; Body: { code: string; label: string; meta?: Record<string, unknown> } }>(
    '/api/config/code-lists/:key/values',
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const { code, label, meta } = req.body;
      if (!code || !label) {
        reply.code(400);
        return { error: 'code and label are required' };
      }
      return runAs(ctx, async (db) => {
        const list = await db.query<{ id: string }>(
          `select id from code_list where key = $1`,
          [req.params.key],
        );
        if (!list.rows[0]) {
          reply.code(404);
          return { error: `Unknown code list: ${req.params.key}` };
        }
        const { rows } = await db.query(
          `insert into code_value (tenant_id, code_list_id, code, label, meta, sort_order)
           values ($1, $2, $3, $4, $5, coalesce((select max(sort_order)+1 from code_value where code_list_id=$2), 1))
           returning code, label, meta`,
          [ctx.tenantId, list.rows[0].id, code, label, JSON.stringify(meta ?? {})],
        );
        return rows[0];
      });
    },
  );

  app.get('/api/config/currencies', { preHandler: requirePermission('config:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select code, name, minor_units as "minorUnits", symbol, is_active as "isActive"
           from currency where tenant_id = $1 order by code`,
        [ctx.tenantId],
      );
      return { currencies: rows };
    });
  });

  // Add or reactivate a currency — gated on config:write (admin:manage overrides).
  app.post<{
    Body: { code: string; name: string; symbol?: string; minorUnits?: number };
  }>('/api/config/currencies', { preHandler: requirePermission('config:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const { code, name, symbol, minorUnits = 2 } = req.body;
    if (!code || !name) {
      reply.code(400);
      return { error: 'code and name are required' };
    }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `insert into currency (tenant_id, code, name, symbol, minor_units)
         values ($1, upper($2), $3, $4, $5)
         on conflict (tenant_id, code) do update
           set name = excluded.name,
               symbol = coalesce(excluded.symbol, currency.symbol),
               minor_units = excluded.minor_units,
               is_active = true
         returning code, name, symbol, minor_units as "minorUnits", is_active as "isActive"`,
        [ctx.tenantId, code, name, symbol ?? null, minorUnits],
      );
      reply.code(201);
      return rows[0];
    });
  });

  // Exchange rates — most-recent rate per currency pair (DISTINCT ON).
  app.get('/api/config/exchange-rates', { preHandler: requirePermission('config:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select distinct on (from_ccy, to_ccy)
                id, from_ccy as "fromCcy", to_ccy as "toCcy",
                rate::float as rate, rate_date as "rateDate", source
           from exchange_rate
          where tenant_id = $1
          order by from_ccy, to_ccy, rate_date desc`,
        [ctx.tenantId],
      );
      return { rates: rows };
    });
  });

  // Upsert an exchange rate for a given date — gated on config:write.
  app.post<{
    Body: { fromCcy: string; toCcy: string; rate: number; rateDate?: string };
  }>('/api/config/exchange-rates', { preHandler: requirePermission('config:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const { fromCcy, toCcy, rate, rateDate } = req.body;
    if (!fromCcy || !toCcy || rate == null) {
      reply.code(400);
      return { error: 'fromCcy, toCcy and rate are required' };
    }
    if (Number(rate) <= 0) {
      reply.code(400);
      return { error: 'rate must be positive' };
    }
    const effectiveDate = rateDate ?? new Date().toISOString().slice(0, 10);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `insert into exchange_rate (tenant_id, from_ccy, to_ccy, rate, rate_date)
         values ($1, upper($2), upper($3), $4, $5::date)
         on conflict (tenant_id, from_ccy, to_ccy, rate_date) do update
           set rate = excluded.rate
         returning id, from_ccy as "fromCcy", to_ccy as "toCcy",
                   rate::float as rate, rate_date as "rateDate", source`,
        [ctx.tenantId, fromCcy, toCcy, rate, effectiveDate],
      );
      reply.code(201);
      return rows[0];
    });
  });
}
