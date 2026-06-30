/**
 * Approval delegation (brief §3). Lets a user delegate their approval authority
 * to a colleague for a window, optionally scoped to one permission. The "who may
 * act for whom" decision is the pure @rios/domain resolver (canActAs/actingFor).
 * A user manages their own delegations (as delegator); admin:manage sees/forms
 * any. Reads require authentication; mutations are audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actingFor, canActAs, type Delegation } from '@rios/domain';
import { runAs } from '../db.js';
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
}
