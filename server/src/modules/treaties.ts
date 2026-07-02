/**
 * Treaty / contract module (brief §7.2–§7.3, §29.1).
 *
 * Implements the core lifecycle and the binding transition, which generates the
 * deposit-premium Financial Event(s) from the term set - the start of the
 * reconcilable accounting chain (§7.6). Money is computed by @rios/domain so the
 * numbers are the same ones the unit tests prove correct.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { multiply, money, fromMajor } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';
import { checkContractAccumulation } from './accumulation.js';
import { parsePaginationQuery, encodeCursor, decodeCursor } from '../lib/pagination.js';
import { toCsv } from '../csv.js';
import { notify } from './notifications.js';

const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['QUOTED', 'PLACING', 'CANCELLED'],
  QUOTED: ['PLACING', 'BOUND', 'CANCELLED'],
  PLACING: ['BOUND', 'CANCELLED'],
  BOUND: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['EXPIRING', 'RUNOFF', 'COMMUTED', 'CANCELLED'],
  EXPIRING: ['RENEWED', 'RUNOFF', 'LAPSED'],
  RUNOFF: ['COMMUTED', 'CLOSED'],
};

/**
 * Typed commercial terms (gap-analysis §2.2 item 4). The known keys are
 * validated; unknown keys still pass through so tenant-specific vocabulary
 * (metadata-driven config) is not rejected. Percentages are expressed 0-100;
 * shares/lines elsewhere stay 0-1.
 */
const termsSchema = z
  .object({
    currency: z.string().length(3).optional(),
    underwritingYear: z.number().int().min(1990).max(2100).optional(),
    territory: z.string().optional(),
    slipReference: z.string().optional(),
    expiringContractRef: z.string().optional(),
    writtenSharePct: z.number().min(0).max(100).optional(),
    orderPct: z.number().min(0).max(100).optional(),
    periodBasis: z.enum(['LOSSES_OCCURRING', 'RISKS_ATTACHING', 'CLAIMS_MADE']).optional(),
    cessionPct: z.number().min(0).max(100).optional(),
    retentionLines: z.number().nonnegative().optional(),
    maxCession: z.number().nonnegative().optional(),
    attachment: z.number().nonnegative().optional(),
    limit: z.number().nonnegative().optional(),
    layers: z.number().int().positive().optional(),
    aggregateDeductible: z.number().nonnegative().optional(),
    reinstatements: z.string().optional(),
    rateOnLine: z.number().min(0).max(100).optional(),
    hoursClause: z.number().positive().optional(),
    eventLimit: z.number().nonnegative().optional(),
    cedingCommissionPct: z.number().min(0).max(100).optional(),
    profitCommissionPct: z.number().min(0).max(100).optional(),
    overridePct: z.number().min(0).max(100).optional(),
    commissionMinPct: z.number().min(0).max(100).optional(),
    commissionMaxPct: z.number().min(0).max(100).optional(),
    brokeragePct: z.number().min(0).max(100).optional(),
    estimatedPremiumIncome: z.number().nonnegative().optional(),
    minimumAndDepositPremium: z.number().nonnegative().optional(),
    depositPremium: z.number().nonnegative().optional(),
    statementFrequency: z.enum(['QUARTERLY', 'HALF_YEARLY', 'ANNUAL']).optional(),
    accountingBasis: z.enum(['UNDERWRITING_YEAR', 'ACCOUNTING_YEAR', 'CLEAN_CUT']).optional(),
    settlementCurrency: z.string().length(3).optional(),
    cashCallThreshold: z.number().nonnegative().optional(),
  })
  .passthrough()
  .superRefine((t, ctx) => {
    if (t.commissionMinPct !== undefined && t.commissionMaxPct !== undefined && t.commissionMinPct > t.commissionMaxPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commissionMinPct'],
        message: `commissionMinPct (${t.commissionMinPct}) must be <= commissionMaxPct (${t.commissionMaxPct})`,
      });
    }
    // attachment/limit may arrive independently (terms firm up over the placement),
    // but when both are present the layer must have a positive limit.
    if (t.attachment !== undefined && t.limit !== undefined && t.limit <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limit'],
        message: 'limit must be > 0 when attachment and limit are both present',
      });
    }
  });

