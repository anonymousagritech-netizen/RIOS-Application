/**
 * Accumulation control at bind time + RDS portfolio evaluation
 * (industry-gap-analysis Tier-3 item 14).
 *
 * Zone-limit administration (accumulation_zone_limit, migration 0061), the
 * what-if check - "if we bind this contract, the zone aggregate becomes X vs
 * limit Y" - and a Realistic Disaster Scenario run against currently bound
 * contracts' zone exposure. The projection/verdict math is pure @rios/domain
 * (accumulation.ts); this module persists inputs and orchestrates.
 *
 * Per-contract zone exposure reuses the existing accumulation + exposure_entry
 * tables (0009): exposure_entry.contract_id joined to accumulation.zone/peril.
 * When a contract has no exposure entries, the check honestly falls back to
 * the contract's terms (territory as the zone, limit/eventLimit as the
 * exposure proxy) and labels the source accordingly.
 *
 * checkContractAccumulation is also called from treaties.ts inside the BOUND
 * transition. It is a deliberate no-op (checked: false, verdict PASS) when the
 * tenant has no active zone limits, so binding is unaffected until limits are
 * configured.
 *
 * INTEGRATOR NOTE: this module is not yet registered in server/src/app.ts
 * (this change was not allowed to edit app.ts). To wire the HTTP endpoints,
 * add `await app.register(accumulationModule);` next to exposureModule in
 * buildApp. The bind-time enforcement in treaties.ts works regardless.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  projectZoneAggregates,
  accumulationSummary,
  rdsGrossLoss,
  evaluateScenario,
  fromMajor,
  type ZoneExposureInput,
  type ZoneLimitInput,
  type ZoneLimitMode,
  type ZoneProjection,
  type ZoneVerdict,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/** Contract lifecycle statuses whose exposure counts as "bound" for aggregation. */
const BOUND_STATUSES = ['BOUND', 'ACTIVE'];

export type ExposureSource = 'EXPOSURE_ENTRIES' | 'TERMS_TERRITORY' | 'NONE';

export interface AccumulationCheckResult {
  /** false = no active zone limits configured for the tenant; the check was a no-op. */
  checked: boolean;
  /** Where the candidate contract's zone exposure came from. */
  exposureSource: ExposureSource;
  verdict: ZoneVerdict;
  zones: ZoneProjection[];
  blocked: ZoneProjection[];
  warnings: ZoneProjection[];
}

const PASS_NOOP: AccumulationCheckResult = {
  checked: false,
  exposureSource: 'NONE',
  verdict: 'PASS',
  zones: [],
  blocked: [],
  warnings: [],
};

interface ContractForCheck {
  id: string;
  currency: string;
  terms?: Record<string, unknown> | null;
}

interface ExposureRow {
  zone: string;
  peril: string | null;
  currency: string;
  exposureMinor: number;
}

/**
 * The bind-time what-if: project every limited zone the contract touches.
 * Runs inside the caller's runAs transaction (RLS scopes everything to the
 * tenant). Returns PASS with checked=false when no active limits exist - the
 * critical no-op path that keeps binding untouched for unconfigured tenants.
 */
