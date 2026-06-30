/**
 * Designer surfaces (brief §10.3): the no-code Workflow Designer and Business
 * Rules engine. Both author *metadata* — versioned `config_document` rows of
 * `kind: 'workflow'` and `kind: 'rule'` — and both interpret it with the pure
 * engines in `@rios/domain` (validateWorkflow/applyEvent, evaluateRuleSet). No
 * definition ever executes code; the server only ever interprets a JSON AST.
 *
 * Lifecycle mirrors the rest of config: author a `draft`, validate, then publish
 * (which archives the previous published version). The published version is what
 * runtime consumers load. All mutations are audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  validateWorkflow,
  applyEvent,
  availableTransitions,
  evaluateRuleSet,
  type WorkflowDefinition,
  type RuleSet,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const saveSchema = z.object({
  key: z.string().min(1),
  name: z.string().optional(),
  body: z.record(z.unknown()),
  publish: z.boolean().optional(),
});

/** Shared list/get/save/publish handlers for a config_document kind. */
function registerDefinitions(
  app: FastifyInstance,
  kind: 'workflow' | 'rule',
  validate: (body: unknown) => { code: string; message: string }[],
) {
  const base = kind === 'workflow' ? 'workflows' : 'rules';

  // List the latest version of every definition of this kind.
  app.get(`/api/designer/${base}`, { preHandler: requirePermission('config:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select distinct on (key) key, version, status, name, created_at as "createdAt"
           from (
             select key, version, status, body->>'name' as name, created_at
               from config_document where kind = $1
           ) d
          order by key, version desc`,
        [kind],
      );
      return { definitions: rows };
    });
  });

  // All versions for one key, newest first.
  app.get<{ Params: { key: string } }>(
    `/api/designer/${base}/:key`,
    { preHandler: requirePermission('config:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, key, version, status, body, created_at as "createdAt"
             from config_document where kind = $1 and key = $2 order by version desc`,
          [kind, req.params.key],
        );
        if (rows.length === 0) {
          reply.code(404);
          return { error: 'Definition not found' };
        }
        return { key: req.params.key, versions: rows };
      });
    },
  );

  // Create the next draft version (optionally publish it immediately).
  app.post(`/api/designer/${base}`, { preHandler: requirePermission('config:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid definition', details: parsed.error.flatten() };
    }
    const { key, name, body, publish } = parsed.data;
    const def = { key, name, ...body };
    const issues = validate(def);
    if (issues.length > 0) {
      reply.code(422);
      return { error: 'Definition is not valid', issues };
    }
    return runAs(ctx, async (db) => {
      const next = await db.query<{ v: number }>(
        `select coalesce(max(version),0)+1 as v from config_document where kind = $1 and key = $2`,
        [kind, key],
      );
      const version = next.rows[0]!.v;
      const status = publish ? 'published' : 'draft';
      if (publish) {
        await db.query(
          `update config_document set status = 'archived' where kind = $1 and key = $2 and status = 'published'`,
          [kind, key],
        );
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into config_document (tenant_id, kind, key, version, status, body, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, kind, key, version, status, JSON.stringify(def), ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: publish ? 'publish' : 'create',
        entityType: `config_document:${kind}`,
        entityId: rows[0]!.id,
        after: { key, version, status },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id, key, version, status };
    });
  });

  // Publish a specific draft version (archives the current published one).
  app.post<{ Params: { key: string; version: string } }>(
    `/api/designer/${base}/:key/versions/:version/publish`,
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const version = Number(req.params.version);
      return runAs(ctx, async (db) => {
        const found = await db.query<{ id: string; body: unknown }>(
          `select id, body from config_document where kind = $1 and key = $2 and version = $3`,
          [kind, req.params.key, version],
        );
        if (!found.rows[0]) {
          reply.code(404);
          return { error: 'Version not found' };
        }
        const issues = validate(found.rows[0].body);
        if (issues.length > 0) {
          reply.code(422);
          return { error: 'Definition is not valid', issues };
        }
        await db.query(
          `update config_document set status = 'archived' where kind = $1 and key = $2 and status = 'published'`,
          [kind, req.params.key],
        );
        await db.query(`update config_document set status = 'published' where id = $1`, [found.rows[0].id]);
        await writeAudit(db, ctx, {
          action: 'publish',
          entityType: `config_document:${kind}`,
          entityId: found.rows[0].id,
          after: { key: req.params.key, version },
          actorLabel: req.auth?.displayName,
        });
        return { key: req.params.key, version, status: 'published' };
      });
    },
  );
}

export async function designerModule(app: FastifyInstance): Promise<void> {
  registerDefinitions(app, 'workflow', (body) => validateWorkflow(body as WorkflowDefinition));
  // A rule set is valid as long as it carries a rules array; per-rule shape is
  // tolerated by the (total) evaluator, so we only check the envelope here.
  registerDefinitions(app, 'rule', (body) => {
    const b = body as { rules?: unknown };
    return Array.isArray(b.rules) ? [] : [{ code: 'no_rules', message: 'A rule set must have a "rules" array.' }];
  });

  // --- Workflow simulator: given a definition (by key, or inline) drive an event ---
  app.post<{ Body: { key?: string; definition?: WorkflowDefinition; state: string; event: string } }>(
    '/api/designer/workflows/simulate',
    { preHandler: requirePermission('config:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const { key, definition, state, event } = req.body ?? ({} as never);
      return runAs(ctx, async (db) => {
        let def = definition;
        if (!def && key) {
          const { rows } = await db.query<{ body: WorkflowDefinition }>(
            `select body from config_document where kind = 'workflow' and key = $1
              order by (status = 'published') desc, version desc limit 1`,
            [key],
          );
          def = rows[0]?.body;
        }
        if (!def) {
          reply.code(404);
          return { error: 'No workflow definition supplied or found' };
        }
        const result = applyEvent(def, state, event, req.auth?.permissions);
        return { result, available: availableTransitions(def, result.state).map((t) => t.event) };
      });
    },
  );

  // --- Rules tester: evaluate a rule set (by key, or inline) against a context ---
  app.post<{ Body: { key?: string; ruleSet?: RuleSet; context: Record<string, unknown> } }>(
    '/api/designer/rules/evaluate',
    { preHandler: requirePermission('config:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const { key, ruleSet, context } = req.body ?? ({} as never);
      return runAs(ctx, async (db) => {
        let set = ruleSet;
        if (!set && key) {
          const { rows } = await db.query<{ body: RuleSet }>(
            `select body from config_document where kind = 'rule' and key = $1
              order by (status = 'published') desc, version desc limit 1`,
            [key],
          );
          set = rows[0]?.body;
        }
        if (!set) {
          reply.code(404);
          return { error: 'No rule set supplied or found' };
        }
        return { outcome: evaluateRuleSet(set, context ?? {}) };
      });
    },
  );
}
