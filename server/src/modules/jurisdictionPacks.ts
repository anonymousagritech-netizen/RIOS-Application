/**
 * Jurisdiction report packs (industry-gap-analysis Tier-3 #12).
 *
 * Serves the shipped jurisdiction pack CONTENT (`../content/jurisdictionPacks`)
 * and assembles each pack from the tenant's own RLS-scoped live data through
 * the pure `assembleReportPack` engine:
 *
 *  - NAIC_SCHEDULE_F        ceded (OUTWARDS) contracts + counterparty security
 *                           ratings/collateral (0052) + overdue AR balances,
 *                           provisioned by the pure `scheduleFProvision` engine
 *                           (ILLUSTRATIVE default factors, configurable).
 *  - SOLVENCY2_QRT          S.02.01 bound to posted-GL balances (assets vs
 *                           liabilities, tied to equity + retained earnings the
 *                           same way the balance sheet closes) and S.31.01
 *                           bound to ceded recoverables by counterparty rating.
 *  - IRDAI_REINSURANCE_RETURNS  inward vs outward premium/claims aggregates
 *                           from the financial-event spine.
 *
 * HONESTY: every pack is a template, not certified content - the disclaimer is
 * returned with every response. Assembly persists nothing, so it is not
 * audited (matching the platform's other read-only reports); the audited,
 * persisted path for regulatory output remains POST /api/regulatory/returns.
 * Money is integer minor units end to end. Figures aggregate minor units
 * across the tenant's booking currencies (per-counterparty maths is
 * currency-safe via Money; the demo tenant books a single currency).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assembleReportPack,
  money,
  ratingIsSecure,
  scheduleFProvision,
  type ScheduleFCounterparty,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { findJurisdictionPack, JURISDICTION_PACKS, type JurisdictionPackDefinition } from '../content/jurisdictionPacks.js';
import {
  findContentDefault,
  REGULATORY_CONTENT_DEFAULTS,
  runFilingValidation,
  type AssembledForValidation,
  type RegulatoryContentBody,
} from '../content/regulatoryContent.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const assembleSchema = z.object({
  asOf: z.string().regex(DATE_RE, 'asOf must be an ISO date (YYYY-MM-DD)').optional(),
});

const validateSchema = assembleSchema;

const postContentSchema = z.object({
  jurisdiction: z.string().min(1),
  contentKey: z.string().min(1),
  effectiveFrom: z.string().regex(DATE_RE, 'effectiveFrom must be an ISO date (YYYY-MM-DD)').optional(),
  isCertified: z.boolean().optional(),
  body: z.record(z.unknown()),
});

// Same financial-event vocabulary the retrocession/regulatory modules use
// (values come from the financial_event_type code list, not a hard-coded enum
// with customer-facing meaning - these lists only pick which events are
// premium-like vs loss-like for aggregation).
const PREMIUM_EVENT_TYPES = ['DEPOSIT_PREMIUM', 'INSTALMENT_PREMIUM', 'ADJUSTMENT_PREMIUM', 'MINIMUM_PREMIUM'];
const LOSS_EVENT_TYPES = ['PAID_LOSS', 'CASH_LOSS'];
const RECOVERY_EVENT_TYPES = ['RECOVERY'];

// ---------------------------------------------------------------------------
// Live-data figure gathering (all inside the caller's runAs / RLS context)
// ---------------------------------------------------------------------------

interface CededCounterpartyRow {
  partyId: string | null;
  counterparty: string;
  currency: string;
  cededLossesMinor: number;
  recoveriesMinor: number;
  recoverableMinor: number;
}

/**
 * Ceded reinsurance recoverables by counterparty: loss-side events on OUTWARDS
 * (retro/ceded) contracts less recoveries received, attributed to the
 * contract's participation counterparty (its reinsurer/retrocessionaire line).
 */
