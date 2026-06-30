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

  // Add a code value WITHOUT a deployment — the core configurability proof (§10, §20).
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
        `select code, name, minor_units as "minorUnits", symbol from currency where is_active order by code`,
      );
      return { currencies: rows };
    });
  });
}
