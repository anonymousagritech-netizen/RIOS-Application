/**
 * Broker management (brief §7 / §28). Brokers are parties (party_role 'broker').
 * This module adds the relationship profile, terms-of-business contracts,
 * communications log and derives the broker's portfolio / performance /
 * profitability from the submission and claim books. Reinsurance scoring lives in
 * @rios/domain (counterparty); this module orchestrates + persists.
 *
 * Reads gate on party:read, writes on party:write. Money is integer minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { counterpartyScore, counterpartyProfitability, brokerTierForVolume } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const minor = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100));

/** Derive a broker's book (GWP proxy, conversion, incurred, renewals) from the
 *  submission + claim tables. Honest proxies from real data: GWP ≈ Σ submission
 *  est premium placed via the broker; incurred ≈ Σ claims on their contracts. */
async function brokerBook(db: Db, brokerId: string, yearsActive: number) {
  const { rows } = await db.query<{
    gwp: string; bound: string; quoted: string; renewed: string; up_for_renewal: string;
  }>(
    `select
        coalesce(sum(est_premium_minor),0)::bigint as gwp,
        count(*) filter (where stage = 'BOUND')::int as bound,
        count(*) filter (where stage in ('QUOTED','BOUND'))::int as quoted,
        count(*) filter (where stage = 'BOUND' and renewal_of_id is not null)::int as renewed,
        count(*) filter (where renewal_of_id is not null)::int as up_for_renewal
       from submission where broker_party_id = $1`,
    [brokerId],
  );
  const s = rows[0]!;
  const incurred = await db.query<{ incurred: string }>(
    `select coalesce(sum(c.gross_loss_minor),0)::bigint as incurred
       from claim c join contract ct on ct.id = c.contract_id
      where ct.broker_party_id = $1 and not c.is_deleted`,
    [brokerId],
  );
  const commission = await db.query<{ commission: string }>(
    `select coalesce(sum(est_premium_minor),0)::bigint * coalesce(max(bc.commission_pct),15) / 100 as commission
       from submission s left join broker_contract bc on bc.broker_party_id = s.broker_party_id
      where s.broker_party_id = $1 and s.stage = 'BOUND'`,
    [brokerId],
  );
  return {
    gwpMinor: Number(s.gwp),
    incurredMinor: Number(incurred.rows[0]!.incurred),
    commissionMinor: Math.round(Number(commission.rows[0]!.commission ?? 0)),
    contractsBound: Number(s.bound),
    contractsQuoted: Number(s.quoted),
    renewedCount: Number(s.renewed),
    upForRenewalCount: Number(s.up_for_renewal),
    yearsActive,
  };
}

