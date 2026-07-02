/**
 * Approval delegation (brief §3). Lets a user delegate their approval authority
 * to a colleague for a window, optionally scoped to one permission. The "who may
 * act for whom" decision is the pure @rios/domain resolver (canActAs/actingFor).
 * A user manages their own delegations (as delegator); admin:manage sees/forms
 * any. Reads require authentication; mutations are audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actingFor, canActAs, checkBindingAuthority, type Delegation, type Authority, type BreachKind } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createSchema = z.object({
  delegateUserId: z.string().uuid(),
  delegatorUserId: z.string().uuid().optional(), // admin may set; else current user
  scopePermission: z.string().nullable().optional(),
  reason: z.string().optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
});

interface Row {
  id: string; delegatorUserId: string; delegateUserId: string;
  scopePermission: string | null; startsAt: string | null; endsAt: string | null; active: boolean;
}

function toDomain(r: Row): Delegation {
  return {
    delegatorUserId: r.delegatorUserId,
    delegateUserId: r.delegateUserId,
    scopePermission: r.scopePermission,
    startsAtMs: r.startsAt ? Date.parse(r.startsAt) : null,
    endsAtMs: r.endsAt ? Date.parse(r.endsAt) : null,
    active: r.active,
  };
}

export async function delegationModule(app: FastifyInstance): Promise<void> {
  // Delegations involving the current user (as delegator or delegate); admin sees all.
  app.get('/api/delegations', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    const isAdmin = !!req.auth?.permissions.includes('admin:manage');
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select d.id, d.delegator_user_id as "delegatorUserId", d.delegate_user_id as "delegateUserId",
                d.scope_permission as "scopePermission", d.reason,
                d.starts_at as "startsAt", d.ends_at as "endsAt", d.active,
                gr.display_name as "delegatorName", ge.display_name as "delegateName"
           from approval_delegation d
           join app_user gr on gr.id = d.delegator_user_id
           join app_user ge on ge.id = d.delegate_user_id
          where $2 or d.delegator_user_id = $1 or d.delegate_user_id = $1
          order by d.active desc, d.created_at desc`,
        [ctx.userId, isAdmin],
      );
      return { delegations: rows };
    });
  });

  // Tenant users (for the delegate picker) - id + display name only.
  app.get('/api/delegations/users', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, display_name as "displayName", email from app_user
          where id <> $1 order by display_name`,
        [ctx.userId],
      );
      return { users: rows };
    });
  });

  // Who can the current user act for, right now?
  app.get('/api/delegations/acting-for', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<Row>(
        `select id, delegator_user_id as "delegatorUserId", delegate_user_id as "delegateUserId",
                scope_permission as "scopePermission", starts_at as "startsAt", ends_at as "endsAt", active
           from approval_delegation where active`,
      );
      const delegations = rows.map(toDomain);
      const delegatorIds = actingFor(delegations, ctx.userId, Date.now());
      let names: { id: string; displayName: string }[] = [];
      if (delegatorIds.length) {
        const r = await db.query<{ id: string; display_name: string }>(
          `select id, display_name from app_user where id = any($1::uuid[])`, [delegatorIds],
        );
        names = r.rows.map((x) => ({ id: x.id, displayName: x.display_name }));
      }
      return { actingFor: names };
    });
  });

  // Check whether the current user may act for a delegator (optionally for a permission).
  app.get<{ Querystring: { delegatorUserId?: string; permission?: string } }>(
    '/api/delegations/can-act',
    { preHandler: requirePermission() },
    async (req) => {
      const ctx = authContext(req);
      const delegatorUserId = req.query.delegatorUserId ?? '';
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<Row>(
          `select id, delegator_user_id as "delegatorUserId", delegate_user_id as "delegateUserId",
                  scope_permission as "scopePermission", starts_at as "startsAt", ends_at as "endsAt", active
             from approval_delegation where active and delegator_user_id = $1`,
          [delegatorUserId],
        );
        const allowed = canActAs(rows.map(toDomain), ctx.userId, delegatorUserId, Date.now(), req.query.permission);
        return { canAct: allowed };
      });
    },
  );

  app.post('/api/delegations', { preHandler: requirePermission() }, async (req, reply) => {
    const ctx = authContext(req);
    const isAdmin = !!req.auth?.permissions.includes('admin:manage');
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid delegation', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    // A non-admin may only delegate their OWN authority.
    const delegator = isAdmin && b.delegatorUserId ? b.delegatorUserId : ctx.userId;
    if (delegator === b.delegateUserId) {
      reply.code(400);
      return { error: 'Cannot delegate to yourself' };
    }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into approval_delegation
           (tenant_id, delegator_user_id, delegate_user_id, scope_permission, reason, starts_at, ends_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ctx.tenantId, delegator, b.delegateUserId, b.scopePermission ?? null, b.reason ?? null, b.startsAt ?? null, b.endsAt ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'approval_delegation', entityId: rows[0]!.id,
        after: { delegator, delegate: b.delegateUserId, scope: b.scopePermission ?? null }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Revoke a delegation (delegator or admin only).
  app.post<{ Params: { id: string } }>(
    '/api/delegations/:id/revoke',
    { preHandler: requirePermission() },
    async (req, reply) => {
      const ctx = authContext(req);
      const isAdmin = !!req.auth?.permissions.includes('admin:manage');
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(
          `update approval_delegation set active = false
            where id = $1 and active and ($2 or delegator_user_id = $3)`,
          [req.params.id, isAdmin, ctx.userId],
        );
        if (!rowCount) { reply.code(404); return { error: 'Active delegation not found or not yours' }; }
        await writeAudit(db, ctx, { action: 'revoke', entityType: 'approval_delegation', entityId: req.params.id, actorLabel: req.auth?.displayName });
        return { id: req.params.id, revoked: true };
      });
    },
  );

  // =========================================================================
  // Binding / delegated authority (brief §3; workbook "binding-authority depth").
  // A reinsurer grants binding authority to a coverholder (party) or an internal
  // underwriter (user), bounded by a per-risk line, an aggregate cap, an optional
  // LOB + territory scope and a validity window. The authority *check* is the pure
  // @rios/domain resolver (checkAuthority); this module records grants, consumption
  // and breaches. Reads gate on `treaty:read`, mutations on `treaty:write`.
  // =========================================================================

  interface AuthorityRow {
    id: string; grantee_party_id: string | null; grantee_user_id: string | null;
    name: string; lob: string | null; territory: string | null;
    max_line_minor: string | number; max_aggregate_minor: string | number;
    currency: string; valid_from: string | null; valid_to: string | null; status: string;
  }

  function rowToAuthority(r: AuthorityRow): Authority {
    return {
      lob: r.lob, territory: r.territory,
      maxLineMinor: Number(r.max_line_minor), maxAggregateMinor: Number(r.max_aggregate_minor),
      validFrom: r.valid_from, validTo: r.valid_to, status: r.status,
    };
  }

  /** Aggregate already consumed under an authority (integer minor units). */
  async function consumedAggregate(db: Db, authorityId: string): Promise<number> {
    const { rows } = await db.query<{ total: string }>(
      `select coalesce(sum(bound_minor),0)::bigint as total from authority_usage where authority_id = $1`,
      [authorityId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  const authorityCreateSchema = z.object({
    granteePartyId: z.string().uuid().nullable().optional(),
    granteeUserId: z.string().uuid().nullable().optional(),
    name: z.string().min(1),
    lob: z.string().nullable().optional(),
    territory: z.string().nullable().optional(),
    maxLineMinor: z.number().int().nonnegative(),
    maxAggregateMinor: z.number().int().nonnegative(),
    currency: z.string().length(3),
    validFrom: z.string().nullable().optional(),
    validTo: z.string().nullable().optional(),
  });

  const authorityCheckSchema = z.object({
    lob: z.string().nullable().optional(),
    territory: z.string().nullable().optional(),
    lineMinor: z.number().int().nonnegative(),
    asOf: z.string().nullable().optional(),
  });

  const recordUsageSchema = z.object({
    contractId: z.string().uuid().nullable().optional(),
    boundMinor: z.number().int().nonnegative(),
    note: z.string().nullable().optional(),
    override: z.boolean().optional(),
  });

  const authoritySelect =
    `select id, grantee_party_id, grantee_user_id, name, lob, territory,
            max_line_minor, max_aggregate_minor, currency,
            to_char(valid_from,'YYYY-MM-DD') as valid_from,
            to_char(valid_to,'YYYY-MM-DD') as valid_to, status`;

  // ---- Create an authority grant -------------------------------------------
  app.post('/api/delegation/authorities', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = authorityCreateSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid authority', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into binding_authority
           (tenant_id, grantee_party_id, grantee_user_id, name, lob, territory,
            max_line_minor, max_aggregate_minor, currency, valid_from, valid_to, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',$12) returning id`,
        [ctx.tenantId, b.granteePartyId ?? null, b.granteeUserId ?? null, b.name, b.lob ?? null, b.territory ?? null,
         b.maxLineMinor, b.maxAggregateMinor, b.currency, b.validFrom ?? null, b.validTo ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'binding_authority', entityId: rows[0]!.id,
        after: { name: b.name, maxLineMinor: b.maxLineMinor, maxAggregateMinor: b.maxAggregateMinor, lob: b.lob ?? null, territory: b.territory ?? null },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // ---- List authority grants (with consumed aggregate) ---------------------
  app.get('/api/delegation/authorities', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select a.id, a.name, a.lob, a.territory,
                a.max_line_minor as "maxLineMinor", a.max_aggregate_minor as "maxAggregateMinor",
                a.currency, a.status,
                to_char(a.valid_from,'YYYY-MM-DD') as "validFrom",
                to_char(a.valid_to,'YYYY-MM-DD') as "validTo",
                a.grantee_party_id as "granteePartyId", a.grantee_user_id as "granteeUserId",
                p.short_name as "granteePartyName", u.display_name as "granteeUserName",
                coalesce((select sum(bound_minor) from authority_usage x where x.authority_id = a.id),0)::bigint as "consumedMinor"
           from binding_authority a
           left join party p on p.id = a.grantee_party_id
           left join app_user u on u.id = a.grantee_user_id
          order by a.created_at desc`,
      );
      return { authorities: rows };
    });
  });

  // ---- Authority detail (+ usage + breaches) -------------------------------
  app.get<{ Params: { id: string } }>('/api/delegation/authorities/:id', { preHandler: requirePermission('treaty:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<AuthorityRow & { grantee_party_name: string | null; grantee_user_name: string | null }>(
        `select ba.id, ba.grantee_party_id, ba.grantee_user_id, ba.name, ba.lob, ba.territory,
                ba.max_line_minor, ba.max_aggregate_minor, ba.currency,
                to_char(ba.valid_from,'YYYY-MM-DD') as valid_from,
                to_char(ba.valid_to,'YYYY-MM-DD') as valid_to, ba.status,
                p.short_name as grantee_party_name, u.display_name as grantee_user_name
           from binding_authority ba
           left join party p on p.id = ba.grantee_party_id
           left join app_user u on u.id = ba.grantee_user_id
          where ba.id = $1`,
        [req.params.id],
      );
      const a = rows[0];
      if (!a) { reply.code(404); return { error: 'Authority not found' }; }
      const usage = await db.query(
        `select id, contract_id as "contractId", bound_minor as "boundMinor",
                to_char(bound_at,'YYYY-MM-DD') as "boundAt", note
           from authority_usage where authority_id = $1 order by bound_at desc limit 100`,
        [req.params.id],
      );
      const breaches = await db.query(
        `select id, kind, attempted_minor as "attemptedMinor", limit_minor as "limitMinor", context,
                to_char(detected_at,'YYYY-MM-DD') as "detectedAt"
           from authority_breach where authority_id = $1 order by detected_at desc limit 100`,
        [req.params.id],
      );
      const consumed = await consumedAggregate(db, req.params.id);
      return {
        id: a.id, name: a.name, lob: a.lob, territory: a.territory,
        maxLineMinor: Number(a.max_line_minor), maxAggregateMinor: Number(a.max_aggregate_minor),
        currency: a.currency, status: a.status, validFrom: a.valid_from, validTo: a.valid_to,
        granteePartyId: a.grantee_party_id, granteeUserId: a.grantee_user_id,
        granteePartyName: a.grantee_party_name, granteeUserName: a.grantee_user_name,
        consumedMinor: consumed, remainingMinor: Number(a.max_aggregate_minor) - consumed,
        usage: usage.rows, breaches: breaches.rows,
      };
    });
  });

  // ---- Suspend an authority grant ------------------------------------------
  app.post<{ Params: { id: string } }>('/api/delegation/authorities/:id/suspend', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rowCount } = await db.query(
        `update binding_authority set status = 'SUSPENDED' where id = $1 and status <> 'SUSPENDED'`,
        [req.params.id],
      );
      if (!rowCount) { reply.code(404); return { error: 'Active authority not found' }; }
      await writeAudit(db, ctx, { action: 'suspend', entityType: 'binding_authority', entityId: req.params.id, after: { status: 'SUSPENDED' }, actorLabel: req.auth?.displayName });
      return { id: req.params.id, status: 'SUSPENDED' };
    });
  });

  // ---- Check a line against an authority (records any breach) ---------------
  app.post<{ Params: { id: string } }>('/api/delegation/authorities/:id/check', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = authorityCheckSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid check', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<AuthorityRow>(`${authoritySelect} from binding_authority where id = $1`, [req.params.id]);
      const a = rows[0];
      if (!a) { reply.code(404); return { error: 'Authority not found' }; }
      const authority = rowToAuthority(a);
      const prior = await consumedAggregate(db, req.params.id);
      const asOf = b.asOf ?? new Date().toISOString().slice(0, 10);
      const result = checkBindingAuthority({
        authority, lob: b.lob ?? null, territory: b.territory ?? null,
        lineMinor: b.lineMinor, priorAggregateMinor: prior, asOf,
      });
      // Record each breached bound with the relevant limit for the audit trail.
      const limitFor = (k: BreachKind): number | null => {
        if (k === 'LINE') return authority.maxLineMinor;
        if (k === 'AGGREGATE') return authority.maxAggregateMinor;
        return null;
      };
      for (const kind of result.breaches) {
        await db.query(
          `insert into authority_breach (tenant_id, authority_id, kind, attempted_minor, limit_minor, context, detected_by)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [ctx.tenantId, req.params.id, kind, b.lineMinor, limitFor(kind),
           JSON.stringify({ lob: b.lob ?? null, territory: b.territory ?? null, priorAggregateMinor: prior, asOf }), ctx.userId],
        );
      }
      if (result.breaches.length) {
        await writeAudit(db, ctx, {
          action: 'authority_breach', entityType: 'binding_authority', entityId: req.params.id,
          after: { breaches: result.breaches, lineMinor: b.lineMinor }, actorLabel: req.auth?.displayName,
        });
      }
      return { ...result, priorAggregateMinor: prior, asOf };
    });
  });

  // ---- Record consumption against an authority (increments the aggregate) ---
  app.post<{ Params: { id: string } }>('/api/delegation/authorities/:id/record-usage', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const isAdmin = !!req.auth?.permissions.includes('admin:manage');
    const parsed = recordUsageSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid usage', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ max_aggregate_minor: string | number }>(
        `select max_aggregate_minor from binding_authority where id = $1`, [req.params.id],
      );
      const a = rows[0];
      if (!a) { reply.code(404); return { error: 'Authority not found' }; }
      const prior = await consumedAggregate(db, req.params.id);
      const cap = Number(a.max_aggregate_minor);
      const exceeds = prior + b.boundMinor > cap;
      const override = !!b.override && isAdmin;
      if (exceeds && !override) {
        reply.code(409);
        return { error: 'Recording this usage would exceed the aggregate authority', priorAggregateMinor: prior, maxAggregateMinor: cap, attemptedMinor: b.boundMinor };
      }
      const ins = await db.query<{ id: string }>(
        `insert into authority_usage (tenant_id, authority_id, contract_id, bound_minor, note, created_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, req.params.id, b.contractId ?? null, b.boundMinor, b.note ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: exceeds ? 'authority override' : 'record_usage', entityType: 'binding_authority', entityId: req.params.id,
        after: { boundMinor: b.boundMinor, priorAggregateMinor: prior, overrode: exceeds }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: ins.rows[0]!.id, priorAggregateMinor: prior, newAggregateMinor: prior + b.boundMinor, overrode: exceeds };
    });
  });

  // ---- Breach history for an authority -------------------------------------
  app.get<{ Params: { id: string } }>('/api/delegation/authorities/:id/breaches', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, kind, attempted_minor as "attemptedMinor", limit_minor as "limitMinor", context,
                to_char(detected_at,'YYYY-MM-DD') as "detectedAt"
           from authority_breach where authority_id = $1 order by detected_at desc`,
        [req.params.id],
      );
      return { breaches: rows };
    });
  });
}
