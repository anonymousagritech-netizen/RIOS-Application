/**
 * Data retention & legal hold (brief §14). Manages retention policies (per
 * entity type) and legal holds, and evaluates a record's disposition via the
 * pure @rios/domain engine (retentionVerdict) - a hold always overrides a
 * policy. retention:read to view, retention:write to author; mutations audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { retentionVerdict, hasActiveHold, ageInDays, type LegalHold } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const policySchema = z.object({
  entityType: z.string().min(1),
  retentionDays: z.number().int().nonnegative(),
  action: z.enum(['archive', 'purge']).default('archive'),
  active: z.boolean().default(true),
  note: z.string().optional(),
});

const holdSchema = z.object({
  name: z.string().min(1),
  reason: z.string().optional(),
  entityType: z.string().nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
});

const evalSchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid().optional(),
  recordedAt: z.string(),
});

const scheduleSchema = z.object({
  entity: z.string().min(1),
  retentionMonths: z.number().int().nonnegative(),
  basis: z.enum(['CREATED', 'CLOSED']).default('CREATED'),
  action: z.enum(['ARCHIVE', 'ANONYMISE', 'DELETE']),
  active: z.boolean().default(true),
});

const legalHoldSchema = z.object({
  name: z.string().min(1),
  entity: z.string().nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
  reason: z.string().optional(),
});

const erasureSchema = z.object({
  subjectEntity: z.string().min(1),
  subjectId: z.string().uuid(),
  reason: z.string().optional(),
});

// Entities the due-candidate scan and erasure can concretely act on. Each maps
// a retention basis to a real date column; anything not listed is not scanned
// (honest: we only report candidates we can actually anchor to a date).
const DUE_ENTITIES: Record<string, { table: string; created: string; closed: string; softDelete: boolean }> = {
  party:     { table: 'party',                created: 'created_at', closed: 'updated_at', softDelete: true },
  claim:     { table: 'claim',                created: 'created_at', closed: 'updated_at', softDelete: true },
  statement: { table: 'statement_of_account', created: 'created_at', closed: 'settled_at', softDelete: false },
};

export async function retentionModule(app: FastifyInstance): Promise<void> {
  app.get('/api/retention/policies', { preHandler: requirePermission('retention:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, entity_type as "entityType", retention_days as "retentionDays",
                action, active, note
           from retention_policy order by entity_type`,
      );
      return { policies: rows };
    });
  });

  app.post('/api/retention/policies', { preHandler: requirePermission('retention:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid policy', details: parsed.error.flatten() };
    }
    const p = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into retention_policy (tenant_id, entity_type, retention_days, action, active, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, entity_type) do update set
           retention_days = excluded.retention_days, action = excluded.action,
           active = excluded.active, note = excluded.note
         returning id`,
        [ctx.tenantId, p.entityType, p.retentionDays, p.action, p.active, p.note ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'retention_policy', entityId: rows[0]!.id,
        after: { entityType: p.entityType, retentionDays: p.retentionDays }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  app.get('/api/retention/holds', { preHandler: requirePermission('retention:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, reason, entity_type as "entityType", entity_id as "entityId",
                active, placed_at as "placedAt", released_at as "releasedAt"
           from legal_hold order by active desc, placed_at desc`,
      );
      return { holds: rows };
    });
  });

  app.post('/api/retention/holds', { preHandler: requirePermission('retention:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = holdSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid legal hold', details: parsed.error.flatten() };
    }
    const h = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into legal_hold (tenant_id, name, reason, entity_type, entity_id, placed_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, h.name, h.reason ?? null, h.entityType ?? null, h.entityId ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'place_hold', entityType: 'legal_hold', entityId: rows[0]!.id,
        after: { name: h.name, entityType: h.entityType ?? null }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // Release a hold (sets inactive + released_at).
  app.post<{ Params: { id: string } }>(
    '/api/retention/holds/:id/release',
    { preHandler: requirePermission('retention:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(
          `update legal_hold set active = false, released_at = now() where id = $1 and active`,
          [req.params.id],
        );
        if (!rowCount) {
          reply.code(404);
          return { error: 'Active hold not found' };
        }
        await writeAudit(db, ctx, {
          action: 'release_hold', entityType: 'legal_hold', entityId: req.params.id,
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, released: true };
      });
    },
  );

  // Evaluate a record's disposition against the policy + any active holds.
  app.post('/api/retention/evaluate', { preHandler: requirePermission('retention:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = evalSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid evaluation', details: parsed.error.flatten() };
    }
    const { entityType, entityId, recordedAt } = parsed.data;
    const recordedMs = Date.parse(recordedAt);
    if (Number.isNaN(recordedMs)) {
      reply.code(400);
      return { error: 'recordedAt must be a valid date' };
    }
    return runAs(ctx, async (db) => {
      const pol = await db.query<{ retention_days: number; action: string }>(
        `select retention_days, action from retention_policy where entity_type = $1 and active`,
        [entityType],
      );
      if (!pol.rows[0]) {
        return { entityType, hasPolicy: false, verdict: null };
      }
      const holdRows = await db.query<LegalHold>(
        `select entity_type as "entityType", entity_id as "entityId", active from legal_hold where active`,
      );
      const onHold = hasActiveHold(holdRows.rows, entityType, entityId);
      const ageDays = ageInDays(recordedMs, Date.now());
      const verdict = retentionVerdict(ageDays, pol.rows[0].retention_days, onHold);
      return { entityType, hasPolicy: true, action: pol.rows[0].action, verdict };
    });
  });

  // ---------------------------------------------------------------------------
  // Retention schedules (per-entity disposal timetable; advisory - never
  // auto-deletes). create / list / deactivate.
  // ---------------------------------------------------------------------------
  app.get('/api/retention/schedules', { preHandler: requirePermission('retention:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, entity, retention_months as "retentionMonths", basis, action, active,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt"
           from retention_schedule order by entity, created_at desc`,
      );
      return { schedules: rows };
    });
  });

  app.post('/api/retention/schedules', { preHandler: requirePermission('retention:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid retention schedule', details: parsed.error.flatten() };
    }
    const s = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into retention_schedule (tenant_id, entity, retention_months, basis, action, active, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, s.entity, s.retentionMonths, s.basis, s.action, s.active, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'create', entityType: 'retention_schedule', entityId: rows[0]!.id,
        after: { entity: s.entity, retentionMonths: s.retentionMonths, basis: s.basis, action: s.action },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/retention/schedules/:id/deactivate',
    { preHandler: requirePermission('retention:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(
          `update retention_schedule set active = false where id = $1 and active`,
          [req.params.id],
        );
        if (!rowCount) { reply.code(404); return { error: 'Active schedule not found' }; }
        await writeAudit(db, ctx, {
          action: 'deactivate', entityType: 'retention_schedule', entityId: req.params.id,
          actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, active: false };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Legal holds with an explicit ACTIVE -> RELEASED lifecycle. A held record
  // cannot be erased (enforced by the erasure execute below). `active` and
  // `status` are kept in sync so the 0021 disposition logic keeps working.
  // ---------------------------------------------------------------------------
  app.get('/api/retention/legal-holds', { preHandler: requirePermission('retention:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, reason, entity_type as "entity", entity_id as "entityId",
                status, placed_by as "placedBy", released_by as "releasedBy",
                to_char(placed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "placedAt",
                to_char(released_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "releasedAt"
           from legal_hold order by status, placed_at desc`,
      );
      return { holds: rows };
    });
  });

  app.post('/api/retention/legal-holds', { preHandler: requirePermission('retention:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = legalHoldSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid legal hold', details: parsed.error.flatten() };
    }
    const h = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into legal_hold (tenant_id, name, reason, entity_type, entity_id, active, status, placed_by)
         values ($1,$2,$3,$4,$5,true,'ACTIVE',$6) returning id`,
        [ctx.tenantId, h.name, h.reason ?? null, h.entity ?? null, h.entityId ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'place_hold', entityType: 'legal_hold', entityId: rows[0]!.id,
        after: { name: h.name, entity: h.entity ?? null, entityId: h.entityId ?? null }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, status: 'ACTIVE' };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/retention/legal-holds/:id/release',
    { preHandler: requirePermission('retention:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rowCount } = await db.query(
          `update legal_hold set active = false, status = 'RELEASED', released_by = $2, released_at = now()
             where id = $1 and active`,
          [req.params.id, ctx.userId],
        );
        if (!rowCount) { reply.code(404); return { error: 'Active hold not found' }; }
        await writeAudit(db, ctx, {
          action: 'release_hold', entityType: 'legal_hold', entityId: req.params.id,
          before: { status: 'ACTIVE' }, after: { status: 'RELEASED' }, actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'RELEASED' };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Right-to-erasure workflow (maker/checker). request -> approve (a different
  // user, segregation of duties) -> execute. Execute is BLOCKED_BY_HOLD (409) if
  // an ACTIVE legal_hold covers the subject; otherwise the subject's PII is
  // honestly anonymised (party name/identifiers/contacts) while its id, audit
  // trail and financial references are preserved for reconcilability.
  // ---------------------------------------------------------------------------
  app.get('/api/retention/erasure', { preHandler: requirePermission('retention:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, subject_entity as "subjectEntity", subject_id as "subjectId", reason, status,
                requested_by as "requestedBy", approved_by as "approvedBy",
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt",
                to_char(executed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "executedAt"
           from erasure_request order by created_at desc`,
      );
      return { requests: rows };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/retention/erasure/:id',
    { preHandler: requirePermission('retention:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, subject_entity as "subjectEntity", subject_id as "subjectId", reason, status,
                  requested_by as "requestedBy", approved_by as "approvedBy",
                  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "createdAt",
                  to_char(executed_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as "executedAt"
             from erasure_request where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) { reply.code(404); return { error: 'Erasure request not found' }; }
        return rows[0];
      });
    },
  );

  app.post('/api/retention/erasure', { preHandler: requirePermission('retention:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = erasureSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid erasure request', details: parsed.error.flatten() };
    }
    const e = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into erasure_request (tenant_id, subject_entity, subject_id, reason, status, requested_by)
         values ($1,$2,$3,$4,'REQUESTED',$5) returning id`,
        [ctx.tenantId, e.subjectEntity, e.subjectId, e.reason ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'request', entityType: 'erasure_request', entityId: rows[0]!.id,
        after: { subjectEntity: e.subjectEntity, subjectId: e.subjectId }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, status: 'REQUESTED' };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/retention/erasure/:id/approve',
    { preHandler: requirePermission('retention:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string; requested_by: string | null }>(
          `select status, requested_by from erasure_request where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) { reply.code(404); return { error: 'Erasure request not found' }; }
        if (cur.rows[0].status !== 'REQUESTED') {
          reply.code(409);
          return { error: `Erasure request is ${cur.rows[0].status}; only a REQUESTED request can be approved` };
        }
        if (cur.rows[0].requested_by && cur.rows[0].requested_by === ctx.userId) {
          reply.code(403);
          return { error: 'Segregation of duties: the requester cannot approve their own erasure request' };
        }
        await db.query(
          `update erasure_request set status = 'APPROVED', approved_by = $2 where id = $1`,
          [req.params.id, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'approve', entityType: 'erasure_request', entityId: req.params.id,
          before: { status: 'REQUESTED' }, after: { status: 'APPROVED' }, actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'APPROVED' };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/retention/erasure/:id/reject',
    { preHandler: requirePermission('retention:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string }>(
          `select status from erasure_request where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) { reply.code(404); return { error: 'Erasure request not found' }; }
        if (!['REQUESTED', 'APPROVED'].includes(cur.rows[0].status)) {
          reply.code(409);
          return { error: `Erasure request is ${cur.rows[0].status}; only REQUESTED/APPROVED can be rejected` };
        }
        await db.query(`update erasure_request set status = 'REJECTED' where id = $1`, [req.params.id]);
        await writeAudit(db, ctx, {
          action: 'reject', entityType: 'erasure_request', entityId: req.params.id,
          before: { status: cur.rows[0].status }, after: { status: 'REJECTED' }, actorLabel: req.auth?.displayName,
        });
        return { id: req.params.id, status: 'REJECTED' };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/retention/erasure/:id/execute',
    { preHandler: requirePermission('retention:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const cur = await db.query<{ status: string; subject_entity: string; subject_id: string }>(
          `select status, subject_entity, subject_id from erasure_request where id = $1`,
          [req.params.id],
        );
        if (!cur.rows[0]) { reply.code(404); return { error: 'Erasure request not found' }; }
        const r = cur.rows[0];
        if (r.status !== 'APPROVED') {
          reply.code(409);
          return { error: `Erasure request is ${r.status}; only an APPROVED request can be executed` };
        }
        // A hold covering the subject blocks erasure. A global hold (null scope),
        // a whole-type hold (null entity_id) or an exact-record hold all count.
        const hold = await db.query<{ id: string; name: string }>(
          `select id, name from legal_hold
            where active
              and (entity_type is null or entity_type = $1)
              and (entity_id is null or entity_id = $2)
            limit 1`,
          [r.subject_entity, r.subject_id],
        );
        if (hold.rows[0]) {
          await db.query(`update erasure_request set status = 'BLOCKED_BY_HOLD' where id = $1`, [req.params.id]);
          await writeAudit(db, ctx, {
            action: 'blocked_by_hold', entityType: 'erasure_request', entityId: req.params.id,
            after: { holdId: hold.rows[0].id, holdName: hold.rows[0].name }, actorLabel: req.auth?.displayName,
          });
          reply.code(409);
          return { error: 'BLOCKED_BY_HOLD', status: 'BLOCKED_BY_HOLD', holdId: hold.rows[0].id, holdName: hold.rows[0].name };
        }

        if (r.subject_entity !== 'party') {
          reply.code(422);
          return { error: `Erasure is only implemented for 'party' subjects (got '${r.subject_entity}')` };
        }

        // Disposal action from an active schedule, defaulting to ANONYMISE.
        const sched = await db.query<{ action: string }>(
          `select action from retention_schedule where entity = 'party' and active order by created_at desc limit 1`,
        );
        const action = sched.rows[0]?.action ?? 'ANONYMISE';

        // Honest erasure: strip PII, keep the row (id + financial refs) intact.
        // Contacts are the only place free-text PII lives, so remove them.
        const softDelete = action === 'DELETE';
        const upd = await db.query<{ id: string }>(
          `update party
              set legal_name = '[erased]',
                  short_name = '[erased]',
                  identifiers = '{}'::jsonb,
                  is_deleted = case when $2 then true else is_deleted end,
                  updated_at = now()
            where id = $1
            returning id`,
          [r.subject_id, softDelete],
        );
        if (!upd.rows[0]) {
          reply.code(404);
          return { error: `Subject party ${r.subject_id} not found` };
        }
        const contacts = await db.query(`delete from party_contact where party_id = $1`, [r.subject_id]);

        await db.query(
          `update erasure_request set status = 'EXECUTED', executed_at = now() where id = $1`,
          [req.params.id],
        );
        // Audit records the action, not the erased values (re-storing PII would
        // defeat the erasure); the subject id links it to the surviving row.
        await writeAudit(db, ctx, {
          action: 'execute', entityType: 'erasure_request', entityId: req.params.id,
          before: { status: 'APPROVED' },
          after: {
            status: 'EXECUTED', disposalAction: action, subjectEntity: 'party', subjectId: r.subject_id,
            fieldsErased: ['legal_name', 'short_name', 'identifiers'], contactsRemoved: contacts.rowCount ?? 0,
            softDeleted: softDelete,
          },
          actorLabel: req.auth?.displayName,
        });
        return {
          id: req.params.id, status: 'EXECUTED', disposalAction: action,
          subjectId: r.subject_id, softDeleted: softDelete, contactsRemoved: contacts.rowCount ?? 0,
        };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Due candidates: records past their retention schedule as of a date. Honest
  // labelling - these are candidates for the schedule's action, never deleted
  // automatically. Only entities we can anchor to a real date are scanned.
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { asOf?: string } }>(
    '/api/retention/due',
    { preHandler: requirePermission('retention:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const asOf = req.query.asOf ?? new Date().toISOString().slice(0, 10);
      if (Number.isNaN(Date.parse(asOf))) {
        reply.code(400);
        return { error: 'asOf must be a valid date' };
      }
      return runAs(ctx, async (db) => {
        const schedules = await db.query<{
          id: string; entity: string; retention_months: number; basis: string; action: string;
        }>(
          `select id, entity, retention_months, basis, action from retention_schedule where active`,
        );
        const candidates: Array<Record<string, unknown>> = [];
        const skipped: string[] = [];
        for (const s of schedules.rows) {
          const map = DUE_ENTITIES[s.entity];
          if (!map) { skipped.push(s.entity); continue; }
          const dateCol = s.basis === 'CLOSED' ? map.closed : map.created;
          const softClause = map.softDelete ? 'and not is_deleted' : '';
          const { rows } = await db.query(
            `select id,
                    to_char(${dateCol}, 'YYYY-MM-DD') as "basisDate"
               from ${map.table}
              where tenant_id = app_current_tenant()
                ${softClause}
                and ${dateCol} is not null
                and ${dateCol} < ($1::date - make_interval(months => $2))
              order by ${dateCol} asc
              limit 500`,
            [asOf, s.retention_months],
          );
          for (const row of rows) {
            candidates.push({
              entity: s.entity, id: (row as { id: string }).id,
              basis: s.basis, basisDate: (row as { basisDate: string }).basisDate,
              action: s.action, scheduleId: s.id,
            });
          }
        }
        return { asOf, candidates, skippedEntities: skipped, note: 'Candidates only - RIOS never auto-deletes.' };
      });
    },
  );
}
