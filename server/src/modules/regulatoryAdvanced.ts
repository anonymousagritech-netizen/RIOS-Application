/**
 * Regulatory (advanced) module — IFRS 17 GMM/VFA measurement + CSM roll-forward,
 * and governed regulatory returns (brief §18.3 / §18.4).
 *
 * Extends the §18.1/§18.2 regulatory module: it adds the General Measurement
 * Model (GMM/BBA) and Variable Fee Approach (VFA) — CSM, fulfilment cash flows
 * and the contractual-service-margin roll-forward — and a small suite of
 * governed regulatory returns (Solvency II QRT, US Schedule F, Lloyd's, IFRS 17
 * disclosure) that aggregate the tenant's own RLS-scoped data into a prepared,
 * signed-off pack.
 *
 * IFRS 17 uses the Money/minor-unit domain (gmmInitialMeasurement,
 * csmRollforward, vfaCsmRollforward): request amounts are MAJOR units converted
 * with fromMajor and persisted as *_minor. Returns aggregate *_minor figures
 * straight out of the database.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  gmmInitialMeasurement,
  csmRollforward,
  vfaCsmRollforward,
  fromMajor,
  money,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const measureGmmSchema = z.object({
  asAt: z.string().optional(),
  presentValueOfPremiums: z.number(),
  presentValueOfClaims: z.number(),
  riskAdjustment: z.number(),
});

const csmRollforwardSchema = z.object({
  asAt: z.string().optional(),
  openingCsm: z.number(),
  interestAccretionRate: z.number(),
  newBusinessCsm: z.number().optional(),
  changeInEstimates: z.number().optional(),
  coverageUnitsThisPeriod: z.number(),
  coverageUnitsRemaining: z.number(),
});

const measureVfaSchema = csmRollforwardSchema.extend({
  changeInVariableFee: z.number(),
});

const returnKinds = ['SOLVENCY2_QRT', 'SCHEDULE_F', 'LLOYDS_RETURN', 'IFRS17_DISCLOSURE'] as const;

const createReturnSchema = z.object({
  kind: z.enum(returnKinds),
  period: z.string().optional(),
  reference: z.string().optional(),
});

export async function regulatoryAdvancedModule(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // IFRS 17 GMM / VFA (§18.1) — operate on an existing ifrs17_group
  // -------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/api/regulatory/ifrs17/groups/:id/measure-gmm',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = measureGmmSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid GMM measurement', details: parsed.error.flatten() };
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

        const result = gmmInitialMeasurement({
          presentValueOfPremiums: fromMajor(b.presentValueOfPremiums, ccy),
          presentValueOfClaims: fromMajor(b.presentValueOfClaims, ccy),
          riskAdjustment: fromMajor(b.riskAdjustment, ccy),
        });

        const ra = fromMajor(b.riskAdjustment, ccy);
        const lic = fromMajor(b.presentValueOfClaims, ccy);
        // total liability = fulfilment cash flows + CSM (kept in Money for currency safety)
        const totalLiability = money(result.fulfilmentCashFlows.amount + result.csm.amount, ccy).amount;

        const { rows } = await db.query<{ id: string }>(
          `insert into ifrs17_measurement
             (tenant_id, group_id, as_at, inputs, lrc_minor, lic_minor, loss_component_minor,
              total_liability_minor, is_onerous, csm_minor, fulfilment_cf_minor,
              risk_adjustment_minor, created_by)
           values ($1,$2,coalesce($3::date, current_date),$4,0,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [
            ctx.tenantId,
            req.params.id,
            b.asAt ?? null,
            JSON.stringify({ model: 'GMM', ...b }),
            lic.amount,
            result.lossComponent.amount,
            totalLiability,
            result.onerous,
            result.csm.amount,
            result.fulfilmentCashFlows.amount,
            ra.amount,
            ctx.userId,
          ],
        );
        const id = rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'measure',
          entityType: 'ifrs17_measurement',
          entityId: id,
          after: { groupId: req.params.id, model: 'GMM', csmMinor: result.csm.amount, onerous: result.onerous },
          actorLabel: req.auth?.displayName,
        });

        return {
          id,
          groupId: req.params.id,
          currency: ccy,
          model: 'GMM',
          fulfilmentCashFlowsMinor: result.fulfilmentCashFlows.amount,
          csmMinor: result.csm.amount,
          onerous: result.onerous,
          lossComponentMinor: result.lossComponent.amount,
          riskAdjustmentMinor: ra.amount,
          licMinor: lic.amount,
          totalLiabilityMinor: totalLiability,
        };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/regulatory/ifrs17/groups/:id/csm-rollforward',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = csmRollforwardSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid CSM roll-forward', details: parsed.error.flatten() };
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

        const result = csmRollforward({
          openingCsm: fromMajor(b.openingCsm, ccy),
          interestAccretionRate: b.interestAccretionRate,
          newBusinessCsm: b.newBusinessCsm !== undefined ? fromMajor(b.newBusinessCsm, ccy) : undefined,
          changeInEstimates: b.changeInEstimates !== undefined ? fromMajor(b.changeInEstimates, ccy) : undefined,
          coverageUnitsThisPeriod: b.coverageUnitsThisPeriod,
          coverageUnitsRemaining: b.coverageUnitsRemaining,
        });

        const id = await persistRollforward(db, ctx, req.params.id, b.asAt ?? null, 'GMM', result.closingCsm.amount, {
          model: 'CSM_ROLLFORWARD',
          ...b,
        });
        await writeAudit(db, ctx, {
          action: 'measure',
          entityType: 'ifrs17_measurement',
          entityId: id,
          after: { groupId: req.params.id, model: 'CSM_ROLLFORWARD', closingCsmMinor: result.closingCsm.amount },
          actorLabel: req.auth?.displayName,
        });

        return {
          id,
          groupId: req.params.id,
          currency: ccy,
          csmAfterInterest: result.csmAfterInterest.amount,
          csmAfterChanges: result.csmAfterChanges.amount,
          released: result.released.amount,
          closingCsm: result.closingCsm.amount,
        };
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/regulatory/ifrs17/groups/:id/measure-vfa',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = measureVfaSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid VFA measurement', details: parsed.error.flatten() };
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

        const result = vfaCsmRollforward({
          openingCsm: fromMajor(b.openingCsm, ccy),
          interestAccretionRate: b.interestAccretionRate,
          newBusinessCsm: b.newBusinessCsm !== undefined ? fromMajor(b.newBusinessCsm, ccy) : undefined,
          changeInEstimates: b.changeInEstimates !== undefined ? fromMajor(b.changeInEstimates, ccy) : undefined,
          coverageUnitsThisPeriod: b.coverageUnitsThisPeriod,
          coverageUnitsRemaining: b.coverageUnitsRemaining,
          changeInVariableFee: fromMajor(b.changeInVariableFee, ccy),
        });

        const id = await persistRollforward(db, ctx, req.params.id, b.asAt ?? null, 'VFA', result.closingCsm.amount, {
          model: 'VFA',
          ...b,
        });
        await writeAudit(db, ctx, {
          action: 'measure',
          entityType: 'ifrs17_measurement',
          entityId: id,
          after: { groupId: req.params.id, model: 'VFA', closingCsmMinor: result.closingCsm.amount },
          actorLabel: req.auth?.displayName,
        });

        return {
          id,
          groupId: req.params.id,
          currency: ccy,
          csmAfterInterest: result.csmAfterInterest.amount,
          csmAfterChanges: result.csmAfterChanges.amount,
          released: result.released.amount,
          closingCsm: result.closingCsm.amount,
        };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/regulatory/ifrs17/groups/:id/measurements',
    { preHandler: requirePermission('regulatory:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, as_at as "asAt", inputs, lrc_minor as "lrcMinor", lic_minor as "licMinor",
                  loss_component_minor as "lossComponentMinor", total_liability_minor as "totalLiabilityMinor",
                  is_onerous as "isOnerous", csm_minor as "csmMinor",
                  fulfilment_cf_minor as "fulfilmentCfMinor", risk_adjustment_minor as "riskAdjustmentMinor",
                  created_at as "createdAt"
             from ifrs17_measurement where group_id = $1 order by as_at desc, created_at desc`,
          [req.params.id],
        );
        return { groupId: req.params.id, measurements: rows };
      });
    },
  );

  // -------------------------------------------------------------------------
  // Regulatory returns (§18.3 / §18.4) — governed packs over tenant data
  // -------------------------------------------------------------------------

  app.post('/api/regulatory/returns', { preHandler: requirePermission('regulatory:run') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createReturnSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid return', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const generated = await generateReturn(db, b.kind);

      const { rows } = await db.query<{ id: string }>(
        `insert into regulatory_return
           (tenant_id, kind, period, reference, status, data, created_by)
         values ($1,$2,$3,$4,'prepared',$5,$6) returning id`,
        [ctx.tenantId, b.kind, b.period ?? null, b.reference ?? null, JSON.stringify(generated.data), ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'prepare',
        entityType: 'regulatory_return',
        entityId: id,
        after: { kind: b.kind, period: b.period ?? null, summary: generated.summary },
        actorLabel: req.auth?.displayName,
      });

      reply.code(201);
      return {
        id,
        kind: b.kind,
        status: 'prepared',
        rowCount: generated.rowCount,
        summary: generated.summary,
      };
    });
  });

  app.get<{ Querystring: { kind?: string } }>(
    '/api/regulatory/returns',
    { preHandler: requirePermission('regulatory:read') },
    async (req) => {
      const ctx = authContext(req);
      const kind = req.query.kind;
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, kind, period, reference, status, created_at as "createdAt",
                  created_by as "createdBy", approved_by as "approvedBy"
             from regulatory_return
            where ($1::text is null or kind = $1)
            order by created_at desc`,
          [kind ?? null],
        );
        return { returns: rows };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/regulatory/returns/:id',
    { preHandler: requirePermission('regulatory:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, kind, period, reference, status, data, created_at as "createdAt",
                  created_by as "createdBy", approved_by as "approvedBy"
             from regulatory_return where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Regulatory return not found' };
        }
        return rows[0];
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/regulatory/returns/:id/approve',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string; kind: string; status: string }>(
          `update regulatory_return
              set status = 'approved', approved_by = $2
            where id = $1
            returning id, kind, status`,
          [req.params.id, ctx.userId],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Regulatory return not found' };
        }
        await writeAudit(db, ctx, {
          action: 'approve',
          entityType: 'regulatory_return',
          entityId: req.params.id,
          after: { kind: rows[0].kind, status: 'approved', approvedBy: ctx.userId },
          actorLabel: req.auth?.displayName,
        });
        return { id: rows[0].id, kind: rows[0].kind, status: rows[0].status };
      });
    },
  );
}

/** Persist a measurement row capturing only the closing CSM (roll-forward / VFA). */
async function persistRollforward(
  db: Db,
  ctx: { tenantId: string; userId: string },
  groupId: string,
  asAt: string | null,
  model: 'GMM' | 'VFA',
  closingCsmMinor: number,
  inputs: unknown,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into ifrs17_measurement
       (tenant_id, group_id, as_at, inputs, lrc_minor, lic_minor, loss_component_minor,
        total_liability_minor, is_onerous, csm_minor, fulfilment_cf_minor,
        risk_adjustment_minor, created_by)
     values ($1,$2,coalesce($3::date, current_date),$4,0,0,0,$5,false,$6,0,0,$7) returning id`,
    [ctx.tenantId, groupId, asAt, JSON.stringify(inputs), closingCsmMinor, closingCsmMinor, ctx.userId],
  );
  return rows[0]!.id;
}

interface GeneratedReturn {
  data: unknown;
  summary: Record<string, unknown>;
  rowCount: number;
}

/** Build a return's data by aggregating the tenant's own RLS-scoped data. */
async function generateReturn(db: Db, kind: (typeof returnKinds)[number]): Promise<GeneratedReturn> {
  switch (kind) {
    case 'SCHEDULE_F':
      return scheduleF(db);
    case 'SOLVENCY2_QRT':
      return solvency2Qrt(db);
    case 'IFRS17_DISCLOSURE':
      return ifrs17Disclosure(db);
    case 'LLOYDS_RETURN':
      return lloydsReturn(db);
  }
}

/**
 * US Schedule F — reinsurance recoverables by counterparty/contract. Summarises
 * loss-side financial events (paid/recovered) grouped by ceding counterparty.
 */
async function scheduleF(db: Db): Promise<GeneratedReturn> {
  const { rows } = await db.query<{
    counterparty: string | null;
    contract_id: string;
    contract_name: string;
    currency: string;
    paid_losses_minor: number;
    recoveries_minor: number;
  }>(
    `select coalesce(p.legal_name, 'Unattributed') as counterparty,
            c.id as contract_id, c.name as contract_name, c.currency,
            coalesce(sum(case when fe.event_type in ('PAID_LOSS','CASH_LOSS') then fe.amount_minor else 0 end), 0) as paid_losses_minor,
            coalesce(sum(case when fe.event_type = 'RECOVERY' then fe.amount_minor else 0 end), 0) as recoveries_minor
       from contract c
       left join party p on p.id = c.cedent_party_id
       left join financial_event fe on fe.contract_id = c.id
      where not c.is_deleted
      group by p.legal_name, c.id, c.name, c.currency
      order by counterparty, c.name`,
  );

  const recoverableRows = rows.map((r) => ({
    counterparty: r.counterparty,
    contractId: r.contract_id,
    contractName: r.contract_name,
    currency: r.currency,
    paidLossesMinor: r.paid_losses_minor,
    recoveriesMinor: r.recoveries_minor,
    recoverableMinor: r.paid_losses_minor - r.recoveries_minor,
  }));
  const totalRecoverableMinor = recoverableRows.reduce((acc, r) => acc + r.recoverableMinor, 0);

  return {
    data: { schedule: 'F', rows: recoverableRows },
    summary: { totalRecoverableMinor, counterparties: new Set(recoverableRows.map((r) => r.counterparty)).size },
    rowCount: recoverableRows.length,
  };
}

/** Solvency II QRT (S.25.01-like) — latest solvency_run capital figures. */
async function solvency2Qrt(db: Db): Promise<GeneratedReturn> {
  const { rows } = await db.query<{
    id: string;
    as_at: string;
    currency: string;
    scr_minor: number;
    mcr_minor: number;
    own_funds_minor: number;
    solvency_ratio: number | null;
  }>(
    `select id, as_at, currency, scr_minor, mcr_minor, own_funds_minor, solvency_ratio
       from solvency_run order by as_at desc, created_at desc limit 1`,
  );
  const run = rows[0];
  const data = run
    ? {
        template: 'S.25.01',
        runId: run.id,
        asAt: String(run.as_at),
        currency: run.currency,
        scrMinor: run.scr_minor,
        mcrMinor: run.mcr_minor,
        ownFundsMinor: run.own_funds_minor,
        solvencyRatio: run.solvency_ratio,
      }
    : { template: 'S.25.01', runId: null };

  return {
    data,
    summary: run
      ? { scrMinor: run.scr_minor, mcrMinor: run.mcr_minor, solvencyRatio: run.solvency_ratio }
      : { runId: null },
    rowCount: run ? 1 : 0,
  };
}

/** IFRS 17 disclosure — LRC/LIC/CSM totals across the tenant's measurements. */
async function ifrs17Disclosure(db: Db): Promise<GeneratedReturn> {
  const { rows } = await db.query<{
    lrc_minor: number;
    lic_minor: number;
    csm_minor: number;
    total_liability_minor: number;
    measurements: number;
    onerous_groups: number;
  }>(
    `select coalesce(sum(lrc_minor),0) as lrc_minor,
            coalesce(sum(lic_minor),0) as lic_minor,
            coalesce(sum(csm_minor),0) as csm_minor,
            coalesce(sum(total_liability_minor),0) as total_liability_minor,
            count(*) as measurements,
            count(*) filter (where is_onerous) as onerous_groups
       from ifrs17_measurement`,
  );
  const t = rows[0]!;
  const data = {
    disclosure: 'IFRS17',
    lrcMinor: t.lrc_minor,
    licMinor: t.lic_minor,
    csmMinor: t.csm_minor,
    totalLiabilityMinor: t.total_liability_minor,
    measurements: t.measurements,
    onerousGroups: t.onerous_groups,
  };
  return { data, summary: { csmMinor: t.csm_minor, totalLiabilityMinor: t.total_liability_minor }, rowCount: t.measurements };
}

/** Lloyd's return — contracts and premium by line of business. */
async function lloydsReturn(db: Db): Promise<GeneratedReturn> {
  const { rows } = await db.query<{
    line_of_business: string | null;
    currency: string;
    contracts: number;
    premium_minor: number;
  }>(
    `select coalesce(c.line_of_business::text, 'UNCLASSIFIED') as line_of_business,
            c.currency,
            count(distinct c.id) as contracts,
            coalesce(sum(case when fe.direction = 'DR' then fe.amount_minor
                              when fe.direction = 'CR' then -fe.amount_minor else 0 end), 0) as premium_minor
       from contract c
       left join financial_event fe on fe.contract_id = c.id
        and fe.event_type in ('DEPOSIT_PREMIUM','INSTALMENT_PREMIUM','ADJUSTMENT_PREMIUM','MINIMUM_PREMIUM')
      where not c.is_deleted
      group by c.line_of_business, c.currency
      order by line_of_business`,
  );
  const lines = rows.map((r) => ({
    lineOfBusiness: r.line_of_business,
    currency: r.currency,
    contracts: r.contracts,
    premiumMinor: r.premium_minor,
  }));
  return {
    data: { return: 'LLOYDS', lines },
    summary: { lines: lines.length, contracts: lines.reduce((a, r) => a + r.contracts, 0) },
    rowCount: lines.length,
  };
}