export async function brokersModule(app: FastifyInstance): Promise<void> {
  // ---- List brokers with derived KPIs --------------------------------------
  app.get('/api/brokers', { preHandler: requirePermission('party:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select p.id, p.legal_name as "legalName", p.short_name as "shortName", p.country,
                bp.tier, bp.region, bp.relationship_score as "relationshipScore",
                coalesce(sub.gwp,0)::bigint as "gwpMinor", coalesce(sub.bound,0)::int as "boundCount",
                coalesce(bc.n,0)::int as "contractCount"
           from party p
           join party_role pr on pr.party_id = p.id and pr.role_code = 'broker' and pr.is_active
           left join broker_profile bp on bp.party_id = p.id
           left join (select broker_party_id, sum(est_premium_minor) gwp, count(*) filter (where stage='BOUND') bound
                        from submission group by broker_party_id) sub on sub.broker_party_id = p.id
           left join (select broker_party_id, count(*) n from broker_contract group by broker_party_id) bc on bc.broker_party_id = p.id
          where not p.is_deleted
          order by "gwpMinor" desc, p.legal_name`,
      );
      const brokers = rows.map((r) => ({ ...r, tier: r.tier ?? brokerTierForVolume(Number(r.gwpMinor)) }));
      return { brokers };
    });
  });

  // ---- Broker analytics (book roll-up) -------------------------------------
  app.get('/api/brokers/analytics', { preHandler: requirePermission('party:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string; legalName: string; gwp: string }>(
        `select p.id, p.legal_name as "legalName", coalesce(sum(s.est_premium_minor),0)::bigint as gwp
           from party p join party_role pr on pr.party_id = p.id and pr.role_code='broker' and pr.is_active
           left join submission s on s.broker_party_id = p.id
          where not p.is_deleted group by p.id, p.legal_name order by gwp desc`,
      );
      const totalGwp = rows.reduce((a, r) => a + Number(r.gwp), 0);
      const tierMap: Record<string, number> = {};
      for (const r of rows) { const t = brokerTierForVolume(Number(r.gwp)); tierMap[t] = (tierMap[t] ?? 0) + 1; }
      return {
        brokerCount: rows.length,
        totalGwpMinor: totalGwp,
        topBrokers: rows.slice(0, 8).map((r) => ({ id: r.id, legalName: r.legalName, gwpMinor: Number(r.gwp) })),
        byTier: Object.entries(tierMap).map(([key, n]) => ({ key, n })),
      };
    });
  });

  // ---- Broker detail (profile, hierarchy, contracts, performance, comms) ----
  app.get<{ Params: { id: string } }>('/api/brokers/:id', { preHandler: requirePermission('party:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const p = await db.query(
        `select p.id, p.legal_name as "legalName", p.short_name as "shortName", p.country, p.reference,
                bp.tier, bp.region, bp.parent_broker_id as "parentBrokerId",
                bp.default_commission_pct as "defaultCommissionPct", bp.relationship_score as "relationshipScore", bp.notes,
                parent.legal_name as "parentName"
           from party p
           left join broker_profile bp on bp.party_id = p.id
           left join party parent on parent.id = bp.parent_broker_id
          where p.id = $1 and not p.is_deleted`, [req.params.id],
      );
      if (!p.rows[0]) { reply.code(404); return { error: 'Broker not found' }; }

      const children = await db.query(
        `select p.id, p.legal_name as "legalName" from broker_profile bp
           join party p on p.id = bp.party_id where bp.parent_broker_id = $1`, [req.params.id]);
      const contracts = await db.query(
        `select id, reference, kind, commission_pct as "commissionPct", brokerage_pct as "brokeragePct",
                to_char(period_start,'YYYY-MM-DD') as "periodStart", to_char(period_end,'YYYY-MM-DD') as "periodEnd", status
           from broker_contract where broker_party_id = $1 order by created_at desc`, [req.params.id]);
      const portfolio = await db.query(
        `select s.id, s.reference, s.title, s.stage, s.currency, s.est_premium_minor as "estPremiumMinor",
                ced.short_name as "cedentName", s.line_of_business as "lineOfBusiness"
           from submission s left join party ced on ced.id = s.cedent_party_id
          where s.broker_party_id = $1 order by s.created_at desc limit 50`, [req.params.id]);
      const comms = await db.query(
        `select id, kind, direction, subject, body, created_at as "createdAt"
           from counterparty_communication where party_id = $1 order by created_at desc limit 50`, [req.params.id]);

      const book = await brokerBook(db, req.params.id, 3);
      const score = counterpartyScore(book);
      const profitability = counterpartyProfitability(book);
      return {
        ...p.rows[0],
        tier: p.rows[0]!.tier ?? brokerTierForVolume(book.gwpMinor),
        children: children.rows, contracts: contracts.rows, portfolio: portfolio.rows, communications: comms.rows,
        book, score, profitability,
      };
    });
  });

  // ---- Upsert profile ------------------------------------------------------
  const profileSchema = z.object({
    tier: z.enum(['GLOBAL', 'REGIONAL', 'STANDARD', 'BOUTIQUE']).optional(),
    region: z.string().optional(), parentBrokerId: z.string().uuid().nullable().optional(),
    defaultCommissionPct: z.number().optional(), relationshipScore: z.number().min(0).max(100).optional(), notes: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/brokers/:id/profile', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = profileSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid profile', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      await db.query(
        `insert into broker_profile (party_id, tenant_id, tier, region, parent_broker_id, default_commission_pct, relationship_score, notes)
         values ($1,$2,coalesce($3,'STANDARD'),$4,$5,$6,$7,$8)
         on conflict (party_id) do update set tier=coalesce($3,broker_profile.tier), region=coalesce($4,broker_profile.region),
           parent_broker_id=$5, default_commission_pct=coalesce($6,broker_profile.default_commission_pct),
           relationship_score=coalesce($7,broker_profile.relationship_score), notes=coalesce($8,broker_profile.notes), updated_at=now()`,
        [req.params.id, ctx.tenantId, b.tier ?? null, b.region ?? null, b.parentBrokerId ?? null, b.defaultCommissionPct ?? null, b.relationshipScore ?? null, b.notes ?? null],
      );
      await writeAudit(db, ctx, { action: 'broker_profile', entityType: 'party', entityId: req.params.id, after: b });
      return { ok: true };
    });
  });

  // ---- Add a broker contract -----------------------------------------------
  const contractSchema = z.object({
    reference: z.string().optional(), kind: z.enum(['TOBA', 'BINDER', 'LINESLIP', 'FACILITY', 'OTHER']).default('TOBA'),
    commissionPct: z.number().optional(), brokeragePct: z.number().optional(),
    periodStart: z.string().optional(), periodEnd: z.string().optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED']).default('ACTIVE'), notes: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/brokers/:id/contracts', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = contractSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid contract', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into broker_contract (tenant_id, broker_party_id, reference, kind, commission_pct, brokerage_pct, period_start, period_end, status, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [ctx.tenantId, req.params.id, b.reference ?? null, b.kind, b.commissionPct ?? null, b.brokeragePct ?? null, b.periodStart ?? null, b.periodEnd ?? null, b.status, b.notes ?? null],
      );
      await writeAudit(db, ctx, { action: 'broker_contract', entityType: 'party', entityId: req.params.id, after: { id: rows[0]!.id, kind: b.kind } });
      return { id: rows[0]!.id };
    });
  });

  // ---- Log a communication -------------------------------------------------
  const commSchema = z.object({
    kind: z.enum(['NOTE', 'EMAIL', 'CALL', 'MEETING', 'SUBMISSION', 'RENEWAL']).default('NOTE'),
    direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']).default('INTERNAL'),
    subject: z.string().optional(), body: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/brokers/:id/communications', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = commSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid communication' }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into counterparty_communication (tenant_id, party_id, kind, direction, subject, body, actor)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [ctx.tenantId, req.params.id, b.kind, b.direction, b.subject ?? null, b.body ?? null, ctx.userId],
      );
      return { id: rows[0]!.id };
    });
  });
}
