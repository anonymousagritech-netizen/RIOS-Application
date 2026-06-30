/**
 * Treaty / contract module (brief §7.2–§7.3, §29.1).
 *
 * Implements the core lifecycle and the binding transition, which generates the
 * deposit-premium Financial Event(s) from the term set — the start of the
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

const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['QUOTED', 'PLACING', 'CANCELLED'],
  QUOTED: ['PLACING', 'BOUND', 'CANCELLED'],
  PLACING: ['BOUND', 'CANCELLED'],
  BOUND: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['EXPIRING', 'RUNOFF', 'COMMUTED', 'CANCELLED'],
  EXPIRING: ['RENEWED', 'RUNOFF', 'LAPSED'],
  RUNOFF: ['COMMUTED', 'CLOSED'],
};

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
  terms: z.record(z.unknown()).optional(),
});

export async function treatiesModule(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; kind?: string } }>(
    '/api/treaties',
    { preHandler: requirePermission('treaty:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select c.id, c.reference, c.name, c.contract_kind as "contractKind", c.basis,
                  c.proportional_type as "proportionalType", c.np_type as "npType",
                  c.line_of_business as "lineOfBusiness", c.direction, c.currency,
                  c.period_start as "periodStart", c.period_end as "periodEnd", c.status,
                  ced.short_name as "cedentName"
             from contract c
             left join party ced on ced.id = c.cedent_party_id
            where not c.is_deleted
              and ($1::citext is null or c.status = $1)
              and ($2::citext is null or c.contract_kind = $2)
            order by c.created_at desc`,
          [req.query.status ?? null, req.query.kind ?? null],
        );
        return { treaties: rows };
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
      return { error: 'Invalid contract', details: parsed.error.flatten() };
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
  app.post<{ Params: { id: string }; Body: { to: string } }>(
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
        if (to === 'BOUND') {
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
        return { id: contract.id, status: to, financialEvents: events };
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
            c.period_start as "periodStart", c.period_end as "periodEnd", c.status, c.wording_ref as "wordingRef"
       from contract c where c.id = $1 and not c.is_deleted`,
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
