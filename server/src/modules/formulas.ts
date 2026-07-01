/**
 * Formula Engine (metadata-driven reinsurance calculations). Tenants can store,
 * version and effective-date FormulaDefinitions - the same shape consumed by the
 * pure @rios/domain interpreter (computeFormula / validateFormula) - so the
 * reinsurance math can be edited without a redeploy. When a tenant has stored no
 * definitions we fall back to the seed DEFAULT_FORMULAS. Evaluation is a pure
 * calc over inputs, returning the value plus a step-by-step breakdown.
 *
 * A formula_override records an authorised, reasoned override of a
 * system-computed field value, retaining the original (via resolveField's model)
 * so the system value can be restored. Money stays in integer minor units.
 *
 * Reads are open to any authenticated tenant user; authoring and overriding gate
 * on admin:manage; all mutations are audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  computeFormula, validateFormula, resolveField, explainFormula,
  DEFAULT_FORMULAS, getFormula, type FormulaDefinition,
} from '@rios/domain';
import type { Db } from '../db.js';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const termSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  expr: z.string().min(1),
});

const definitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  version: z.number().int().optional(),
  effectiveFrom: z.string().optional(),
  effectiveTo: z.string().optional(),
  inputs: z.array(z.string()).default([]),
  constants: z.record(z.number()).optional(),
  terms: z.array(termSchema).default([]),
  result: z.string().min(1),
  resultLabel: z.string().optional(),
});

/** Latest active stored definition for a key, or undefined if none stored. */
async function storedLatest(db: Db, key: string): Promise<FormulaDefinition | undefined> {
  const { rows } = await db.query<{ definition: FormulaDefinition }>(
    `select definition from formula_definition
      where key = $1 and is_active
      order by version desc limit 1`, [key]);
  return rows[0]?.definition;
}

