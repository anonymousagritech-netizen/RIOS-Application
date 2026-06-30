/**
 * Pricing / Rating module (brief §7.8, §29.5).
 *
 * Burning-cost (experience) and exposure rating delegated to @rios/domain so the
 * numbers are the ones proved correct by its unit tests. Each call persists a
 * reproducible rating_run: its stored inputs fully determine its results (§29.5).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { burningCost, exposureRate, paretoCurve, fromMajor, type Layer } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const burningCostSchema = z.object({
  contractId: z.string().uuid().optional(),
  layerId: z.string().uuid().optional(),
  currency: z.string().length(3),
  attachment: z.number().nonnegative(),
  limit: z.number().positive(),
  reinstatements: z.number().int().nonnegative().optional(),
  loadingFactor: z.number().positive(),
  minRateOnLine: z.number().nonnegative().optional(),
  currentSubjectPremium: z.number().nonnegative(),
  years: z.array(
    z.object({
      year: z.number().int(),
      subjectPremium: z.number().nonnegative(),
      losses: z.array(z.number().nonnegative()),
    }),
  ).min(1),
});

const exposureSchema = z.object({
  contractId: z.string().uuid().optional(),
  currency: z.string().length(3),
  attachment: z.number().nonnegative(),
  limit: z.number().positive(),
  reinstatements: z.number().int().nonnegative().optional(),
  alpha: z.number().positive(),
  bands: z.array(
    z.object({
      bandLimit: z.number().positive(),
      premium: z.number().nonnegative(),
      lossRatio: z.number().nonnegative(),
    }),
  ).min(1),
});

export async function pricingModule(app: FastifyInstance): Promise<void> {
  // Burning-cost (experience) rating - persists a reproducible run.
  app.post('/api/pricing/burning-cost', { preHandler: requirePermission('pricing:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = burningCostSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid burning-cost input', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const ccy = b.currency;
    const layer: Layer = {
      attachment: fromMajor(b.attachment, ccy),
      limit: fromMajor(b.limit, ccy),
      reinstatements: b.reinstatements ?? 0,
    };
    const result = burningCost(
      {
        years: b.years.map((y) => ({
          year: y.year,
          subjectPremium: fromMajor(y.subjectPremium, ccy),
          losses: y.losses.map((l) => fromMajor(l, ccy)),
        })),
        layer,
        loadingFactor: b.loadingFactor,
        minRateOnLine: b.minRateOnLine,
      },
      fromMajor(b.currentSubjectPremium, ccy),
    );

    return runAs(ctx, async (db) => {
      const id = await persistRun(db, ctx, {
        contractId: b.contractId ?? null,
        layerId: b.layerId ?? null,
        method: 'BURNING_COST',
        inputs: b,
        results: result,
        technicalPremiumMinor: result.technicalPremium.amount,
        rateOnLine: result.rateOnLine,
        currency: ccy,
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, method: 'BURNING_COST', ...result };
    });
  });

  // Exposure rating with a first-loss-scale (Pareto-style) curve.
  app.post('/api/pricing/exposure', { preHandler: requirePermission('pricing:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = exposureSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid exposure input', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const ccy = b.currency;
    const layer: Layer = {
      attachment: fromMajor(b.attachment, ccy),
      limit: fromMajor(b.limit, ccy),
      reinstatements: b.reinstatements ?? 0,
    };
    const result = exposureRate(
      b.bands.map((band) => ({
        bandLimit: band.bandLimit,
        premium: fromMajor(band.premium, ccy),
        lossRatio: band.lossRatio,
      })),
      layer,
      paretoCurve(b.alpha),
    );

    return runAs(ctx, async (db) => {
      const id = await persistRun(db, ctx, {
        contractId: b.contractId ?? null,
        layerId: null,
        method: 'EXPOSURE',
        inputs: b,
        results: result,
        technicalPremiumMinor: result.technicalPremium.amount,
        rateOnLine: result.rateOnLine,
        currency: ccy,
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, method: 'EXPOSURE', ...result };
    });
  });

  // List rating runs (newest first).
  app.get<{ Querystring: { contractId?: string } }>(
    '/api/pricing/runs',
    { preHandler: requirePermission('pricing:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, contract_id as "contractId", layer_id as "layerId", method,
                  technical_premium_minor as "technicalPremiumMinor", rate_on_line as "rateOnLine",
                  currency, status, created_at as "createdAt"
             from rating_run
            where ($1::uuid is null or contract_id = $1)
            order by created_at desc`,
          [req.query.contractId ?? null],
        );
        return { runs: rows };
      });
    },
  );

  // A single run with its full inputs + results (proves reproducibility, §29.5).
  app.get<{ Params: { id: string } }>(
    '/api/pricing/runs/:id',
    { preHandler: requirePermission('pricing:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, contract_id as "contractId", layer_id as "layerId", method,
                  inputs, results, technical_premium_minor as "technicalPremiumMinor",
                  rate_on_line as "rateOnLine", currency, status, created_at as "createdAt"
             from rating_run where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Rating run not found' };
        }
        return rows[0];
      });
    },
  );
}

async function persistRun(
  db: Db,
  ctx: { tenantId: string; userId: string },
  run: {
    contractId: string | null;
    layerId: string | null;
    method: string;
    inputs: unknown;
    results: unknown;
    technicalPremiumMinor: number;
    rateOnLine: number;
    currency: string;
    actorLabel?: string;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into rating_run
       (tenant_id, contract_id, layer_id, method, inputs, results,
        technical_premium_minor, rate_on_line, currency, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'final',$10) returning id`,
    [
      ctx.tenantId, run.contractId, run.layerId, run.method,
      JSON.stringify(run.inputs), JSON.stringify(run.results),
      run.technicalPremiumMinor, run.rateOnLine, run.currency, ctx.userId,
    ],
  );
  const id = rows[0]!.id;
  await writeAudit(db, ctx, {
    action: 'create',
    entityType: 'rating_run',
    entityId: id,
    after: { method: run.method, technicalPremiumMinor: run.technicalPremiumMinor, rateOnLine: run.rateOnLine, currency: run.currency },
    actorLabel: run.actorLabel,
  });
  return id;
}