const createContractSchema = z.object({
  name: z.string().min(1),
  contractKind: z.enum(['TREATY', 'FACULTATIVE', 'RETROCESSION']).default('TREATY'),
  basis: z.enum(['PROPORTIONAL', 'NON_PROPORTIONAL']),
  proportionalType: z.enum(['QUOTA_SHARE', 'SURPLUS']).optional(),
  npType: z.enum(['PER_RISK_XL', 'CAT_XL', 'AGG_XL', 'STOP_LOSS']).optional(),
  lineOfBusiness: z.string().optional(),
  direction: z.enum(['INWARDS', 'OUTWARDS']).default('INWARDS'),
  currency: z.string().length(3),
  cedentPartyId: z.string().uuid().optional(),
  brokerPartyId: z.string().uuid().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  // Optional commercial terms persisted as the contract's first term set (§28.1).
  // Known keys are typed (see termsSchema); unknown keys pass through.
  terms: termsSchema.optional(),
});

export async function treatiesModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; kind?: string; cedentId?: string; brokerId?: string; limit?: string; cursor?: string } }>(
    '/api/treaties',
    { preHandler: requirePermission('treaty:read') },
    async (req) => {
      const ctx = authContext(req);
      const { limit, cursor } = parsePaginationQuery(req.query as Record<string, unknown>);
      const decoded = cursor ? decodeCursor(cursor) : null;
      return runAs(ctx, async (db) => {
        // Parameterised cursor WHERE — no user data is interpolated into SQL.
        // Keyset uses DESC ordering: next page rows have (created_at, id) < cursor.
        const params: unknown[] = [
          req.query.status ?? null,
          req.query.kind ?? null,
          req.query.cedentId ?? null,
          req.query.brokerId ?? null,
        ];
        let cursorClause = '';
        if (decoded) {
          params.push(decoded.createdAt, decoded.id);
          cursorClause = `AND (c.created_at, c.id) < ($5::timestamptz, $6::uuid)`;
        }
        const { rows } = await db.query<{ id: string; createdAt: string } & Record<string, unknown>>(
          `select c.id, c.reference, c.name, c.contract_kind as "contractKind", c.basis,
                  c.proportional_type as "proportionalType", c.np_type as "npType",
                  c.line_of_business as "lineOfBusiness", c.direction, c.currency,
                  c.period_start as "periodStart", c.period_end as "periodEnd", c.status,
                  c.cedent_party_id as "cedentPartyId", c.broker_party_id as "brokerPartyId",
                  ced.short_name as "cedentName", brk.short_name as "brokerName",
                  c.created_at::text as "createdAt"
             from contract c
             left join party ced on ced.id = c.cedent_party_id
             left join party brk on brk.id = c.broker_party_id
            where not c.is_deleted
              and ($1::citext is null or c.status = $1)
              and ($2::citext is null or c.contract_kind = $2)
              and ($3::uuid is null or c.cedent_party_id = $3)
              and ($4::uuid is null or c.broker_party_id = $4)
              ${cursorClause}
            order by c.created_at desc, c.id desc
            limit ${limit + 1}`,
          params,
        );
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        const last = rows[rows.length - 1];
        const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
        return { treaties: rows, nextCursor };
      });
    },
  );

  // CSV export — same filters, streamed as a download.
  app.get<{ Querystring: { status?: string; kind?: string; cedentId?: string; brokerId?: string } }>(
    '/api/treaties/export.csv',
    { preHandler: requirePermission('treaty:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          reference: string; name: string; contractKind: string; basis: string;
          lineOfBusiness: string | null; direction: string; currency: string;
          periodStart: string | null; periodEnd: string | null; status: string;
          cedentName: string | null; brokerName: string | null;
        }>(
          `select c.reference, c.name, c.contract_kind as "contractKind", c.basis,
                  c.line_of_business as "lineOfBusiness", c.direction, c.currency,
                  c.period_start as "periodStart", c.period_end as "periodEnd", c.status,
                  ced.short_name as "cedentName", brk.short_name as "brokerName"
             from contract c
             left join party ced on ced.id = c.cedent_party_id
             left join party brk on brk.id = c.broker_party_id
            where not c.is_deleted
              and ($1::citext is null or c.status = $1)
              and ($2::citext is null or c.contract_kind = $2)
              and ($3::uuid is null or c.cedent_party_id = $3)
              and ($4::uuid is null or c.broker_party_id = $4)
            order by c.created_at desc`,
          [req.query.status ?? null, req.query.kind ?? null, req.query.cedentId ?? null, req.query.brokerId ?? null],
        );
        const csv = toCsv(
          ['Reference', 'Name', 'Kind', 'Basis', 'LOB', 'Direction', 'Currency',
           'Inception', 'Expiry', 'Status', 'Cedent', 'Broker'],
          rows.map((r) => [
            r.reference, r.name, r.contractKind, r.basis, r.lineOfBusiness ?? '',
            r.direction, r.currency, r.periodStart ?? '', r.periodEnd ?? '', r.status,
            r.cedentName ?? '', r.brokerName ?? '',
          ]),
        );
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="treaties.csv"');
        return csv;
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/treaties/:id',
    { preHandler: requirePermission('treaty:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        return contract;
      });
    },
  );

  app.post('/api/treaties', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createContractSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      // flatten() collapses nested paths (e.g. terms.rateOnLine → "terms"), so
      // also surface each issue with its full dotted path.
      return {
        error: 'Invalid contract',
        details: {
          ...parsed.error.flatten(),
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'treaty_reference', 'TRTY');
      const { rows } = await db.query<{ id: string }>(
        `insert into contract
           (tenant_id, reference, name, contract_kind, basis, proportional_type, np_type,
            line_of_business, direction, cedent_party_id, broker_party_id, currency,
            period_start, period_end, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'DRAFT',$15) returning id`,
        [
          ctx.tenantId, ref, b.name, b.contractKind, b.basis, b.proportionalType ?? null, b.npType ?? null,
          b.lineOfBusiness ?? null, b.direction, b.cedentPartyId ?? null, b.brokerPartyId ?? null, b.currency,
          b.periodStart ?? null, b.periodEnd ?? null, ctx.userId,
        ],
      );
      const id = rows[0]!.id;
      if (b.terms && Object.keys(b.terms).length > 0) {
        await db.query(
          `insert into term_set (tenant_id, contract_id, terms, created_by) values ($1,$2,$3,$4)`,
          [ctx.tenantId, id, JSON.stringify(b.terms), ctx.userId],
        );
      }
      await writeAudit(db, ctx, { action: 'create', entityType: 'contract', entityId: id, after: { name: b.name, status: 'DRAFT' }, actorLabel: req.auth?.displayName });
      reply.code(201);
      return { id, reference: ref, status: 'DRAFT' };
    });
  });

  // State transition with validation (§28.3). Binding also books the deposit premium.
  app.post<{ Params: { id: string }; Body: { to: string; overrideAccumulation?: boolean } }>(
    '/api/treaties/:id/transition',
    { preHandler: requirePermission('treaty:bind') },
    async (req, reply) => {
      const ctx = authContext(req);
      const to = req.body?.to;
      return runAs(ctx, async (db) => {
        const contract = await loadContract(db, req.params.id);
        if (!contract) {
          reply.code(404);
          return { error: 'Treaty not found' };
        }
        const allowed = STATUS_TRANSITIONS[contract.status] ?? [];
        if (!allowed.includes(to)) {
          reply.code(409);
          return { error: `Illegal transition ${contract.status} → ${to}. Allowed: ${allowed.join(', ') || 'none'}` };
        }

        const events: unknown[] = [];
        let accumulationWarnings: unknown[] | undefined;
        if (to === 'BOUND') {
          // Accumulation control at bind (industry-gap-analysis Tier-3 item 14):
          // project "aggregate becomes X vs limit Y" for every limited zone this
          // contract touches, before anything is written. A no-op (checked=false)
          // when the tenant has no active zone limits. HARD breach → 409 with the
          // zones and numbers (nothing has been mutated, so nothing commits);
          // SOFT breach → bind with warnings; an admin with `admin:manage` may
          // pass { overrideAccumulation: true } to downgrade a HARD breach to a
          // warning - audited as an 'accumulation override'.
          const acc = await checkContractAccumulation(db, contract);
          if (acc.checked && acc.verdict !== 'PASS') {
            // breachDetail: normalised zone shape shared between the 409 body and
            // the 200 warnings field. Includes `zoneCode` and `addedMinor` aliases
            // (P3-D CapacityBreachZone contract) alongside the original field names
            // so existing callers are unaffected.
            const breachDetail = (zs: typeof acc.zones) =>
              zs.map((z) => ({
                // Canonical CapacityBreachZone fields (P3-D contract)
                zoneCode: z.zone,
                addedMinor: z.additionMinor,
                // Original fields kept for backwards compatibility
                zone: z.zone, peril: z.peril, currency: z.currency, mode: z.mode,
                currentMinor: z.currentMinor, additionMinor: z.additionMinor,
                projectedMinor: z.projectedMinor, limitMinor: z.limitMinor, headroomMinor: z.headroomMinor,
                message: `Zone ${z.zone}${z.peril ? ` (${z.peril})` : ''}: aggregate becomes ${z.projectedMinor} vs limit ${z.limitMinor} ${z.currency} (${z.mode})`,
              }));
            if (acc.verdict === 'BLOCK') {
              const overrideRequested = req.body?.overrideAccumulation === true;
              const isAdmin = req.auth?.permissions.includes('admin:manage') === true;
              if (!(overrideRequested && isAdmin)) {
                reply.code(409);
                // CAPACITY_BREACH: structured error for the web (P3-D). The
                // `code` field is the stable discriminator; `error` is kept for
                // backwards compatibility with any existing error-message readers.
                return {
                  code: 'CAPACITY_BREACH',
                  error: 'Accumulation limit breached - binding blocked',
                  verdict: 'BLOCK',
                  exposureSource: acc.exposureSource,
                  zones: breachDetail([...acc.blocked, ...acc.warnings]),
                };
              }
              await writeAudit(db, ctx, {
                action: 'accumulation_override',
                entityType: 'contract',
                entityId: contract.id,
                after: { note: 'accumulation override', exposureSource: acc.exposureSource, zones: breachDetail(acc.blocked) },
                actorLabel: req.auth?.displayName,
              });
            } else {
              await writeAudit(db, ctx, {
                action: 'accumulation_warning',
                entityType: 'contract',
                entityId: contract.id,
                after: { note: 'bound despite soft accumulation breach', exposureSource: acc.exposureSource, zones: breachDetail(acc.warnings) },
                actorLabel: req.auth?.displayName,
              });
            }
            accumulationWarnings = breachDetail([...acc.blocked, ...acc.warnings]);
          }
          events.push(...(await bookDepositPremium(db, ctx, contract, req.auth?.displayName)));
        }

        await db.query(`update contract set status = $1, updated_at = now() where id = $2`, [to, contract.id]);
        await writeAudit(db, ctx, {
          action: to === 'BOUND' ? 'bind' : 'transition',
          entityType: 'contract',
          entityId: contract.id,
          before: { status: contract.status },
          after: { status: to },
          actorLabel: req.auth?.displayName,
        });

        // Notify underwriters when a treaty is bound (starts the accounting chain).
        if (to === 'BOUND') {
          await notify(db, ctx.tenantId, {
            userId: ctx.userId,
            title: 'Treaty bound',
            body: `Treaty ${(contract as Record<string, unknown>).reference as string ?? contract.id} has been bound and deposit premium booked.`,
            kind: 'FINANCE',
            severity: 'INFO',
            link: `/treaties/${contract.id}`,
            entityType: 'contract',
            entityId: contract.id,
          });
        }

        return {
          id: contract.id,
          status: to,
          financialEvents: events,
          ...(accumulationWarnings && accumulationWarnings.length > 0 ? { warnings: accumulationWarnings } : {}),
        };
      });
    },
  );
}