export async function formulasModule(app: FastifyInstance): Promise<void> {
  // ---- List active formula definitions (fallback to the seed library) -------
  app.get<{ Querystring: { category?: string } }>('/api/formulas', async (req) => {
    const ctx = authContext(req);
    const category = req.query.category;
    return runAs(ctx, async (db) => {
      // Latest active version per key.
      const { rows } = await db.query<{ definition: FormulaDefinition }>(
        `select distinct on (key) definition
           from formula_definition
          where is_active
          order by key, version desc`);
      let formulas: FormulaDefinition[] = rows.length
        ? rows.map((r) => r.definition)
        : DEFAULT_FORMULAS;
      if (category) formulas = formulas.filter((f) => f.category === category);
      return { formulas, source: rows.length ? 'tenant' : 'default' };
    });
  });

  // ---- Latest active version of a key + the list of stored versions ---------
  app.get<{ Params: { key: string } }>('/api/formulas/:key', async (req, reply) => {
    const ctx = authContext(req);
    const key = req.params.key;
    return runAs(ctx, async (db) => {
      const versions = await db.query<{ version: number; isActive: boolean; effectiveFrom: string | null; effectiveTo: string | null; createdAt: string }>(
        `select version, is_active as "isActive",
                to_char(effective_from,'YYYY-MM-DD') as "effectiveFrom",
                to_char(effective_to,'YYYY-MM-DD') as "effectiveTo",
                to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "createdAt"
           from formula_definition where key = $1 order by version desc`, [key]);
      const latest = await storedLatest(db, key) ?? getFormula(key);
      if (!latest) { reply.code(404); return { error: 'Formula not found' }; }
      return { key, latest, versions: versions.rows, source: versions.rows.length ? 'tenant' : 'default' };
    });
  });

  // ---- Create / insert a new version of a formula (validated) ---------------
  app.post('/api/formulas', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = definitionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid formula', details: parsed.error.flatten() };
    }
    return runAs(ctx, async (db) => {
      // Next version for this key = max stored + 1 (unless the body pins one).
      const v = await db.query<{ v: number }>(
        `select coalesce(max(version),0)+1 as v from formula_definition where key = $1`, [parsed.data.key]);
      const version = parsed.data.version ?? v.rows[0]!.v;
      const def: FormulaDefinition = { ...parsed.data, version } as FormulaDefinition;

      const check = validateFormula(def);
      if (!check.ok) {
        reply.code(400);
        return { error: 'Formula failed validation', errors: check.errors };
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into formula_definition
           (tenant_id, key, name, category, version, effective_from, effective_to, definition, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.tenantId, def.key, def.name, def.category ?? null, version,
         def.effectiveFrom ?? null, def.effectiveTo ?? null, JSON.stringify(def), ctx.userId]);
      await writeAudit(db, ctx, {
        action: 'formula_create', entityType: 'formula_definition', entityId: rows[0]!.id,
        after: { key: def.key, version }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, key: def.key, version };
    });
  });

  // ---- Evaluate a formula (pure calc; definition resolved body>stored>default) -
  app.post<{ Params: { key: string }; Body: { inputs?: Record<string, number>; definition?: FormulaDefinition } }>(
    '/api/formulas/:key/evaluate', async (req, reply) => {
      const ctx = authContext(req);
      const key = req.params.key;
      const inputs = req.body?.inputs ?? {};
      return runAs(ctx, async (db) => {
        const def = req.body?.definition ?? await storedLatest(db, key) ?? getFormula(key);
        if (!def) { reply.code(404); return { error: 'Formula not found' }; }
        const result = computeFormula(def, inputs);
        // Grounded, deterministic explanation (AI Formula Assistant, no black box).
        return { ...result, explanation: explainFormula(def, result) };
      });
    });

  // ---- Validate a candidate definition (sandbox; no persistence) ------------
  app.post<{ Body: { definition?: FormulaDefinition } }>('/api/formulas/validate', async (req, reply) => {
    const parsed = definitionSchema.safeParse(req.body?.definition);
    if (!parsed.success) {
      return { ok: false, errors: parsed.error.flatten().formErrors.concat(
        Object.entries(parsed.error.flatten().fieldErrors).flatMap(([k, v]) => (v ?? []).map((m) => `${k}: ${m}`)),
      ) };
    }
    void reply;
    return validateFormula({ version: 1, ...parsed.data } as FormulaDefinition);
  });

  // ---- Override a system-computed field value (reasoned, audited) -----------
  const overrideSchema = z.object({
    entityType: z.string().min(1),
    entityId: z.string().min(1),
    field: z.string().min(1),
    formulaKey: z.string().optional(),
    originalMinor: z.number().int(),
    overrideMinor: z.number().int(),
    reason: z.string(),
  });
  app.post('/api/formulas/override', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid override', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    if (!b.reason.trim()) { reply.code(400); return { error: 'A reason is required to override a system value' }; }
    // Model the resolution so status/overridden is consistent with the domain.
    const resolved = resolveField({ systemValue: b.originalMinor, overrideValue: b.overrideMinor });
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string; createdAt: string }>(
        `insert into formula_override
           (tenant_id, entity_type, entity_id, field, formula_key, original_minor, override_minor, reason, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)
         returning id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "createdAt"`,
        [ctx.tenantId, b.entityType, b.entityId, b.field, b.formulaKey ?? null,
         b.originalMinor, b.overrideMinor, b.reason.trim(), ctx.userId]);
      await writeAudit(db, ctx, {
        action: 'formula_override', entityType: b.entityType, entityId: b.entityId,
        before: { field: b.field, valueMinor: b.originalMinor },
        after: { field: b.field, valueMinor: b.overrideMinor, reason: b.reason.trim() },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return {
        id: rows[0]!.id,
        entityType: b.entityType, entityId: b.entityId, field: b.field,
        formulaKey: b.formulaKey ?? null,
        originalMinor: b.originalMinor, overrideMinor: b.overrideMinor,
        reason: b.reason.trim(), status: 'ACTIVE', createdAt: rows[0]!.createdAt,
        value: resolved.value, overridden: resolved.overridden,
      };
    });
  });

  // ---- List overrides for an entity -----------------------------------------
  app.get<{ Querystring: { entityType?: string; entityId?: string } }>('/api/formulas/overrides', async (req, reply) => {
    const ctx = authContext(req);
    const { entityType, entityId } = req.query;
    if (!entityType || !entityId) { reply.code(400); return { error: 'entityType and entityId are required' }; }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, entity_type as "entityType", entity_id as "entityId", field,
                formula_key as "formulaKey", original_minor as "originalMinor",
                override_minor as "overrideMinor", reason, status,
                to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "createdAt",
                to_char(restored_at,'YYYY-MM-DD"T"HH24:MI:SSZ') as "restoredAt"
           from formula_override
          where entity_type = $1 and entity_id = $2
          order by created_at desc`, [entityType, entityId]);
      // bigint columns arrive as strings; coerce the money fields to numbers.
      const overrides = rows.map((r) => ({
        ...r,
        originalMinor: r.originalMinor == null ? null : Number(r.originalMinor),
        overrideMinor: r.overrideMinor == null ? null : Number(r.overrideMinor),
      }));
      return { overrides };
    });
  });

  // ---- Restore the system value (mark the override RESTORED) ----------------
  app.post<{ Params: { id: string } }>('/api/formulas/overrides/:id/restore', { preHandler: requirePermission('admin:manage') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const cur = await db.query<{ entity_type: string; entity_id: string; field: string; original_minor: string | null; status: string }>(
        `select entity_type, entity_id, field, original_minor, status from formula_override where id = $1`, [req.params.id]);
      if (!cur.rows[0]) { reply.code(404); return { error: 'Override not found' }; }
      const row = cur.rows[0];
      if (row.status === 'RESTORED') { reply.code(409); return { error: 'Override already restored' }; }
      await db.query(
        `update formula_override set status='RESTORED', restored_at=now(), restored_by=$2 where id = $1`,
        [req.params.id, ctx.userId]);
      await writeAudit(db, ctx, {
        action: 'formula_override_restore', entityType: row.entity_type, entityId: row.entity_id,
        before: { field: row.field, status: 'ACTIVE' },
        after: { field: row.field, status: 'RESTORED', valueMinor: row.original_minor == null ? null : Number(row.original_minor) },
        actorLabel: req.auth?.displayName,
      });
      return { id: req.params.id, status: 'RESTORED' };
    });
  });
}