async function cededRecoverables(db: Db, asOf: string): Promise<CededCounterpartyRow[]> {
  const { rows } = await db.query<{
    party_id: string | null;
    counterparty: string;
    currency: string;
    ceded_losses_minor: string;
    recoveries_minor: string;
  }>(
    `with ev as (
       select c.id as contract_id, c.currency,
              coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($2::citext[])), 0)::bigint as ceded_losses_minor,
              coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($3::citext[])), 0)::bigint as recoveries_minor
         from contract c
         left join financial_event fe on fe.contract_id = c.id and fe.booked_at <= $1::date
        where not c.is_deleted
          and (c.direction = 'OUTWARDS' or c.contract_kind = 'RETROCESSION')
        group by c.id, c.currency
     ),
     cp as (
       select distinct on (contract_id) contract_id, party_id
         from participation
        order by contract_id, created_at
     )
     select p.id as party_id,
            coalesce(p.legal_name, 'Unattributed') as counterparty,
            ev.currency,
            sum(ev.ceded_losses_minor)::bigint as ceded_losses_minor,
            sum(ev.recoveries_minor)::bigint as recoveries_minor
       from ev
       left join cp on cp.contract_id = ev.contract_id
       left join party p on p.id = cp.party_id
      group by p.id, p.legal_name, ev.currency
      order by counterparty, ev.currency`,
    [asOf, LOSS_EVENT_TYPES, RECOVERY_EVENT_TYPES],
  );
  return rows.map((r) => ({
    partyId: r.party_id,
    counterparty: r.counterparty,
    currency: r.currency,
    cededLossesMinor: Number(r.ceded_losses_minor),
    recoveriesMinor: Number(r.recoveries_minor),
    recoverableMinor: Number(r.ceded_losses_minor) - Number(r.recoveries_minor),
  }));
}

interface LatestRating {
  agency: string;
  rating: string;
  ratedOn: string;
}

/** Latest security rating per party as of the reporting date (0052). */
async function latestRatings(db: Db, asOf: string): Promise<Map<string, LatestRating>> {
  const { rows } = await db.query<{ party_id: string; agency: string; rating: string; rated_on: string }>(
    `select distinct on (party_id) party_id, agency, rating, to_char(rated_on, 'YYYY-MM-DD') as rated_on
       from security_rating
      where rated_on <= $1::date
      order by party_id, rated_on desc, created_at desc`,
    [asOf],
  );
  return new Map(rows.map((r) => [r.party_id, { agency: r.agency, rating: r.rating, ratedOn: r.rated_on }]));
}

/** Active collateral per party+currency (0052), keyed `${partyId}|${currency}`. */
async function activeCollateral(db: Db): Promise<Map<string, number>> {
  const { rows } = await db.query<{ party_id: string; currency: string; total_minor: string }>(
    `select party_id, currency, coalesce(sum(amount_minor), 0)::bigint as total_minor
       from collateral
      where status = 'ACTIVE'
      group by party_id, currency`,
  );
  return new Map(rows.map((r) => [`${r.party_id}|${r.currency}`, Number(r.total_minor)]));
}

/** Unsettled AR balances past their due date per party+currency (overdue proxy). */
async function overdueReceivables(db: Db, asOf: string): Promise<Map<string, number>> {
  const { rows } = await db.query<{ party_id: string; currency: string; overdue_minor: string }>(
    `select party_id, currency,
            greatest(coalesce(sum(amount_minor - settled_minor), 0), 0)::bigint as overdue_minor
       from ar_invoice
      where party_id is not null
        and due_date < $1::date
        and status <> 'SETTLED'
      group by party_id, currency`,
    [asOf],
  );
  return new Map(rows.map((r) => [`${r.party_id}|${r.currency}`, Number(r.overdue_minor)]));
}

interface ScheduleFDetailLine {
  counterparty: string;
  partyId: string | null;
  currency: string;
  authorized: boolean;
  rating: LatestRating | null;
  recoverableMinor: number;
  overdueMinor: number;
  collateralMinor: number;
  uncollateralizedMinor: number;
  provisionMinor: number;
  netMinor: number;
}

interface ScheduleFData {
  detail: ScheduleFDetailLine[];
  figures: Record<string, number>;
  overdueProvisionRate: number;
}

/**
 * Bind ceded recoverables + counterparty security into the pure
 * `scheduleFProvision` engine, per booking currency (Money is currency-safe),
 * then aggregate the minor-unit totals into the template's figure codes.
 */
