/**
 * Global Search enhancements (brief §29). Saved searches, a per-user search
 * history, type-ahead suggestions and natural-language search on top of the base
 * /api/search. The NL parser (@rios/domain/nlSearch) turns free text into
 * structured filters deterministically (no LLM); results come from the same
 * sources the base search uses, then filtered by the parsed intent.
 *
 * Saved/history/NL are per-user, gated only on authentication (requirePermission()).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseSearchQuery, describeParsedSearch, type SearchEntityType } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

interface Hit { type: string; title: string; subtitle?: string; url: string }

// Mirror the base search sources so NL search can reuse them (kept intentionally
// small and read-only; permission-filtered by the caller's grants).
const SOURCES: { type: SearchEntityType; permission: string; run: (db: Db, like: string, status: string | null, year: number | null, limit: number) => Promise<Hit[]> }[] = [
  {
    type: 'treaty', permission: 'treaty:read',
    run: async (db, like, status, year, limit) => {
      const { rows } = await db.query<{ id: string; reference: string; name: string; status: string }>(
        `select id, reference, name, status from contract
          where not is_deleted and (reference ilike $1 or name ilike $1)
            and ($2::text is null or status = $2)
            and ($3::int is null or extract(year from period_start) = $3)
          order by created_at desc limit $4`, [like, status, year, limit]);
      return rows.map((r) => ({ type: 'treaty', title: `${r.reference} · ${r.name}`, subtitle: r.status, url: `/treaties/${r.id}` }));
    },
  },
  {
    type: 'party', permission: 'party:read',
    run: async (db, like, _s, _y, limit) => {
      const { rows } = await db.query<{ id: string; short_name: string; legal_name: string }>(
        `select id, short_name, legal_name from party where not is_deleted and (short_name ilike $1 or legal_name ilike $1)
          order by short_name limit $2`, [like, limit]);
      return rows.map((r) => ({ type: 'party', title: r.short_name, subtitle: r.legal_name, url: `/parties/${r.id}` }));
    },
  },
  {
    type: 'claim', permission: 'claims:read',
    run: async (db, like, status, _y, limit) => {
      const { rows } = await db.query<{ id: string; claim_no: string; status: string }>(
        `select id, claim_no, status from claim where not is_deleted and claim_no ilike $1
            and ($2::text is null or status = $2)
          order by created_at desc limit $3`, [like, status, limit]);
      return rows.map((r) => ({ type: 'claim', title: r.claim_no, subtitle: r.status, url: `/claims/${r.id}` }));
    },
  },
];

export async function searchEnhancedModule(app: FastifyInstance): Promise<void> {
  // ---- Saved searches ------------------------------------------------------
  app.get('/api/search/saved', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, query, filters, to_char(created_at,'YYYY-MM-DD') as "createdAt"
           from saved_search where user_id = $1 order by created_at desc`, [ctx.userId]);
      return { saved: rows };
    });
  });

  app.post('/api/search/saved', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    const schema = z.object({ name: z.string().min(1), query: z.string().min(1), filters: z.record(z.unknown()).optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid saved search' }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      try {
        const { rows } = await db.query<{ id: string }>(
          `insert into saved_search (tenant_id, user_id, name, query, filters) values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, user_id, name) do update set query = excluded.query, filters = excluded.filters
           returning id`, [ctx.tenantId, ctx.userId, b.name, b.query, JSON.stringify(b.filters ?? {})]);
        reply.code(201); return { id: rows[0]!.id };
      } catch { reply.code(409); return { error: 'Could not save search' }; }
    });
  });

  app.delete<{ Params: { id: string } }>('/api/search/saved/:id', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      await db.query(`delete from saved_search where id = $1 and user_id = $2`, [req.params.id, ctx.userId]);
      return { ok: true };
    });
  });

  // ---- History (record + list) --------------------------------------------
  app.post('/api/search/history', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    const b = (req.body ?? {}) as { query?: string; resultsCount?: number };
    const query = (b.query ?? '').trim();
    if (query.length < 2) return { ok: false };
    return runAs(ctx, async (db) => {
      await db.query(`insert into search_history (tenant_id, user_id, query, results_count) values ($1,$2,$3,$4)`,
        [ctx.tenantId, ctx.userId, query, Math.max(0, Number(b.resultsCount) || 0)]);
      return { ok: true };
    });
  });

  app.get('/api/search/history', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select distinct on (lower(query)) query, results_count as "resultsCount",
                to_char(searched_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "at"
           from search_history where user_id = $1 order by lower(query), searched_at desc limit 15`, [ctx.userId]);
      return { history: rows };
    });
  });

  // ---- Suggestions (saved names + recent history + type keywords) ---------
  app.get<{ Querystring: { q?: string } }>('/api/search/suggest', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    const q = (req.query.q ?? '').trim().toLowerCase();
    return runAs(ctx, async (db) => {
      const saved = await db.query<{ query: string }>(
        `select distinct query from saved_search where user_id = $1 and ($2 = '' or lower(query) like '%'||$2||'%') limit 5`, [ctx.userId, q]);
      const hist = await db.query<{ query: string }>(
        `select distinct query from search_history where user_id = $1 and ($2 = '' or lower(query) like '%'||$2||'%')
          order by query limit 8`, [ctx.userId, q]);
      const canned = ['bound treaties 2026', 'open claims', 'draft treaties', 'brokers', 'cedents']
        .filter((s) => !q || s.includes(q)).slice(0, 5);
      const seen = new Set<string>();
      const suggestions = [...saved.rows, ...hist.rows].map((r) => r.query)
        .concat(canned).filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10);
      return { suggestions };
    });
  });

  // ---- Natural-language search --------------------------------------------
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search/nl', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    const parsed = parseSearchQuery(req.query.q ?? '');
    const perms = req.auth?.permissions ?? [];
    const isAdmin = perms.includes('admin:manage');
    const limit = Math.min(Number(req.query.limit) || 6, 20);
    const like = `%${parsed.terms.replace(/[%_]/g, (m) => '\\' + m) || ''}%`;

    const wantTypes = new Set(parsed.types);
    const sources = SOURCES.filter((s) =>
      (isAdmin || perms.includes(s.permission)) && (wantTypes.size === 0 || wantTypes.has(s.type)));

    return runAs(ctx, async (db) => {
      const groups: { type: string; hits: Hit[] }[] = [];
      for (const s of sources) {
        const hits = await s.run(db, like, parsed.status, parsed.year, limit);
        if (hits.length) groups.push({ type: s.type, hits });
      }
      const results = groups.flatMap((g) => g.hits);
      return { interpreted: describeParsedSearch(parsed), parsed, groups, results };
    });
  });
}
