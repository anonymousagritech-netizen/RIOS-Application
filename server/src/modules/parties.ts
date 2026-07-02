/**
 * Party module (brief §7 / §16.1 - party/role-centric).
 * A party can hold many roles; the list and detail views surface them together.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db, type TenantContext } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createRatingSchema = z.object({
  agency: z.enum(['SP', 'AM_BEST', 'MOODYS', 'FITCH', 'INTERNAL']),
  rating: z.string().min(1),
  outlook: z.string().optional(),
  ratedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().optional(),
});

const creditLimitSchema = z.object({
  currency: z.string().length(3),
  limitMinor: z.number().int(),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const collateralSchema = z.object({
  kind: z.enum(['LOC', 'FUNDS_WITHHELD', 'TRUST', 'CASH']),
  reference: z.string().optional(),
  amountMinor: z.number().int(),
  currency: z.string().length(3),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const screenSchema = z.object({
  name: z.string().min(1),
  partyId: z.string().uuid().optional(),
  paymentRef: z.string().optional(),
});

/** Lowercase, strip punctuation, collapse whitespace - so "Al-Qaida, Ltd." ≡ "al qaida ltd". */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SanctionsListName {
  id: string;
  listSource: string;
  name: string;
}

export interface SanctionsMatch {
  entryId: string;
  listSource: string;
  listedName: string;
  matchType: 'EXACT' | 'TOKEN_SUBSET';
}

/**
 * Pure sanctions matcher. Exact normalised match ⇒ BLOCKED; token-subset match
 * (every token of one name appears in the other) ⇒ POTENTIAL_MATCH; else CLEAR.
 * The list is the tenant-loaded denylist (sanctions_list_entry) - a real
 * provider feed (OFAC/UN/EU) would keep it current; the matcher is honest
 * string matching, not fuzzy-phonetic scoring.
 */
export function screenName(
  name: string,
  list: SanctionsListName[],
): { result: 'CLEAR' | 'POTENTIAL_MATCH' | 'BLOCKED'; matches: SanctionsMatch[] } {
  const norm = normaliseName(name);
  const tokens = new Set(norm.split(' ').filter(Boolean));
  const matches: SanctionsMatch[] = [];
  let blocked = false;
  for (const entry of list) {
    const listNorm = normaliseName(entry.name);
    if (!listNorm) continue;
    if (listNorm === norm) {
      matches.push({ entryId: entry.id, listSource: entry.listSource, listedName: entry.name, matchType: 'EXACT' });
      blocked = true;
      continue;
    }
    const listTokens = listNorm.split(' ').filter(Boolean);
    const subsetOfScreened = listTokens.every((t) => tokens.has(t));
    const screenedInList = [...tokens].every((t) => listTokens.includes(t));
    if ((listTokens.length > 0 && subsetOfScreened) || (tokens.size > 0 && screenedInList)) {
      matches.push({ entryId: entry.id, listSource: entry.listSource, listedName: entry.name, matchType: 'TOKEN_SUBSET' });
    }
  }
  return { result: blocked ? 'BLOCKED' : matches.length ? 'POTENTIAL_MATCH' : 'CLEAR', matches };
}

const createPartySchema = z.object({
  legalName: z.string().min(1),
  shortName: z.string().optional(),
  kind: z.enum(['organisation', 'individual', 'syndicate', 'pool', 'captive']).default('organisation'),
  country: z.string().length(2).optional(),
  roles: z.array(z.string()).default([]),
  // Regulatory / market identifiers (LEI, tax id, NAIC, Lloyd's syndicate number, ...).
  identifiers: z.record(z.string()).optional(),
});