export async function checkContractAccumulation(db: Db, contract: ContractForCheck): Promise<AccumulationCheckResult> {
  const limitRows = await db.query<{
    id: string; zone: string; peril: string | null; currency: string; limitMinor: number; mode: ZoneLimitMode;
  }>(
    `select id, zone, peril, currency, limit_minor as "limitMinor", mode
       from accumulation_zone_limit where active`,
  );
  if (limitRows.rows.length === 0) return PASS_NOOP;
  const limits: ZoneLimitInput[] = limitRows.rows;

  // What this contract would add: its own exposure entries, grouped by zone.
  const own = await db.query<ExposureRow>(
    `select a.zone, a.peril, e.currency, sum(e.gross_exposure_minor)::bigint as "exposureMinor"
       from exposure_entry e
       join accumulation a on a.id = e.accumulation_id
      where e.contract_id = $1
      group by a.zone, a.peril, e.currency`,
    [contract.id],
  );

  let additions: ZoneExposureInput[];
  let exposureSource: ExposureSource;
  if (own.rows.length > 0) {
    additions = own.rows;
    exposureSource = 'EXPOSURE_ENTRIES';
  } else {
    // Honest fallback: no exposure rows, so use the terms' territory as the
    // zone and the occurrence limit (or event limit) as the exposure proxy.
    const terms = contract.terms ?? {};
    const territory = typeof terms.territory === 'string' && terms.territory.trim() !== '' ? terms.territory : null;
    const limitMajor =
      typeof terms.limit === 'number' ? terms.limit : typeof terms.eventLimit === 'number' ? terms.eventLimit : null;
    if (territory && limitMajor !== null && limitMajor > 0) {
      additions = [{ zone: territory, peril: null, currency: contract.currency, exposureMinor: fromMajor(limitMajor, contract.currency).amount }];
      exposureSource = 'TERMS_TERRITORY';
    } else {
      additions = [];
      exposureSource = 'NONE';
    }
  }
  if (additions.length === 0) {
    return { ...PASS_NOOP, checked: true, exposureSource };
  }

  // Currently bound aggregate per zone (other contracts only), restricted to
  // the limited zones. Entries not attached to a BOUND/ACTIVE contract do not
  // count - the control is over the bound portfolio.
  const zoneKeys = [...new Set(limits.map((l) => l.zone.trim().toUpperCase()))];
  const current = await db.query<ExposureRow>(
    `select a.zone, a.peril, e.currency, sum(e.gross_exposure_minor)::bigint as "exposureMinor"
       from exposure_entry e
       join accumulation a on a.id = e.accumulation_id
       join contract c on c.id = e.contract_id
      where c.status = any($2)
        and not c.is_deleted
        and e.contract_id <> $1
        and upper(trim(a.zone)) = any($3)
      group by a.zone, a.peril, e.currency`,
    [contract.id, BOUND_STATUSES, zoneKeys],
  );

  const zones = projectZoneAggregates(limits, current.rows, additions);
  const summary = accumulationSummary(zones);
  return { checked: true, exposureSource, zones, ...summary };
}

const createLimitSchema = z.object({
  zone: z.string().min(1),
  peril: z.string().min(1).optional(),
  currency: z.string().length(3),
  limitMinor: z.number().int().positive(),
  mode: z.enum(['HARD', 'SOFT']).default('SOFT'),
});

const rdsRunSchema = z
  .object({
    scenarioKey: z.string().min(1).optional(),
    peril: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    damageRatio: z.number().min(0).max(1).default(1),
  })
  .refine((b) => b.scenarioKey || b.peril || b.region, {
    message: 'Provide a scenarioKey (rds_scenario.code) or scenario params (peril and/or region)',
  });

