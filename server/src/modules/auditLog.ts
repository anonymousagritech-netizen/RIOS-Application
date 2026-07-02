/**
 * Audit log / activity timeline (brief §14.3 / Operations). A read-only view over
 * the hash-chained, append-only audit_log: every material change across RIOS
 * (create / bind / post / confirm / referral / task…) is recorded with actor,
 * before/after and a tamper-evident row hash. This module surfaces it as a
 * filterable timeline and a per-entity activity feed, so the platform's history
 * is transparent and every module's actions are visible in one place.
 *
 * Reads gate on ops:read (operations / audit). Append-only: no writes here.
 */

import type { FastifyInstance } from 'fastify';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { parsePaginationQuery, encodeCursor, decodeCursor } from '../lib/pagination.js';

interface AuditRow {
  id: string; occurred_at: string; actor_label: string | null; action: string;
  entity_type: string; entity_id: string | null; context: Record<string, unknown> | null;
  row_hash: string | null; before: unknown; after: unknown;
}

const shape = (r: AuditRow) => ({
  id: String(r.id), occurredAt: r.occurred_at, actor: r.actor_label, action: r.action,
  entityType: r.entity_type, entityId: r.entity_id,
  viaAssistant: Boolean(r.context && (r.context as { assistant?: boolean }).assistant),
  tamperEvident: r.row_hash != null,
  before: r.before, after: r.after,
});

export async function auditLogModule(app: FastifyInstance): Promise<void> {
  // ---- Timeline (filterable) -----------------------------------------------
  app.get<{ Querystring: { entityType?: string; action?: string; limit?: string; cursor?: string } }>('/api/audit', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    const { entityType, action } = req.query;
    // audit_log.id is a bigint sequence — use it directly as the keyset cursor.
    // The shared pagination contract caps at 200; the pre-existing default was 100.
    const { limit, cursor } = parsePaginationQuery({ ...req.query, limit: req.query.limit ?? 100 } as Record<string, unknown>);
    const decoded = cursor ? decodeCursor(cursor) : null;
    return runAs(ctx, async (db) => {
      const params: unknown[] = [entityType ?? null, action ?? null];
      let cursorClause = '';
      if (decoded) {
        params.push(decoded.id); // id stored in both parts of the cursor
        cursorClause = `AND id < $3::bigint`;
      }
      const { rows } = await db.query<AuditRow>(
        `select id, occurred_at, actor_label, action, entity_type, entity_id, context, row_hash, before, after
           from audit_log
          where ($1::text is null or entity_type = $1)
            and ($2::text is null or action = $2)
            ${cursorClause}
          order by id desc
          limit ${limit + 1}`,
        params,
      );
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const last = rows[rows.length - 1];
      // Encode the bigint id in both cursor fields (createdAt slot holds the id string).
      const nextCursor = hasMore && last
        ? encodeCursor(String(last.id), String(last.id))
        : null;
      // Distinct entity types + actions for the filter chips (bounded).
      const facets = await db.query<{ kind: string; val: string; n: number }>(
        `select 'entity' kind, entity_type val, count(*)::int n from audit_log group by entity_type
         union all
         select 'action' kind, action val, count(*)::int n from audit_log group by action
         order by n desc`,
      );
      const chainLen = await db.query<{ n: string; hashed: string }>(
        `select count(*)::bigint n, count(row_hash)::bigint hashed from audit_log`,
      );
      return {
        entries: rows.map(shape),
        nextCursor,
        entityTypes: facets.rows.filter((f) => f.kind === 'entity').map((f) => ({ key: f.val, n: f.n })),
        actions: facets.rows.filter((f) => f.kind === 'action').map((f) => ({ key: f.val, n: f.n })),
        chain: { total: Number(chainLen.rows[0]!.n), hashed: Number(chainLen.rows[0]!.hashed) },
      };
    });
  });

  // ---- Per-entity activity feed (cross-module timeline for one record) ------
  app.get<{ Params: { type: string; id: string } }>('/api/audit/entity/:type/:id', { preHandler: requirePermission('ops:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<AuditRow>(
        `select id, occurred_at, actor_label, action, entity_type, entity_id, context, row_hash, before, after
           from audit_log where entity_type = $1 and entity_id = $2 order by id desc limit 100`,
        [req.params.type, req.params.id],
      );
      return { entries: rows.map(shape) };
    });
  });
}