async function scheduleFData(db: Db, asOf: string): Promise<ScheduleFData> {
  const [rows, ratings, collateral, overdue] = [
    await cededRecoverables(db, asOf),
    await latestRatings(db, asOf),
    await activeCollateral(db),
    await overdueReceivables(db, asOf),
  ];

  const byCurrency = new Map<string, CededCounterpartyRow[]>();
  for (const r of rows) {
    byCurrency.set(r.currency, [...(byCurrency.get(r.currency) ?? []), r]);
  }

  const detail: ScheduleFDetailLine[] = [];
  const totals = {
    authRecoverable: 0, unauthRecoverable: 0, totalCheck: 0,
    collateral: 0, overdue: 0, provisionAuth: 0, provisionUnauth: 0,
  };
  let appliedRate = 0;

  for (const [ccy, ccyRows] of byCurrency) {
    const inputs: ScheduleFCounterparty[] = ccyRows.map((r) => {
      const rating = r.partyId ? ratings.get(r.partyId) : undefined;
      return {
        counterparty: r.counterparty,
        // Security-driven classification: secure-rated ⇒ treated as authorized;
        // unrated or sub-grade ⇒ unauthorized (illustrative default sets).
        authorized: rating !== undefined && ratingIsSecure(rating.agency, rating.rating),
        recoverable: money(r.recoverableMinor, ccy),
        overdue: money(r.partyId ? (overdue.get(`${r.partyId}|${ccy}`) ?? 0) : 0, ccy),
        collateral: money(r.partyId ? (collateral.get(`${r.partyId}|${ccy}`) ?? 0) : 0, ccy),
      };
    });
    const result = scheduleFProvision(inputs, ccy);
    appliedRate = result.overdueProvisionRate;

    result.lines.forEach((l, i) => {
      const src = ccyRows[i]!;
      detail.push({
        counterparty: l.counterparty,
        partyId: src.partyId,
        currency: ccy,
        authorized: l.authorized,
        rating: (src.partyId && ratings.get(src.partyId)) || null,
        recoverableMinor: l.recoverable.amount,
        overdueMinor: l.overdue.amount,
        collateralMinor: l.collateral.amount,
        uncollateralizedMinor: l.uncollateralized.amount,
        provisionMinor: l.provision.amount,
        netMinor: l.net.amount,
      });
    });

    totals.authRecoverable += result.totals.authorizedRecoverable.amount;
    totals.unauthRecoverable += result.totals.unauthorizedRecoverable.amount;
    totals.collateral += result.totals.collateral.amount;
    totals.overdue += result.totals.overdue.amount;
    totals.provisionAuth += result.totals.authorizedProvision.amount;
    totals.provisionUnauth += result.totals.unauthorizedProvision.amount;
    // Independent tie-out path: raw ceded losses less recoveries.
    totals.totalCheck += ccyRows.reduce((a, r) => a + r.recoverableMinor, 0);
  }

  return {
    detail,
    figures: {
      SF_AUTH_RECOVERABLE: totals.authRecoverable,
      SF_UNAUTH_RECOVERABLE: totals.unauthRecoverable,
      SF_TOTAL_CHECK: totals.totalCheck,
      SF_COLLATERAL_HELD: totals.collateral,
      SF_OVERDUE_RECOVERABLE: totals.overdue,
      SF_PROVISION_AUTH: totals.provisionAuth,
      SF_PROVISION_UNAUTH: totals.provisionUnauth,
    },
    overdueProvisionRate: appliedRate,
  };
}

/**
 * Posted-GL balances by account type as at a date - the same source and sign
 * conventions the balance-sheet report uses, so the S.02.01 control tie
 * (excess of assets over liabilities = equity + retained earnings) holds
 * whenever every posted journal balances.
 */
