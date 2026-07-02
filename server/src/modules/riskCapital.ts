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
  solvencyCapitalRequirement,
  minimumCapitalRequirement,
  riskMargin,
  eligibleOwnFunds,
  aggregateStandardFormulaBscr,
  csmRollforward,
  money,
  SII_BSCR_MODULES,
  SII_BSCR_CORRELATION,
  SII_BSCR_CORRELATION_SOURCE,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Inputs for a Solvency II Pillar 1 measurement run. Named module charges are
// aggregated with the published standard-formula correlation matrix (domain
// solvencyCorrelations), then op-risk + LAC adjustment give the SCR; the MCR
// corridor, cost-of-capital risk margin and own-funds eligibility follow.
const siiInputsSchema = z.object({
  currency: z.string().length(3).default('USD'),
  moduleCharges: z
    .object({
      market: z.number().int().nonnegative().default(0),
      default: z.number().int().nonnegative().default(0),
      life: z.number().int().nonnegative().default(0),
      health: z.number().int().nonnegative().default(0),
      nonLife: z.number().int().nonnegative().default(0),
    })
    .partial()
    .default({}),
  intangibleAssetRiskMinor: z.number().int().nonnegative().default(0),
  operationalRiskMinor: z.number().int().nonnegative().default(0),
  adjustmentMinor: z.number().int().default(0),
  linearMcrMinor: z.number().int().nonnegative().default(0),
  absoluteFloorMinor: z.number().int().nonnegative().default(0),
  ownFundsTiers: z
    .object({
      tier1Minor: z.number().int().nonnegative().default(0),
      tier2Minor: z.number().int().nonnegative().default(0),
      tier3Minor: z.number().int().nonnegative().default(0),
    })
    .default({ tier1Minor: 0, tier2Minor: 0, tier3Minor: 0 }),
  riskMargin: z
    .object({
      projectedScrMinor: z.array(z.number().int().nonnegative()).min(1),
      costOfCapital: z.number().min(0).default(0.06),
      riskFreeRate: z.number().default(0),
    })
    .optional(),
});

// Inputs for an IFRS 17 CSM roll-forward run (domain csmRollforward).
const ifrs17InputsSchema = z.object({
  currency: z.string().length(3).default('USD'),
  openingCsmMinor: z.number().int().nonnegative(),
  interestAccretionRate: z.number().default(0),
  newBusinessCsmMinor: z.number().int().nonnegative().default(0),
  changeInEstimatesMinor: z.number().int().default(0),
  coverageUnitsThisPeriod: z.number().nonnegative(),
  coverageUnitsRemaining: z.number().nonnegative(),
});