export async function accumulationModule(app: FastifyInstance): Promise<void> {
  // ---- Zone-limit administration -------------------------------------------
  app.post('/api/accumulation/zone-limits', { preHandler: requirePermission('exposure:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createLimitSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid zone limit', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const ccy = b.currency.toUpperCase();
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into accumulation_zone_limit (tenant_id, zone, peril, currency, limit_minor, mode, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id, zone, peril, currency) do update set
           limit_minor = excluded.limit_minor, mode = excluded.mode, active = true
         returning id`,
        [ctx.tenantId, b.zone, b.peril ?? null, ccy, b.limitMinor, b.mode, ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'upsert',
        entityType: 'accumulation_zone_limit',
        entityId: id,
        after: { zone: b.zone, peril: b.peril ?? null, currency: ccy, limitMinor: b.limitMinor, mode: b.mode },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, zone: b.zone, peril: b.peril ?? null, currency: ccy, limitMinor: b.limitMinor, mode: b.mode, active: true };
    });
  });

  // List limits with the current bound aggregate per zone ("aggregate X vs limit Y").
  app.get('/api/accumulation/zone-limits', { preHandler: requirePermission('exposure:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select l.id, l.zone, l.peril, l.currency, l.limit_minor as "limitMinor", l.mode, l.active,
                coalesce((
                  select sum(e.gross_exposure_minor)
                    from exposure_entry e
                    join accumulation a on a.id = e.accumulation_id
                    join contract c on c.id = e.contract_id
                   where c.status = any($1) and not c.is_deleted
                     and upper(trim(a.zone)) = upper(trim(l.zone))
                     and upper(e.currency) = upper(l.currency)
                     and (l.peril is null or upper(trim(coalesce(a.peril,''))) = upper(trim(l.peril)))
                ), 0)::bigint as "boundAggregateMinor"
           from accumulation_zone_limit l
          order by l.zone, l.peril nulls first`,
        [BOUND_STATUSES],
      );
      return {
        limits: rows.map((r) => ({
          ...r,
          headroomMinor: Number(r.limitMinor) - Number(r.boundAggregateMinor),
          breached: Number(r.boundAggregateMinor) > Number(r.limitMinor),
        })),
      };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/accumulation/zone-limits/:id/deactivate',
    { preHandler: requirePermission('exposure:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string; zone: string }>(
          `update accumulation_zone_limit set active = false where id = $1 returning id, zone`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Zone limit not found' };
        }
        await writeAudit(db, ctx, {
          action: 'deactivate',
          entityType: 'accumulation_zone_limit',
          entityId: rows[0].id,
          after: { zone: rows[0].zone, active: false },
          actorLabel: req.auth?.displayName,
        });
        return { id: rows[0].id, active: false };
      });
    },
  );

  // ---- The what-if check ----------------------------------------------------
  app.get<{ Querystring: { contractId?: string } }>(
    '/api/accumulation/check',
    { preHandler: requirePermission('exposure:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      const contractId = req.query.contractId;
      if (!contractId || !z.string().uuid().safeParse(contractId).success) {
        reply.code(400);
        return { error: 'contractId (uuid) query parameter is required' };
      }
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{ id: string; currency: string; status: string }>(
          `select id, currency, status from contract where id = $1 and not is_deleted`,
          [contractId],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Contract not found' };
        }
        const terms = await db.query<{ terms: Record<string, unknown> }>(
          `select terms from term_set where contract_id = $1 order by version desc limit 1`,
          [contractId],
        );
        const result = await checkContractAccumulation(db, {
          id: rows[0].id,
          currency: rows[0].currency,
          terms: terms.rows[0]?.terms ?? {},
        });
        return { contractId, status: rows[0].status, ...result };
      });
    },
  );

  // ---- RDS run against the bound portfolio ----------------------------------
  app.post('/api/accumulation/rds/run', { preHandler: requirePermission('risk:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = rdsRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid RDS run', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      let scenario: { code: string; name: string; peril: string | null; region: string | null; assumedRecoveryMinor: number } | null = null;
      if (b.scenarioKey) {
        const { rows } = await db.query<{ code: string; name: string; peril: string | null; region: string | null; assumedRecoveryMinor: number }>(
          `select code, name, peril, region, assumed_recovery_minor as "assumedRecoveryMinor"
             from rds_scenario where code = $1 and status = 'ACTIVE'`,
          [b.scenarioKey],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: `RDS scenario '${b.scenarioKey}' not found` };
        }
        scenario = rows[0];
      }
      const peril = scenario?.peril ?? b.peril ?? null;
      const region = scenario?.region ?? b.region ?? null;
      if (!peril && !region) {
        reply.code(400);
        return { error: 'Scenario carries no peril/region and none were supplied' };
      }

      // Bound portfolio zone exposure hit by the scenario. A region matches a
      // zone exactly or as a prefix segment (region 'US-FL' hits 'US-FL-WIND').
      const { rows: exposures } = await db.query<{ zone: string; peril: string | null; currency: string; exposureMinor: number }>(
        `select a.zone, a.peril, e.currency, sum(e.gross_exposure_minor)::bigint as "exposureMinor"
           from exposure_entry e
           join accumulation a on a.id = e.accumulation_id
           join contract c on c.id = e.contract_id
          where c.status = any($1) and not c.is_deleted
            and ($2::text is null or upper(trim(a.peril)) = upper(trim($2)))
            and ($3::text is null or upper(trim(a.zone)) = upper(trim($3))
                 or upper(trim(a.zone)) like upper(trim($3)) || '-%')
          group by a.zone, a.peril, e.currency`,
        [BOUND_STATUSES, peril, region],
      );
      const loss = rdsGrossLoss(exposures, b.damageRatio);

      // No risk-appetite table exists in this schema (docs/open-questions.md
      // territory); report the modelled loss honestly, netted to the latest
      // capital position when one is on file.
      const pos = await db.query<{ ownFundsMinor: number; scrMinor: number; currency: string; asOfDate: string }>(
        `select own_funds_minor as "ownFundsMinor", scr_minor as "scrMinor", currency, as_of_date as "asOfDate"
           from capital_position order by as_of_date desc limit 1`,
      );
      const capital = pos.rows[0] ?? null;
      return {
        scenario: scenario ? { code: scenario.code, name: scenario.name, peril, region } : { peril, region },
        damageRatio: loss.damageRatio,
        basis: "Bound/active contracts' zone exposure (exposure_entry × accumulation), damage ratio applied per zone",
        zones: loss.zones,
        modelledGrossLossMinor: loss.totalGrossLossMinor,
        appetite: null,
        appetiteNote: 'No risk-appetite table exists in this schema; the modelled loss is reported against the latest capital position instead.',
        capital: capital
          ? {
              ...capital,
              postEvent: evaluateScenario(
                loss.totalGrossLossMinor,
                scenario ? [{ source: 'reinsurance', recoveryMinor: scenario.assumedRecoveryMinor }] : [],
                capital.ownFundsMinor,
                capital.scrMinor,
              ),
            }
          : null,
      };
    });
  });
}