interface ContractRow {
  id: string;
  status: string;
  currency: string;
  terms: Record<string, unknown> | null;
}

async function bookDepositPremium(
  db: Db,
  ctx: { tenantId: string; userId: string },
  contract: ContractRow,
  actorLabel?: string,
): Promise<unknown[]> {
  const terms = contract.terms ?? {};
  const ccy = contract.currency;

  // Prefer an explicit deposit premium; else derive from EPI × depositPct (§7.3 step 6).
  let deposit;
  if (typeof terms.depositPremium === 'number') {
    deposit = fromMajor(terms.depositPremium, ccy);
  } else if (typeof terms.estimatedPremiumIncome === 'number' && typeof terms.depositPct === 'number') {
    deposit = multiply(fromMajor(terms.estimatedPremiumIncome, ccy), terms.depositPct / 100);
  } else {
    deposit = money(0, ccy);
  }
  if (deposit.amount === 0) return [];

  const { rows } = await db.query<{ id: string }>(
    `insert into financial_event (tenant_id, contract_id, event_type, direction, amount_minor, currency, booked_at, narrative, created_by)
     values ($1,$2,'DEPOSIT_PREMIUM','DR',$3,$4,current_date,$5,$6) returning id`,
    [ctx.tenantId, contract.id, deposit.amount, ccy, 'Deposit premium booked on binding', ctx.userId],
  );
  await writeAudit(db, ctx, {
    action: 'create',
    entityType: 'financial_event',
    entityId: rows[0]!.id,
    after: { type: 'DEPOSIT_PREMIUM', amountMinor: deposit.amount, currency: ccy },
    actorLabel,
  });
  return [{ id: rows[0]!.id, eventType: 'DEPOSIT_PREMIUM', amountMinor: deposit.amount, currency: ccy }];
}