async function glBalances(db: Db, asOf: string): Promise<{ assets: number; liabilities: number; equityCheck: number }> {
  const { rows } = await db.query<{ type: string; debit_minor: string; credit_minor: string }>(
    `select ga.type,
            coalesce(sum(p.debit_minor), 0)::bigint as debit_minor,
            coalesce(sum(p.credit_minor), 0)::bigint as credit_minor
       from gl_account ga
       left join (
              select lp.gl_account_id, lp.debit_minor, lp.credit_minor
                from ledger_posting lp
                join journal j on j.id = lp.journal_id
               where j.status = 'posted' and j.posted_at <= $1::date
            ) p on p.gl_account_id = ga.id
      group by ga.type`,
    [asOf],
  );
  const bal = new Map(rows.map((r) => [r.type, { debit: Number(r.debit_minor), credit: Number(r.credit_minor) }]));
  const debitNormal = (t: string) => (bal.get(t)?.debit ?? 0) - (bal.get(t)?.credit ?? 0);
  const creditNormal = (t: string) => (bal.get(t)?.credit ?? 0) - (bal.get(t)?.debit ?? 0);
  return {
    assets: debitNormal('asset'),
    liabilities: creditNormal('liability'),
    // Equity plus retained earnings (cumulative income - expense), as the
    // balance-sheet module folds the P&L into equity.
    equityCheck: creditNormal('equity') + creditNormal('income') - debitNormal('expense'),
  };
}

/** IFRS 17 technical provisions memo figure (total liability across measurements). */
async function technicalProvisions(db: Db, asOf: string): Promise<number> {
  const { rows } = await db.query<{ total_minor: string }>(
    `select coalesce(sum(total_liability_minor), 0)::bigint as total_minor
       from ifrs17_measurement where as_at <= $1::date`,
    [asOf],
  );
  return Number(rows[0]!.total_minor);
}

/** Inward vs outward premium/claims aggregates from the financial-event spine. */
async function directionAggregates(
  db: Db,
  asOf: string,
): Promise<Record<'INWARDS' | 'OUTWARDS', { premium: number; losses: number }>> {
  const { rows } = await db.query<{ direction: string; premium_minor: string; losses_minor: string }>(
    `select c.direction,
            coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($2::citext[])), 0)::bigint as premium_minor,
            coalesce(sum(fe.amount_minor) filter (where fe.event_type = any($3::citext[])), 0)::bigint as losses_minor
       from financial_event fe
       join contract c on c.id = fe.contract_id
      where not c.is_deleted and fe.booked_at <= $1::date
      group by c.direction`,
    [asOf, PREMIUM_EVENT_TYPES, LOSS_EVENT_TYPES],
  );
  const out: Record<'INWARDS' | 'OUTWARDS', { premium: number; losses: number }> = {
    INWARDS: { premium: 0, losses: 0 },
    OUTWARDS: { premium: 0, losses: 0 },
  };
  for (const r of rows) {
    if (r.direction === 'INWARDS' || r.direction === 'OUTWARDS') {
      out[r.direction] = { premium: Number(r.premium_minor), losses: Number(r.losses_minor) };
    }
  }
  return out;
}

/**
 * Assemble a jurisdiction pack from live tenant data into resolved report-pack
 * objects (each carries `.code`, `.values`, `.errors`, `.complete`). Shared by
 * the /assemble and /validate endpoints so both bind the same figures. Must run
 * inside the caller's runAs / RLS context.
 */
