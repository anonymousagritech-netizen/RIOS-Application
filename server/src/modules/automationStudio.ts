/**
 * AI Automation Studio (brief §5). Binds a trigger (event type) to a business
 * rule set and a set of actions: when the trigger fires, the pure @rios/domain
 * rules engine evaluates the event and - if it passes - the configured actions
 * are returned for dispatch. Flows are versioned config_document rows (kind
 * 'automation'); this composes the existing rules engine + event bus rather than
 * adding a parallel one. config:read to view/run, config:write to author.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { evaluateRuleSet, type RuleSet } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const flowSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  trigger: z.object({ eventType: z.string().min(1) }),
  ruleSetKey: z.string().min(1),
  actions: z.array(z.object({ type: z.string(), target: z.string().optional() })).default([]),
});

export async function automationStudioModule(app: FastifyInstance): Promise<void> {
  app.get('/api/automation-studio/flows', { preHandler: requirePermission('config:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select distinct on (key) key, version, status, body->>'name' as name, body
           from config_document where kind = 'automation' order by key, version desc`,
      );
      return { flows: rows };
    });
  });

  app.post('/api/automation-studio/flows', { preHandler: requirePermission('config:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = flowSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid flow', details: parsed.error.flatten() }; }
    const def = parsed.data;
    return runAs(ctx, async (db) => {
      const next = await db.query<{ v: number }>(`select coalesce(max(version),0)+1 as v from config_document where kind='automation' and key=$1`, [def.key]);
      await db.query(`update config_document set status='archived' where kind='automation' and key=$1 and status='published'`, [def.key]);
      const { rows } = await db.query<{ id: string }>(
        `insert into config_document (tenant_id, kind, key, version, status, body, created_by)
         values ($1,'automation',$2,$3,'published',$4,$5) returning id`,
        [ctx.tenantId, def.key, next.rows[0]!.v, JSON.stringify(def), ctx.userId],
      );
      await writeAudit(db, ctx, { action: 'publish', entityType: 'config_document:automation', entityId: rows[0]!.id, after: { key: def.key }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id: rows[0]!.id, key: def.key, version: next.rows[0]!.v };
    });
  });

  // Fire a flow against an event context: evaluate the rule set, return the
  // actions to dispatch when it passes.
  app.post<{ Params: { key: string }; Body: { context?: Record<string, unknown> } }>(
    '/api/automation-studio/flows/:key/run',
    { preHandler: requirePermission('config:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const context = req.body?.context ?? {};
      return runAs(ctx, async (db) => {
        const flowRow = await db.query<{ body: { ruleSetKey: string; actions: { type: string; target?: string }[]; trigger: { eventType: string } } }>(
          `select body from config_document where kind='automation' and key=$1 order by (status='published') desc, version desc limit 1`,
          [req.params.key],
        );
        if (!flowRow.rows[0]) { reply.code(404); return { error: 'Flow not found' }; }
        const flow = flowRow.rows[0].body;
        const setRow = await db.query<{ body: RuleSet }>(
          `select body from config_document where kind='rule' and key=$1 order by (status='published') desc, version desc limit 1`,
          [flow.ruleSetKey],
        );
        if (!setRow.rows[0]) { reply.code(422); return { error: `Rule set "${flow.ruleSetKey}" not found` }; }
        const outcome = evaluateRuleSet(setRow.rows[0].body, context);
        return {
          key: req.params.key,
          trigger: flow.trigger,
          outcome,
          actions: outcome.ok ? flow.actions : [],
          dispatched: outcome.ok,
        };
      });
    },
  );
}