async function loadContract(db: Db, id: string): Promise<(ContractRow & Record<string, unknown>) | null> {
  const { rows } = await db.query(
    `select c.id, c.reference, c.name, c.contract_kind as "contractKind", c.basis,
            c.proportional_type as "proportionalType", c.np_type as "npType",
            c.line_of_business as "lineOfBusiness", c.direction, c.currency,
            c.cedent_party_id as "cedentPartyId", c.broker_party_id as "brokerPartyId",
            ced.short_name as "cedentName", brk.short_name as "brokerName",
            c.period_start as "periodStart", c.period_end as "periodEnd", c.status, c.wording_ref as "wordingRef"
       from contract c
       left join party ced on ced.id = c.cedent_party_id
       left join party brk on brk.id = c.broker_party_id
      where c.id = $1 and not c.is_deleted`,
    [id],
  );
  const c = rows[0] as (ContractRow & Record<string, unknown>) | undefined;
  if (!c) return null;

  const layers = await db.query(
    `select id, layer_no as "layerNo", name, currency,
            attachment_minor as "attachmentMinor", limit_minor as "limitMinor", aad_minor as "aadMinor",
            reinstatements, reinstatement_rates as "reinstatementRates", rate_on_line as "rateOnLine"
       from contract_layer where contract_id = $1 order by layer_no`,
    [id],
  );
  const participations = await db.query(
    `select p.id, p.layer_id as "layerId", p.party_id as "partyId", pty.short_name as "partyName",
            p.written_line as "writtenLine", p.signed_line as "signedLine", p.order_pct as "orderPct", p.status
       from participation p left join party pty on pty.id = p.party_id
      where p.contract_id = $1`,
    [id],
  );
  const terms = await db.query<{ terms: Record<string, unknown> }>(
    `select terms from term_set where contract_id = $1 order by version desc limit 1`,
    [id],
  );
  c.layers = layers.rows;
  c.participations = participations.rows;
  c.terms = terms.rows[0]?.terms ?? {};
  return c;
}