async function assemblePacks(db: Db, def: JurisdictionPackDefinition, asOf: string): Promise<Array<Record<string, unknown>>> {
  const packs: Array<Record<string, unknown>> = [];

  if (def.code === 'NAIC_SCHEDULE_F') {
    const sf = await scheduleFData(db, asOf);
    packs.push({
      ...assembleReportPack(def.templates[0]!, sf.figures),
      // ILLUSTRATIVE DEFAULT (configurable), not a certified NAIC factor.
      overdueProvisionRate: sf.overdueProvisionRate,
      detail: { counterparties: sf.detail },
    });
  } else if (def.code === 'SOLVENCY2_QRT') {
    const [sf, gl, tp] = [await scheduleFData(db, asOf), await glBalances(db, asOf), await technicalProvisions(db, asOf)];
    const totalRecoverable = sf.figures.SF_AUTH_RECOVERABLE! + sf.figures.SF_UNAUTH_RECOVERABLE!;
    const rated = sf.detail.filter((d) => d.rating !== null);
    const unrated = sf.detail.filter((d) => d.rating === null);
    const figuresByTemplate: Record<string, Record<string, number>> = {
      'S.02.01': {
        S02_REINSURANCE_RECOVERABLES: totalRecoverable,
        S02_TOTAL_ASSETS: gl.assets,
        S02_TECHNICAL_PROVISIONS: tp,
        S02_TOTAL_LIABILITIES: gl.liabilities,
        S02_EQUITY_CHECK: gl.equityCheck,
      },
      'S.31.01': {
        S31_RECOVERABLE_RATED: rated.reduce((a, d) => a + d.recoverableMinor, 0),
        S31_RECOVERABLE_UNRATED: unrated.reduce((a, d) => a + d.recoverableMinor, 0),
        S31_COLLATERAL_HELD: sf.figures.SF_COLLATERAL_HELD!,
      },
    };
    for (const t of def.templates) {
      packs.push({
        ...assembleReportPack(t, figuresByTemplate[t.code]!),
        ...(t.code === 'S.31.01' ? { detail: { reinsurers: sf.detail } } : {}),
      });
    }
  } else if (def.code === 'IRDAI_REINSURANCE_RETURNS') {
    const agg = await directionAggregates(db, asOf);
    packs.push({
      ...assembleReportPack(def.templates[0]!, {
        IRDAI_INWARD_PREMIUM: agg.INWARDS.premium,
        IRDAI_INWARD_CLAIMS_PAID: agg.INWARDS.losses,
        IRDAI_OUTWARD_PREMIUM: agg.OUTWARDS.premium,
        // Ceded loss share on OUTWARDS contracts = recoveries due under
        // reinsurance ceded (the ceded copy of loss events).
        IRDAI_OUTWARD_RECOVERIES: agg.OUTWARDS.losses,
        IRDAI_NET_PREMIUM_CHECK: agg.INWARDS.premium - agg.OUTWARDS.premium,
      }),
    });
  }

  return packs;
}

/** Reshape assembled packs into the pure validation engine's input. */
function forValidation(packs: Array<Record<string, unknown>>): AssembledForValidation[] {
  return packs.map((p) => {
    const appliedFactors: Record<string, number> = {};
    if (typeof p.overdueProvisionRate === 'number') appliedFactors.overdueProvisionRate = p.overdueProvisionRate;
    return {
      templateCode: String(p.code),
      values: (p.values as Record<string, number | null>) ?? {},
      ...(Object.keys(appliedFactors).length ? { appliedFactors } : {}),
    };
  });
}

/**
 * Load the effective filing content for a jurisdiction+key: the tenant's latest
 * override if one exists, else the latest global (tenant_id null) DB row, else
 * the shipped code default. Returns the resolved body plus its version/certified
 * labelling and provenance. Must run inside runAs.
 */