export async function partiesModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; role?: string } }>(
    '/api/parties',
    { preHandler: requirePermission('party:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select p.id, p.reference, p.legal_name as "legalName", p.short_name as "shortName",
                  p.kind, p.country, p.status,
                  coalesce(array_agg(pr.role_code::text) filter (where pr.role_code is not null), '{}') as roles
             from party p
             left join party_role pr on pr.party_id = p.id and pr.is_active
            where not p.is_deleted
              and ($1::text is null or p.legal_name ilike '%'||$1||'%' or p.short_name ilike '%'||$1||'%')
              and ($2::citext is null or exists (
                    select 1 from party_role x where x.party_id = p.id and x.role_code = $2 and x.is_active))
            group by p.id
            order by p.legal_name`,
          [req.query.q ?? null, req.query.role ?? null],
        );
        return { parties: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/parties/:id',
    { preHandler: requirePermission('party:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select p.id, p.reference, p.legal_name as "legalName", p.short_name as "shortName",
                  p.kind, p.country, p.status, p.identifiers,
                  coalesce(array_agg(pr.role_code::text) filter (where pr.role_code is not null), '{}') as roles
             from party p left join party_role pr on pr.party_id = p.id and pr.is_active
            where p.id = $1 and not p.is_deleted group by p.id`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Party not found' };
        }
        return rows[0];
      });
    },
  );

  app.post('/api/parties', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createPartySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid party', details: parsed.error.flatten() };
    }
    const body = parsed.data;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'party_reference', 'PTY');
      const { rows } = await db.query<{ id: string }>(
        `insert into party (tenant_id, reference, legal_name, short_name, kind, country, identifiers)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, ref, body.legalName, body.shortName ?? null, body.kind, body.country ?? null,
         JSON.stringify(body.identifiers ?? {})],
      );
      const id = rows[0]!.id;
      for (const role of body.roles) {
        await db.query(
          `insert into party_role (tenant_id, party_id, role_code) values ($1,$2,$3)
           on conflict do nothing`,
          [ctx.tenantId, id, role],
        );
      }
      // Sanctions screening on creation: record the result, never block here -
      // whether a POTENTIAL_MATCH/BLOCKED party may be created is a business
      // policy decision; the screening row + audit make it reviewable.
      const screening = await runScreening(db, ctx, body.legalName, id, null);
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'party',
        entityId: id,
        after: { legalName: body.legalName, roles: body.roles, screeningResult: screening.result },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, reference: ref, screeningResult: screening.result };
    });
  });

  // ── Counterparty security (ratings / credit limits / collateral) ─────────

  app.post<{ Params: { id: string } }>(
    '/api/parties/:id/ratings',
    { preHandler: requirePermission('party:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = createRatingSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid rating', details: parsed.error.flatten() };
      }
      const body = parsed.data;
      return runAs(ctx, async (db) => {
        const party = await db.query(`select id from party where id = $1 and not is_deleted`, [req.params.id]);
        if (!party.rows[0]) {
          reply.code(404);
          return { error: 'Party not found' };
        }
        const { rows } = await db.query<{ id: string }>(
          `insert into security_rating (tenant_id, party_id, agency, rating, outlook, rated_on, note, created_by)
           values ($1,$2,$3,$4,$5,coalesce($6::date, current_date),$7,$8) returning id`,
          [ctx.tenantId, req.params.id, body.agency, body.rating, body.outlook ?? null,
           body.ratedOn ?? null, body.note ?? null, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'security_rating',
          entityId: rows[0]!.id,
          after: { partyId: req.params.id, agency: body.agency, rating: body.rating, outlook: body.outlook ?? null },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { id: rows[0]!.id };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/parties/:id/ratings',
    { preHandler: requirePermission('party:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, agency, rating, outlook, rated_on as "ratedOn", note, created_at as "createdAt"
             from security_rating where party_id = $1
            order by rated_on desc, created_at desc`,
          [req.params.id],
        );
        return { ratings: rows };
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/parties/:id/credit-limit',
    { preHandler: requirePermission('party:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = creditLimitSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid credit limit', details: parsed.error.flatten() };
      }
      const body = parsed.data;
      return runAs(ctx, async (db) => {
        const party = await db.query(`select id from party where id = $1 and not is_deleted`, [req.params.id]);
        if (!party.rows[0]) {
          reply.code(404);
          return { error: 'Party not found' };
        }
        const before = await db.query(
          `select limit_minor as "limitMinor" from credit_limit where party_id = $1 and currency = $2`,
          [req.params.id, body.currency.toUpperCase()],
        );
        const { rows } = await db.query<{ id: string }>(
          `insert into credit_limit (tenant_id, party_id, currency, limit_minor, review_date, created_by)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id, party_id, currency)
           do update set limit_minor = excluded.limit_minor, review_date = excluded.review_date, status = 'ACTIVE'
           returning id`,
          [ctx.tenantId, req.params.id, body.currency.toUpperCase(), body.limitMinor,
           body.reviewDate ?? null, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: before.rows[0] ? 'update' : 'create',
          entityType: 'credit_limit',
          entityId: rows[0]!.id,
          before: before.rows[0] ?? null,
          after: { partyId: req.params.id, currency: body.currency.toUpperCase(), limitMinor: body.limitMinor },
          actorLabel: req.auth?.displayName,
        });
        return { id: rows[0]!.id };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/parties/:id/credit-limit',
    { preHandler: requirePermission('party:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, currency, limit_minor as "limitMinor", consumed_minor as "consumedMinor",
                  (limit_minor - consumed_minor) as "headroomMinor", status,
                  review_date as "reviewDate", created_at as "createdAt"
             from credit_limit where party_id = $1 order by currency`,
          [req.params.id],
        );
        return { limits: rows.map(asMinorNumbers) };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/parties/:id/collateral',
    { preHandler: requirePermission('party:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = collateralSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid collateral', details: parsed.error.flatten() };
      }
      const body = parsed.data;
      return runAs(ctx, async (db) => {
        const party = await db.query(`select id from party where id = $1 and not is_deleted`, [req.params.id]);
        if (!party.rows[0]) {
          reply.code(404);
          return { error: 'Party not found' };
        }
        const { rows } = await db.query<{ id: string }>(
          `insert into collateral (tenant_id, party_id, kind, reference, amount_minor, currency, expiry_date, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [ctx.tenantId, req.params.id, body.kind, body.reference ?? null, body.amountMinor,
           body.currency.toUpperCase(), body.expiryDate ?? null, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'collateral',
          entityId: rows[0]!.id,
          after: { partyId: req.params.id, kind: body.kind, amountMinor: body.amountMinor, currency: body.currency.toUpperCase() },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { id: rows[0]!.id };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/parties/:id/collateral',
    { preHandler: requirePermission('party:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, kind, reference, amount_minor as "amountMinor", currency,
                  expiry_date as "expiryDate", status, created_at as "createdAt"
             from collateral where party_id = $1 order by created_at desc`,
          [req.params.id],
        );
        return { collateral: rows.map(asMinorNumbers) };
      });
    },
  );

  // The "security committee" view: latest rating per agency, credit limits with
  // headroom, active collateral totals per currency, latest screening result.
  app.get<{ Params: { id: string } }>(
    '/api/parties/:id/security',
    { preHandler: requirePermission('party:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const party = await db.query(
          `select id, legal_name as "legalName" from party where id = $1 and not is_deleted`,
          [req.params.id],
        );
        if (!party.rows[0]) {
          reply.code(404);
          return { error: 'Party not found' };
        }
        const ratings = await db.query(
          `select distinct on (agency) agency, rating, outlook, rated_on as "ratedOn"
             from security_rating where party_id = $1
            order by agency, rated_on desc, created_at desc`,
          [req.params.id],
        );
        const limits = await db.query(
          `select currency, limit_minor as "limitMinor", consumed_minor as "consumedMinor",
                  (limit_minor - consumed_minor) as "headroomMinor", status, review_date as "reviewDate"
             from credit_limit where party_id = $1 order by currency`,
          [req.params.id],
        );
        const collateralTotals = await db.query(
          `select currency, sum(amount_minor)::bigint as "totalMinor", count(*)::int as items
             from collateral where party_id = $1 and status = 'ACTIVE'
            group by currency order by currency`,
          [req.params.id],
        );
        const screening = await db.query(
          `select result, screened_at as "screenedAt"
             from sanctions_screening where party_id = $1
            order by screened_at desc limit 1`,
          [req.params.id],
        );
        return {
          party: party.rows[0],
          ratings: ratings.rows,
          creditLimits: limits.rows.map(asMinorNumbers),
          collateral: collateralTotals.rows.map(asMinorNumbers),
          latestScreening: screening.rows[0] ?? null,
        };
      });
    },
  );

  // ── Sanctions screening ───────────────────────────────────────────────────

  app.post('/api/parties/screen', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = screenSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid screening request', details: parsed.error.flatten() };
    }
    const body = parsed.data;
    return runAs(ctx, async (db) => {
      const screening = await runScreening(db, ctx, body.name, body.partyId ?? null, body.paymentRef ?? null);
      await writeAudit(db, ctx, {
        action: 'screen',
        entityType: 'sanctions_screening',
        entityId: screening.id,
        after: { name: body.name, partyId: body.partyId ?? null, result: screening.result, matches: screening.matches.length },
        actorLabel: req.auth?.displayName,
      });
      return { id: screening.id, result: screening.result, matches: screening.matches };
    });
  });
}

/** pg returns bigint as string; the wire contract is integer minor units. */
function asMinorNumbers<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of Object.keys(out)) {
    if (k.endsWith('Minor') && typeof out[k] === 'string') out[k] = Number(out[k]);
  }
  return out as T;
}

/** Screen a name against the tenant's sanctions denylist and record the outcome. */
async function runScreening(
  db: Db,
  ctx: TenantContext,
  name: string,
  partyId: string | null,
  paymentRef: string | null,
): Promise<{ id: string; result: 'CLEAR' | 'POTENTIAL_MATCH' | 'BLOCKED'; matches: SanctionsMatch[] }> {
  const entries = await db.query<{ id: string; listSource: string; fullName: string; alias: string | null }>(
    `select id, list_source as "listSource", full_name as "fullName", alias from sanctions_list_entry`,
  );
  const list: SanctionsListName[] = [];
  for (const e of entries.rows) {
    list.push({ id: e.id, listSource: e.listSource, name: e.fullName });
    if (e.alias) list.push({ id: e.id, listSource: e.listSource, name: e.alias });
  }
  const { result, matches } = screenName(name, list);
  const ins = await db.query<{ id: string }>(
    `insert into sanctions_screening (tenant_id, party_id, payment_ref, screened_name, result, matches, screened_by)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, partyId, paymentRef, name, result, JSON.stringify(matches), ctx.userId],
  );
  return { id: ins.rows[0]!.id, result, matches };
}

/** Generate the next reference from a numbering scheme, atomically. */
export async function nextReference(
  db: { query: (t: string, p?: unknown[]) => Promise<{ rows: { next_seq: number }[] }> },
  tenantId: string,
  key: string,
  fallbackPrefix: string,
): Promise<string> {
  const res = await db.query(
    `update numbering_scheme set next_seq = next_seq + 1
      where tenant_id = $1 and key = $2
      returning next_seq - 1 as next_seq, pattern, prefix`,
    [tenantId, key],
  );
  const row = res.rows[0] as { next_seq: number; pattern?: string; prefix?: string } | undefined;
  const seq = row?.next_seq ?? Date.now() % 100000;
  const year = new Date().getUTCFullYear();
  const pattern = (row as { pattern?: string } | undefined)?.pattern ?? `${fallbackPrefix}-{YYYY}-{SEQ:5}`;
  return pattern
    .replace('{YYYY}', String(year))
    .replace(/\{SEQ:(\d+)\}/, (_m, width: string) => String(seq).padStart(Number(width), '0'));
}
