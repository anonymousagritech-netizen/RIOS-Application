/**
 * Risk & capital management + RDS (brief §13). Surfaces the capital position
 * (own funds vs SCR) with a domain-computed adequacy verdict, a library of
 * Realistic Disaster Scenarios each netted to a post-event solvency ratio, and a
 * VaR/TVaR calculator over a supplied loss sample. All metrics come from the
 * pure @rios/domain engines; this module only persists inputs and exposes views.
 * risk:read to view, risk:write to author; mutations audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  capitalAdequacy,
  evaluateScenario,
  valueAtRisk,
  tailValueAtRisk,
} from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const positionSchema = z.object({
  asOfDate: z.string().optional(),
  currency: z.string().length(3).default('USD'),
  ownFundsMinor: z.number().int().nonnegative(),
  scrMinor: z.number().int().nonnegative(),
  mcrMinor: z.number().int().nonnegative().default(0),
  note: z.string().optional(),
});

const scenarioSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  peril: z.string().optional(),
  region: z.string().optional(),
  currency: z.string().length(3).default('USD'),
  grossLossMinor: z.number().int().nonnegative(),
  assumedRecoveryMinor: z.number().int().nonnegative().default(0),
});

const varSchema = z.object({
  losses: z.array(z.number()).min(1),
  confidence: z.number().min(0).max(1).default(0.995),
});

/** The latest capital position for the tenant, or null. */
async function latestPosition(db: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) {
  const { rows } = await db.query(
    `select id, as_of_date as "asOfDate", currency,
            own_funds_minor as "ownFundsMinor", scr_minor as "scrMinor", mcr_minor as "mcrMinor", note
       from capital_position order by as_of_date desc limit 1`,
  );
  return rows[0] ?? null;
}

export async function riskCapitalModule(app: FastifyInstance): Promise<void> {
  // Latest capital position + adequacy verdict.
  app.get('/api/risk/capital', { preHandler: requirePermission('risk:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const pos = await latestPosition(db);
      if (!pos) return { position: null, adequacy: null };
      const adequacy = capitalAdequacy(Number(pos.ownFundsMinor), Number(pos.scrMinor));
      return { position: pos, adequacy };
    });
  });

  app.post('/api/risk/capital', { preHandler: requirePermission('risk:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = positionSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid capital position', details: parsed.error.flatten() };
    }
    const p = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into capital_position (tenant_id, as_of_date, currency, own_funds_minor, scr_minor, mcr_minor, note, created_by)
         values ($1, coalesce($2::date, current_date), $3,$4,$5,$6,$7,$8)
         on conflict (tenant_id, as_of_date) do update set
           currency = excluded.currency, own_funds_minor = excluded.own_funds_minor,
           scr_minor = excluded.scr_minor, mcr_minor = excluded.mcr_minor, note = excluded.note
         returning id`,
        [ctx.tenantId, p.asOfDate ?? null, p.currency, p.ownFundsMinor, p.scrMinor, p.mcrMinor, p.note ?? null, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'capital_position', entityId: rows[0]!.id,
        after: { ownFundsMinor: p.ownFundsMinor, scrMinor: p.scrMinor }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // RDS library, each scenario netted to its post-event solvency ratio against
  // the latest capital position.
  app.get('/api/risk/scenarios', { preHandler: requirePermission('risk:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const pos = await latestPosition(db);
      const ownFunds = pos ? Number(pos.ownFundsMinor) : 0;
      const scr = pos ? Number(pos.scrMinor) : 0;
      const { rows } = await db.query(
        `select id, code, name, peril, region, currency,
                gross_loss_minor as "grossLossMinor", assumed_recovery_minor as "assumedRecoveryMinor", status
           from rds_scenario where status = 'ACTIVE'
          order by gross_loss_minor desc`,
      );
      const scenarios = rows.map((s) => {
        const result = evaluateScenario(
          Number(s.grossLossMinor),
          [{ source: 'reinsurance', recoveryMinor: Number(s.assumedRecoveryMinor) }],
          ownFunds, scr,
        );
        return { ...s, result };
      });
      return { scenarios, capital: pos };
    });
  });

  app.post('/api/risk/scenarios', { preHandler: requirePermission('risk:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = scenarioSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid scenario', details: parsed.error.flatten() };
    }
    const s = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into rds_scenario (tenant_id, code, name, peril, region, currency, gross_loss_minor, assumed_recovery_minor, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (tenant_id, code) do update set
           name = excluded.name, peril = excluded.peril, region = excluded.region,
           currency = excluded.currency, gross_loss_minor = excluded.gross_loss_minor,
           assumed_recovery_minor = excluded.assumed_recovery_minor
         returning id`,
        [ctx.tenantId, s.code, s.name, s.peril ?? null, s.region ?? null, s.currency, s.grossLossMinor, s.assumedRecoveryMinor, ctx.userId],
      );
      await writeAudit(db, ctx, {
        action: 'upsert', entityType: 'rds_scenario', entityId: rows[0]!.id,
        after: { code: s.code, grossLossMinor: s.grossLossMinor }, actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // VaR / TVaR over a supplied loss sample (analyst tool).
  app.post('/api/risk/var', { preHandler: requirePermission('risk:read') }, async (req, reply) => {
    const parsed = varSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid VaR request', details: parsed.error.flatten() };
    }
    const { losses, confidence } = parsed.data;
    return {
      confidence,
      sampleSize: losses.length,
      valueAtRiskMinor: valueAtRisk(losses, confidence),
      tailValueAtRiskMinor: tailValueAtRisk(losses, confidence),
    };
  });
}