async function loadEffectiveContent(
  db: Db,
  jurisdiction: string,
  contentKey: string,
): Promise<{ body: RegulatoryContentBody; version: number; isCertified: boolean; effectiveFrom: string; source: string } | null> {
  const { rows } = await db.query<{
    version: number;
    is_certified: boolean;
    body: RegulatoryContentBody;
    effective_from: string;
    scoped: boolean;
  }>(
    `select version, is_certified, body, to_char(effective_from,'YYYY-MM-DD') as effective_from,
            (tenant_id is not null) as scoped
       from regulatory_content_version
      where jurisdiction = $1 and content_key = $2
      order by (tenant_id is not null) desc, version desc, created_at desc
      limit 1`,
    [jurisdiction, contentKey],
  );
  if (rows[0]) {
    return {
      body: rows[0].body,
      version: rows[0].version,
      isCertified: rows[0].is_certified,
      effectiveFrom: rows[0].effective_from,
      source: rows[0].scoped ? 'tenant-override' : 'global-db',
    };
  }
  const def = findContentDefault(jurisdiction, contentKey);
  if (!def) return null;
  return {
    body: def.body,
    version: def.version,
    isCertified: def.isCertified,
    effectiveFrom: def.effectiveFrom,
    source: 'code-default',
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function jurisdictionPacksModule(app: FastifyInstance): Promise<void> {
  // The shipped jurisdiction content, with its honest labels. Static content
  // (no tenant data), read-gated like the other regulatory reads.
  app.get(
    '/api/regulatory/packs/jurisdictions',
    { preHandler: requirePermission('regulatory:read') },
    async () => ({
      packs: JURISDICTION_PACKS.map((p) => ({
        code: p.code,
        jurisdiction: p.jurisdiction,
        regulator: p.regulator,
        title: p.title,
        description: p.description,
        disclaimer: p.disclaimer,
        templates: p.templates.map((t) => ({
          code: t.code,
          title: t.title,
          sections: t.sections.length,
          lines: t.sections.reduce((a, s) => a + s.lines.length, 0),
        })),
      })),
    }),
  );

  // Assemble a pack from live tenant data. Read-only: nothing is persisted, so
  // nothing is audited (the audited, persisted regulatory output path remains
  // POST /api/regulatory/returns).
  app.post<{ Params: { code: string } }>(
    '/api/regulatory/packs/:code/assemble',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = assembleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid assemble request', details: parsed.error.flatten() };
      }
      const def = findJurisdictionPack(req.params.code);
      if (!def) {
        reply.code(404);
        return { error: `Unknown jurisdiction pack: ${req.params.code}` };
      }
      const asOf = parsed.data.asOf ?? new Date().toISOString().slice(0, 10);

      return runAs(ctx, async (db) => {
        const packs = await assemblePacks(db, def, asOf);
        return {
          code: def.code,
          jurisdiction: def.jurisdiction,
          regulator: def.regulator,
          title: def.title,
          disclaimer: def.disclaimer,
          asOf,
          aggregationNote:
            "Figures aggregate integer minor units across the tenant's booking currencies; " +
            'per-counterparty provision maths is currency-safe (Money).',
          packs,
        };
      });
    },
  );

  // -------------------------------------------------------------------------
  // Filing content as VERSIONED CONFIG
  // -------------------------------------------------------------------------

  // Read the effective filing content (tenant override > global DB > code
  // default) for the optional jurisdiction/key filters, with its version and
  // honest is_certified labelling. Read-gated.
  app.get<{ Querystring: { jurisdiction?: string; key?: string } }>(
    '/api/regulatory/content',
    { preHandler: requirePermission('regulatory:read') },
    async (req) => {
      const ctx = authContext(req);
      const jFilter = req.query.jurisdiction?.toUpperCase();
      const kFilter = req.query.key?.toUpperCase();
      return runAs(ctx, async (db) => {
        // The (jurisdiction, contentKey) pairs the platform knows about are the
        // shipped defaults; a deployment can only version content it has a
        // default for. Resolve the effective version of each matching pair.
        const pairs = REGULATORY_CONTENT_DEFAULTS.filter(
          (d) =>
            (!jFilter || d.jurisdiction.toUpperCase() === jFilter) &&
            (!kFilter || d.contentKey.toUpperCase() === kFilter),
        );
        const content = [];
        for (const d of pairs) {
          const eff = await loadEffectiveContent(db, d.jurisdiction, d.contentKey);
          if (!eff) continue;
          content.push({
            jurisdiction: d.jurisdiction,
            contentKey: d.contentKey,
            version: eff.version,
            effectiveFrom: eff.effectiveFrom,
            isCertified: eff.isCertified,
            source: eff.source,
            body: eff.body,
          });
        }
        return {
          disclaimer:
            'Filing content is versioned configuration. Shipped defaults are illustrative and is_certified=false; ' +
            'a deployment certifies content per jurisdiction by posting a newer version.',
          content,
        };
      });
    },
  );

  // Create a tenant-scoped content override as a NEW version (append-only). The
  // effective content for this tenant becomes this version. is_certified is what
  // the deployment asserts (default false); the platform never fabricates
  // certified numbers.
  app.post(
    '/api/regulatory/content',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = postContentSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid content', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      // Only jurisdictions/keys the platform ships a default for can be versioned.
      if (!findContentDefault(b.jurisdiction, b.contentKey)) {
        reply.code(404);
        return { error: `Unknown regulatory content: ${b.jurisdiction}/${b.contentKey}` };
      }
      return runAs(ctx, async (db) => {
        // Next version outranks any prior DB version AND the shipped code
        // default (which lives in code, not this table), so an override always
        // becomes the latest effective content.
        const { rows: verRows } = await db.query<{ maxv: number }>(
          `select coalesce(max(version), 0) as maxv
             from regulatory_content_version
            where jurisdiction = $1 and content_key = $2`,
          [b.jurisdiction, b.contentKey],
        );
        const codeDefaultVersion = findContentDefault(b.jurisdiction, b.contentKey)?.version ?? 0;
        const version = Math.max(verRows[0]!.maxv, codeDefaultVersion) + 1;
        const { rows } = await db.query<{ id: string; created_at: string }>(
          `insert into regulatory_content_version
             (tenant_id, jurisdiction, content_key, version, effective_from, body, is_certified, created_by)
           values ($1,$2,$3,$4,coalesce($5::date, current_date),$6,$7,$8)
           returning id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') as created_at`,
          [
            ctx.tenantId,
            b.jurisdiction,
            b.contentKey,
            version,
            b.effectiveFrom ?? null,
            JSON.stringify(b.body),
            b.isCertified ?? false,
            ctx.userId,
          ],
        );
        const id = rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'regulatory_content_version',
          entityId: id,
          after: { jurisdiction: b.jurisdiction, contentKey: b.contentKey, version, isCertified: b.isCertified ?? false },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return {
          id,
          jurisdiction: b.jurisdiction,
          contentKey: b.contentKey,
          version,
          isCertified: b.isCertified ?? false,
          createdAt: rows[0]!.created_at,
        };
      });
    },
  );

  // -------------------------------------------------------------------------
  // Filing validation (the delivered capability)
  // -------------------------------------------------------------------------

  // Assemble a pack, then validate the assembled return against its effective
  // content version (required cells present, control totals tie, factor bands
  // applied). Persists the run + per-rule items; returns PASS/WARN/FAIL.
  app.post<{ Params: { code: string } }>(
    '/api/regulatory/packs/:code/validate',
    { preHandler: requirePermission('regulatory:run') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = validateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid validate request', details: parsed.error.flatten() };
      }
      const def = findJurisdictionPack(req.params.code);
      if (!def) {
        reply.code(404);
        return { error: `Unknown jurisdiction pack: ${req.params.code}` };
      }
      const asOf = parsed.data.asOf ?? new Date().toISOString().slice(0, 10);

      return runAs(ctx, async (db) => {
        const packs = await assemblePacks(db, def, asOf);
        const eff = await loadEffectiveContent(db, def.jurisdiction, def.code);
        if (!eff) {
          reply.code(404);
          return { error: `No filing content for pack ${def.code}` };
        }
        const result = runFilingValidation(eff.body, forValidation(packs));

        const { rows } = await db.query<{ id: string; created_at: string }>(
          `insert into filing_validation (tenant_id, pack_code, as_of, status, created_by)
           values ($1,$2,$3::date,$4,$5)
           returning id, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') as created_at`,
          [ctx.tenantId, def.code, asOf, result.status, ctx.userId],
        );
        const validationId = rows[0]!.id;
        for (const item of result.items) {
          await db.query(
            `insert into filing_validation_item
               (tenant_id, validation_id, rule_key, severity, message, expected, actual, ok)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              ctx.tenantId,
              validationId,
              item.ruleKey,
              item.severity,
              item.message,
              JSON.stringify(item.expected ?? null),
              JSON.stringify(item.actual ?? null),
              item.ok,
            ],
          );
        }
        await writeAudit(db, ctx, {
          action: 'validate',
          entityType: 'filing_validation',
          entityId: validationId,
          after: { packCode: def.code, asOf, status: result.status, items: result.items.length },
          actorLabel: req.auth?.displayName,
        });

        reply.code(201);
        return {
          id: validationId,
          packCode: def.code,
          jurisdiction: def.jurisdiction,
          asOf,
          status: result.status,
          contentVersion: eff.version,
          contentSource: eff.source,
          isCertified: eff.isCertified,
          disclaimer: def.disclaimer,
          createdAt: rows[0]!.created_at,
          items: result.items,
        };
      });
    },
  );

  // Validation history for a pack (most recent first). Read-gated.
  app.get<{ Params: { code: string } }>(
    '/api/regulatory/packs/:code/validations',
    { preHandler: requirePermission('regulatory:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, pack_code as "packCode", to_char(as_of,'YYYY-MM-DD') as "asOf",
                  status, created_by as "createdBy", to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') as "createdAt"
             from filing_validation
            where pack_code = $1
            order by created_at desc`,
          [req.params.code],
        );
        return { packCode: req.params.code, validations: rows };
      });
    },
  );
}
