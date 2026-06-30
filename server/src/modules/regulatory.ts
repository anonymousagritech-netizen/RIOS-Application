/**
 * Regulatory module (brief §18.1 IFRS 17 PAA, §18.2 Solvency II).
 *
 * IFRS 17 uses the Money/minor-unit domain (paaLrc, lic, onerousTest,
 * insuranceContractLiability): request amounts are major units converted with
 * fromMajor and persisted as *_minor. Solvency II works in plain major-unit
 * numbers (the domain takes plain numbers, not Money); we keep them straight and
 * store minor units in the DB by ×100/round for column consistency.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  paaLrc,
  lic,
  onerousTest,
  insuranceContractLiability,
  nonLifePremiumReserveRisk,
  aggregateScr,
  solvencyCapitalRequirement,
  minimumCapitalRequirement,
  solvencyRatio,
  fromMajor,
  money,
  type Money,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createGroupSchema = z.object({
  name: z.string().min(1),
  measurementModel: z.enum(['PAA']).default('PAA'),
  heldOrIssued: z.enum(['ISSUED', 'HELD']).default('ISSUED'),
  portfolio: z.string().optional(),
  cohortYear: z.number().int().optional(),
  currency: z.string().length(3),
});

const measureSchema = z.object({
  asAt: z.string().optional(),
  premiumReceived: z.number(),
  acquisitionCashFlows: z.number(),
  coverageElapsed: z.number(),
  expectedClaims: z.number(),
  discountFactor: z.number(),
  riskAdjustmentPct: z.number(),
});

const solvencyRunSchema = z.object({
  currency: z.string().length(3),
  asAt: z.string().optional(),
  modules: z.array(z.object({ name: z.string().min(1), scr: z.number() })).min(1),
  correlation: z.array(z.array(z.number())),
  operationalRisk: z.number(),
  adjustment: z.number().optional(),
  linearMcr: z.number(),
  absoluteFloor: z.number(),
  ownFunds: z.number(),
});

export async function regulatoryModule(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // IFRS 17 (§18.1)
  // -------------------------------------------------------------------------

  app.post('/api/regulatory/ifrs17/groups', { preHandler: requirePermission('regulatory:run') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid group', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into ifrs17_group
           (tenant_id, name, measurement_model, held_or_issued, portfolio, cohort_year, currency)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, b.name, b.measurementModel, b.heldOrIssued, b.portfolio ?? null, b.cohortYear ?? null, b.currency],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'ifrs17_group',
        entityId: id,
        after: { name: b.name, measurementModel: b.measurementModel, currency: b.currency },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, name: b.name, currency: b.currency };
    });
  });

  app.get('/api/regulatory/ifrs17/groups', { preHandler: requirePermission('regulatory:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select g.id, g.name, g.measurement_model as "measurementModel",
                g.held_or_issued as "heldOrIssued", g.portfolio, g.cohort_year as "cohortYear",
                g.currency, g.created_at as "createdAt",
                m.id as "latestMeasurementId", m.as_at as "latestAsAt",
                m.lrc_minor as "latestLrcMinor", m.lic_minor as "latestLicMinor",
                m.loss_component_minor as "latestLossComponentMinor",
                m.total_liability_minor as "latestTotalLiabilityMinor", m.is_onerous as "latestIsOnerous"
           from ifrs17_group g
           left join lateral (
             select * from ifrs17_measurement mm
              where mm.group_id = g.id order by mm.as_at desc, mm.created_at desc limit 1
           ) m on true
          order by g.created_at desc`,
      );
      return { groups: rows };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/regulatory/ifrs17/groups/:id/measure',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = measureSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid measurement', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const g = await db.query<{ currency: string }>(
          `select currency from ifrs17_group where id = $1`,
          [req.params.id],
        );
        if (!g.rows[0]) {
          reply.code(404);
          return { error: 'IFRS 17 group not found' };
        }
        const ccy = g.rows[0].currency;

        const lrc = paaLrc({
          premiumReceived: fromMajor(b.premiumReceived, ccy),
          acquisitionCashFlows: fromMajor(b.acquisitionCashFlows, ccy),
          coverageElapsed: b.coverageElapsed,
        });
        const licResult = lic({
          expectedClaims: fromMajor(b.expectedClaims, ccy),
          discountFactor: b.discountFactor,
          riskAdjustmentPct: b.riskAdjustmentPct,
        });
        const onerous = onerousTest({
          fulfilmentCashFlows: licResult.lic,
          lrcExcludingLossComponent: lrc.lrc,
        });
        const totalLiability: Money = insuranceContractLiability({
          lrc: lrc.lrc,
          lic: licResult.lic,
          lossComponent: onerous.lossComponent,
        });

        const { rows } = await db.query<{ id: string }>(
          `insert into ifrs17_measurement
             (tenant_id, group_id, as_at, inputs, lrc_minor, lic_minor, loss_component_minor,
              total_liability_minor, is_onerous, created_by)
           values ($1,$2,coalesce($3::date, current_date),$4,$5,$6,$7,$8,$9,$10) returning id`,
          [
            ctx.tenantId,
            req.params.id,
            b.asAt ?? null,
            JSON.stringify(b),
            lrc.lrc.amount,
            licResult.lic.amount,
            onerous.lossComponent.amount,
            totalLiability.amount,
            onerous.onerous,
            ctx.userId,
          ],
        );
        const id = rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'measure',
          entityType: 'ifrs17_measurement',
          entityId: id,
          after: { groupId: req.params.id, totalLiabilityMinor: totalLiability.amount, isOnerous: onerous.onerous },
          actorLabel: req.auth?.displayName,
        });

        return {
          id,
          groupId: req.params.id,
          currency: ccy,
          earnedPremium: lrc.earnedPremium.amount,
          lrc: lrc.lrc.amount,
          discountedClaims: licResult.discountedClaims.amount,
          riskAdjustment: licResult.riskAdjustment.amount,
          lic: licResult.lic.amount,
          onerous: onerous.onerous,
          lossComponent: onerous.lossComponent.amount,
          totalLiability: totalLiability.amount,
        };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/regulatory/ifrs17/groups/:id',
    { preHandler: requirePermission('regulatory:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const g = await db.query(
          `select id, name, measurement_model as "measurementModel", held_or_issued as "heldOrIssued",
                  portfolio, cohort_year as "cohortYear", currency, created_at as "createdAt"
             from ifrs17_group where id = $1`,
          [req.params.id],
        );
        if (!g.rows[0]) {
          reply.code(404);
          return { error: 'IFRS 17 group not found' };
        }
        const m = await db.query(
          `select id, as_at as "asAt", inputs, lrc_minor as "lrcMinor", lic_minor as "licMinor",
                  loss_component_minor as "lossComponentMinor", total_liability_minor as "totalLiabilityMinor",
                  is_onerous as "isOnerous", created_at as "createdAt"
             from ifrs17_measurement where group_id = $1 order by as_at desc, created_at desc`,
          [req.params.id],
        );
        return { ...g.rows[0], measurements: m.rows };
      });
    },
  );

  // -------------------------------------------------------------------------
  // Solvency II (§18.2)
  // -------------------------------------------------------------------------

  app.post('/api/regulatory/solvency2/run', { preHandler: requirePermission('regulatory:run') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = solvencyRunSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid solvency run', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    // Solvency II domain functions take plain major-unit numbers - pass straight through.
    const scrResult = solvencyCapitalRequirement({
      moduleScrs: b.modules.map((m) => m.scr),
      correlation: b.correlation,
      operationalRisk: b.operationalRisk,
      adjustment: b.adjustment,
    });
    const mcr = minimumCapitalRequirement({
      scr: scrResult.scr,
      linearMcr: b.linearMcr,
      absoluteFloor: b.absoluteFloor,
    });
    const ratio = solvencyRatio(b.ownFunds, scrResult.scr);
    const toMinor = (v: number) => Math.round(v * 100);

    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into solvency_run
           (tenant_id, as_at, currency, inputs, basic_scr_minor, operational_risk_minor,
            scr_minor, mcr_minor, own_funds_minor, solvency_ratio, status, created_by)
         values ($1,coalesce($2::date, current_date),$3,$4,$5,$6,$7,$8,$9,$10,'final',$11) returning id`,
        [
          ctx.tenantId,
          b.asAt ?? null,
          b.currency,
          JSON.stringify(b),
          toMinor(scrResult.basicScr),
          toMinor(b.operationalRisk),
          toMinor(scrResult.scr),
          toMinor(mcr),
          toMinor(b.ownFunds),
          ratio,
          ctx.userId,
        ],
      );
      const runId = rows[0]!.id;

      for (const m of b.modules) {
        await db.query(
          `insert into scr_module (tenant_id, run_id, module, scr_minor) values ($1,$2,$3,$4)`,
          [ctx.tenantId, runId, m.name, toMinor(m.scr)],
        );
      }

      await writeAudit(db, ctx, {
        action: 'run',
        entityType: 'solvency_run',
        entityId: runId,
        after: { currency: b.currency, scr: scrResult.scr, mcr, solvencyRatio: ratio },
        actorLabel: req.auth?.displayName,
      });

      reply.code(201);
      return {
        id: runId,
        currency: b.currency,
        basicScr: scrResult.basicScr,
        scr: scrResult.scr,
        mcr,
        solvencyRatio: ratio,
        modules: b.modules.map((m) => ({ name: m.name, scr: m.scr })),
      };
    });
  });

  app.get('/api/regulatory/solvency2/runs', { preHandler: requirePermission('regulatory:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const runs = await db.query<{ id: string }>(
        `select id, as_at as "asAt", currency, basic_scr_minor as "basicScrMinor",
                operational_risk_minor as "operationalRiskMinor", scr_minor as "scrMinor",
                mcr_minor as "mcrMinor", own_funds_minor as "ownFundsMinor",
                solvency_ratio as "solvencyRatio", status, created_at as "createdAt"
           from solvency_run order by as_at desc, created_at desc`,
      );
      const mods = await db.query<{ run_id: string }>(
        `select run_id, module, scr_minor as "scrMinor" from scr_module`,
      );
      const byRun = new Map<string, unknown[]>();
      for (const m of mods.rows) {
        const arr = byRun.get(m.run_id) ?? [];
        arr.push(m);
        byRun.set(m.run_id, arr);
      }
      return { runs: runs.rows.map((r) => ({ ...r, modules: byRun.get(r.id) ?? [] })) };
    });
  });
}