const runSchema = z.object({
  asOf: z.string().regex(DATE_RE).optional(),
  framework: z.enum(['SOLVENCY_II', 'IFRS17']),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

const rollforwardSchema = z.object({
  period: z.string().optional(),
  lines: z
    .array(
      z.object({
        lineItem: z.string().min(1),
        openingMinor: z.number().int(),
        movementMinor: z.number().int(),
        currency: z.string().length(3).optional(),
      }),
    )
    .optional(),
});

interface CapitalRunRow {
  id: string;
  as_of: string;
  framework: string;
  scr_minor: string | null;
  mcr_minor: string | null;
  risk_margin_minor: string | null;
  own_funds_minor: string | null;
  ratio: string | null;
  inputs: Record<string, unknown>;
  result: Record<string, unknown>;
  created_at: string;
}

// Run the Solvency II Pillar 1 engines (all pure @rios/domain) from parsed
// inputs. Capital figures are integer minor units in a single reporting
// currency; sqrt-based aggregates are rounded to minor units for persistence.
function computeSolvencyII(input: z.infer<typeof siiInputsSchema>) {
  const bscr = aggregateStandardFormulaBscr({
    charges: {
      market: input.moduleCharges.market ?? 0,
      default: input.moduleCharges.default ?? 0,
      life: input.moduleCharges.life ?? 0,
      health: input.moduleCharges.health ?? 0,
      nonLife: input.moduleCharges.nonLife ?? 0,
    },
    intangibleAssetRisk: input.intangibleAssetRiskMinor,
  });
  // Add operational risk + loss-absorbing-capacity adjustment via the tested
  // SCR engine (the BSCR is already diversified, so a 1x1 unit matrix is used).
  const scrResult = solvencyCapitalRequirement({
    moduleScrs: [bscr.bscr],
    correlation: [[1]],
    operationalRisk: input.operationalRiskMinor,
    adjustment: input.adjustmentMinor,
  });
  const scr = scrResult.scr;
  const mcr = minimumCapitalRequirement({
    scr,
    linearMcr: input.linearMcrMinor,
    absoluteFloor: input.absoluteFloorMinor,
  });
  const rm = input.riskMargin
    ? riskMargin(input.riskMargin.projectedScrMinor, input.riskMargin.costOfCapital, input.riskMargin.riskFreeRate)
    : 0;
  const tiers = {
    tier1: input.ownFundsTiers.tier1Minor ?? 0,
    tier2: input.ownFundsTiers.tier2Minor ?? 0,
    tier3: input.ownFundsTiers.tier3Minor ?? 0,
  };
  const totalOwnFunds = tiers.tier1 + tiers.tier2 + tiers.tier3;
  const eligibility = scr > 0 && mcr > 0 ? eligibleOwnFunds(tiers, scr, mcr) : null;
  const ownFunds = eligibility ? eligibility.eligibleForScr : totalOwnFunds;
  const ratio = eligibility ? eligibility.scrRatio : scr > 0 ? ownFunds / scr : null;

  return {
    scrMinor: Math.round(scr),
    mcrMinor: Math.round(mcr),
    riskMarginMinor: Math.round(rm),
    ownFundsMinor: Math.round(ownFunds),
    ratio,
    result: {
      currency: input.currency,
      bscr,
      scr: scrResult,
      mcr,
      riskMarginMinor: Math.round(rm),
      eligibility,
      totalOwnFundsMinor: totalOwnFunds,
    },
  };
}

// Run the IFRS 17 CSM roll-forward engine (domain csmRollforward).
function computeIfrs17(input: z.infer<typeof ifrs17InputsSchema>) {
  const cur = input.currency;
  const rf = csmRollforward({
    openingCsm: money(input.openingCsmMinor, cur),
    interestAccretionRate: input.interestAccretionRate,
    newBusinessCsm: money(input.newBusinessCsmMinor, cur),
    changeInEstimates: money(input.changeInEstimatesMinor, cur),
    coverageUnitsThisPeriod: input.coverageUnitsThisPeriod,
    coverageUnitsRemaining: input.coverageUnitsRemaining,
  });
  const openingCsmMinor = input.openingCsmMinor;
  const closingCsmMinor = rf.closingCsm.amount;
  return {
    openingCsmMinor,
    closingCsmMinor,
    releasedMinor: rf.released.amount,
    result: {
      currency: cur,
      openingCsmMinor,
      closingCsmMinor,
      releasedMinor: rf.released.amount,
      rollforward: {
        csmAfterInterestMinor: rf.csmAfterInterest.amount,
        csmAfterNewBusinessMinor: rf.csmAfterNewBusiness.amount,
        csmAfterChangesMinor: rf.csmAfterChanges.amount,
        releasedMinor: rf.released.amount,
        closingCsmMinor,
      },
    },
  };
}

async function loadCapitalRun(db: Db, id: string): Promise<CapitalRunRow | null> {
  const { rows } = await db.query<CapitalRunRow>(
    `select id, to_char(as_of,'YYYY-MM-DD') as as_of, framework,
            scr_minor, mcr_minor, risk_margin_minor, own_funds_minor, ratio,
            inputs, result, to_char(created_at,'YYYY-MM-DD') as created_at
       from capital_run where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function presentRun(r: CapitalRunRow) {
  return {
    id: r.id,
    asOf: r.as_of,
    framework: r.framework,
    scrMinor: r.scr_minor === null ? null : Number(r.scr_minor),
    mcrMinor: r.mcr_minor === null ? null : Number(r.mcr_minor),
    riskMarginMinor: r.risk_margin_minor === null ? null : Number(r.risk_margin_minor),
    ownFundsMinor: r.own_funds_minor === null ? null : Number(r.own_funds_minor),
    ratio: r.ratio === null ? null : Number(r.ratio),
    inputs: r.inputs,
    result: r.result,
    createdAt: r.created_at,
  };
}

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

  // ---------------------------------------------------------------------------
  // Persisted measurement runs (migration 0069). A run executes the appropriate
  // pure @rios/domain engine (Solvency II Pillar 1, or the IFRS 17 CSM
  // roll-forward) from its inputs and stores the headline figures + the full
  // inputs/result for later disclosure. Reads use risk:read, writes risk:write.
  // ---------------------------------------------------------------------------

  app.post('/api/risk-capital/runs', { preHandler: requirePermission('risk:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid capital run', details: parsed.error.flatten() };
    }
    const { asOf, framework, inputs } = parsed.data;

    let scrMinor: number | null = null;
    let mcrMinor: number | null = null;
    let riskMarginMinor: number | null = null;
    let ownFundsMinor: number | null = null;
    let ratio: number | null = null;
    let result: Record<string, unknown>;

    if (framework === 'SOLVENCY_II') {
      const inParsed = siiInputsSchema.safeParse(inputs);
      if (!inParsed.success) {
        reply.code(400);
        return { error: 'Invalid Solvency II inputs', details: inParsed.error.flatten() };
      }
      const c = computeSolvencyII(inParsed.data);
      scrMinor = c.scrMinor;
      mcrMinor = c.mcrMinor;
      riskMarginMinor = c.riskMarginMinor;
      ownFundsMinor = c.ownFundsMinor;
      ratio = c.ratio;
      result = c.result;
    } else {
      const inParsed = ifrs17InputsSchema.safeParse(inputs);
      if (!inParsed.success) {
        reply.code(400);
        return { error: 'Invalid IFRS 17 inputs', details: inParsed.error.flatten() };
      }
      const c = computeIfrs17(inParsed.data);
      result = c.result;
    }

    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into capital_run
           (tenant_id, as_of, framework, scr_minor, mcr_minor, risk_margin_minor, own_funds_minor, ratio, inputs, result, created_by)
         values ($1, coalesce($2::date, current_date), $3, $4,$5,$6,$7,$8, $9::jsonb, $10::jsonb, $11)
         returning id`,
        [
          ctx.tenantId, asOf ?? null, framework,
          scrMinor, mcrMinor, riskMarginMinor, ownFundsMinor, ratio,
          JSON.stringify(inputs), JSON.stringify(result), ctx.userId,
        ],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'run', entityType: 'capital_run', entityId: id,
        after: { framework, scrMinor, mcrMinor, ratio }, actorLabel: req.auth?.displayName,
      });
      const run = await loadCapitalRun(db, id);
      reply.code(201);
      return { run: presentRun(run!) };
    });
  });

  app.get('/api/risk-capital/runs', { preHandler: requirePermission('risk:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<CapitalRunRow>(
        `select id, to_char(as_of,'YYYY-MM-DD') as as_of, framework,
                scr_minor, mcr_minor, risk_margin_minor, own_funds_minor, ratio,
                inputs, result, to_char(created_at,'YYYY-MM-DD') as created_at
           from capital_run order by created_at desc`,
      );
      return { runs: rows.map(presentRun) };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/risk-capital/runs/:id',
    { preHandler: requirePermission('risk:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const run = await loadCapitalRun(db, req.params.id);
        if (!run) {
          reply.code(404);
          return { error: 'Capital run not found' };
        }
        return { run: presentRun(run) };
      });
    },
  );

  // Persist a disclosure roll-forward (opening + movement = closing) for a run.
  // Supply explicit lines, or omit them for an IFRS 17 run to auto-derive the
  // CSM reconciliation from the stored result.
  app.post<{ Params: { id: string } }>(
    '/api/risk-capital/runs/:id/rollforward',
    { preHandler: requirePermission('risk:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = rollforwardSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid roll-forward', details: parsed.error.flatten() };
      }
      const body = parsed.data;
      return runAs(ctx, async (db) => {
        const run = await loadCapitalRun(db, req.params.id);
        if (!run) {
          reply.code(404);
          return { error: 'Capital run not found' };
        }
        const runCurrency = (run.result?.currency as string | undefined) ?? 'USD';

        let lines = body.lines ?? [];
        if (lines.length === 0) {
          if (run.framework === 'IFRS17') {
            const opening = Number(run.result?.openingCsmMinor ?? 0);
            const closing = Number(run.result?.closingCsmMinor ?? 0);
            lines = [{ lineItem: 'CSM', openingMinor: opening, movementMinor: closing - opening, currency: runCurrency }];
          } else {
            reply.code(400);
            return { error: 'Provide roll-forward lines (opening/movement) for a SOLVENCY_II run' };
          }
        }

        const persisted: {
          lineItem: string;
          openingMinor: number;
          movementMinor: number;
          closingMinor: number;
          currency: string;
        }[] = [];
        for (const l of lines) {
          const closingMinor = l.openingMinor + l.movementMinor;
          const currency = l.currency ?? runCurrency;
          await db.query(
            `insert into disclosure_rollforward
               (tenant_id, run_id, framework, line_item, opening_minor, movement_minor, closing_minor, currency, period)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [ctx.tenantId, run.id, run.framework, l.lineItem, l.openingMinor, l.movementMinor, closingMinor, currency, body.period ?? null],
          );
          persisted.push({ lineItem: l.lineItem, openingMinor: l.openingMinor, movementMinor: l.movementMinor, closingMinor, currency });
        }

        await writeAudit(db, ctx, {
          action: 'rollforward', entityType: 'capital_run', entityId: run.id,
          after: { framework: run.framework, lines: persisted.length, period: body.period ?? null },
          actorLabel: req.auth?.displayName,
        });

        reply.code(201);
        return { runId: run.id, framework: run.framework, period: body.period ?? null, lines: persisted };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/risk-capital/runs/:id/rollforward',
    { preHandler: requirePermission('risk:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const run = await loadCapitalRun(db, req.params.id);
        if (!run) {
          reply.code(404);
          return { error: 'Capital run not found' };
        }
        const { rows } = await db.query(
          `select line_item as "lineItem", opening_minor as "openingMinor",
                  movement_minor as "movementMinor", closing_minor as "closingMinor",
                  currency, period, to_char(created_at,'YYYY-MM-DD') as "createdAt"
             from disclosure_rollforward where run_id = $1 order by created_at, line_item`,
          [run.id],
        );
        const lines = rows.map((r) => ({
          ...r,
          openingMinor: Number(r.openingMinor),
          movementMinor: Number(r.movementMinor),
          closingMinor: Number(r.closingMinor),
        }));
        return { runId: run.id, framework: run.framework, lines };
      });
    },
  );

  // The shipped Solvency II standard-formula correlation matrix (labelled).
  app.get('/api/risk-capital/correlations', { preHandler: requirePermission('risk:read') }, async () => {
    return {
      framework: 'SOLVENCY_II',
      modules: [...SII_BSCR_MODULES],
      matrix: SII_BSCR_CORRELATION.map((r) => [...r]),
      source: SII_BSCR_CORRELATION_SOURCE,
      certified: false,
    };
  });
}
