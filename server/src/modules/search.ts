/**
 * Global search & indexing (brief §11.3 — search everywhere). A single
 * tenant-scoped query surface across the core entities. Each entity type is only
 * searched when the caller holds its read permission (admin:manage sees all), so
 * results never leak past RBAC. Runs inside runAs, so RLS scopes every row to the
 * tenant. This is a live ILIKE search over the source tables — honest about being
 * a query, not a separate inverted index (a real deployment would add one, §11.3).
 */

import type { FastifyInstance } from 'fastify';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

export interface SearchHit {
  type: string;
  id: string;
  label: string;
  sublabel?: string | null;
  ref?: string | null;
  url: string;
}

interface Source {
  type: string;
  permission: string;
  /** Returns hits for the term; `like` is the pre-built '%term%' pattern. */
  run: (db: Db, like: string, limit: number) => Promise<SearchHit[]>;
}

const SOURCES: Source[] = [
  {
    type: 'party', permission: 'party:read',
    run: async (db, like, limit) => {
      const { rows } = await db.query(
        `select id, reference, legal_name as "legalName", short_name as "shortName", kind
           from party where not is_deleted
            and (legal_name ilike $1 or short_name ilike $1 or reference ilike $1)
          order by legal_name limit $2`,
        [like, limit],
      );
      return rows.map((r) => ({
        type: 'party', id: r.id, label: r.shortName ?? r.legalName, sublabel: r.kind, ref: r.reference,
        url: `/parties/${r.id}`,
      }));
    },
  },
  {
    type: 'contract', permission: 'treaty:read',
    run: async (db, like, limit) => {
      const { rows } = await db.query(
        `select id, reference, name, contract_kind as "contractKind", status
           from contract where not is_deleted
            and (name ilike $1 or reference ilike $1)
          order by created_at desc limit $2`,
        [like, limit],
      );
      return rows.map((r) => ({
        type: 'contract', id: r.id, label: r.name, sublabel: `${r.contractKind} · ${r.status}`, ref: r.reference,
        url: `/treaties/${r.id}`,
      }));
    },
  },
  {
    type: 'claim', permission: 'claims:read',
    run: async (db, like, limit) => {
      const { rows } = await db.query(
        `select id, reference, description, status
           from claim where not is_deleted
            and (reference ilike $1 or description ilike $1)
          order by notified_date desc limit $2`,
        [like, limit],
      );
      return rows.map((r) => ({
        type: 'claim', id: r.id, label: r.reference ?? r.description ?? 'Claim', sublabel: r.status, ref: r.reference,
        url: `/claims/${r.id}`,
      }));
    },
  },
  {
    type: 'statement', permission: 'statement:read',
    run: async (db, like, limit) => {
      const { rows } = await db.query(
        `select id, reference, status, currency
           from statement_of_account where reference ilike $1
          order by created_at desc limit $2`,
        [like, limit],
      );
      return rows.map((r) => ({
        type: 'statement', id: r.id, label: r.reference ?? 'Statement', sublabel: `${r.status} · ${r.currency}`, ref: r.reference,
        url: '/statements',
      }));
    },
  },
];

export async function searchModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search',
    { preHandler: requirePermission() },
    async (req) => {
      const ctx = authContext(req);
      const q = (req.query.q ?? '').trim();
      if (q.length < 2) return { query: q, results: [], groups: [] };

      const perms = req.auth?.permissions ?? [];
      const isAdmin = perms.includes('admin:manage');
      const allowed = SOURCES.filter((s) => isAdmin || perms.includes(s.permission));
      const perTypeLimit = Math.min(Number(req.query.limit) || 5, 20);
      const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;

      return runAs(ctx, async (db) => {
        const groups: { type: string; hits: SearchHit[] }[] = [];
        for (const s of allowed) {
          const hits = await s.run(db, like, perTypeLimit);
          if (hits.length) groups.push({ type: s.type, hits });
        }
        return { query: q, results: groups.flatMap((g) => g.hits), groups };
      });
    },
  );
}
