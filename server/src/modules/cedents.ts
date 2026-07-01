/**
 * Cedent management (brief §7 / §28). Cedents are parties (party_role 'cedent').
 * This module adds the relationship / rating profile and group structure, and
 * derives the cedent workspace - portfolio, historical treaties & facultative,
 * loss / premium / claims history, exposure and capacity allocation - from the
 * submission, contract and claim books. Scoring lives in @rios/domain.
 *
 * Reads gate on party:read, writes on party:write. Money is integer minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { counterpartyScore, counterpartyProfitability } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { toCsv, majorFromMinor } from '../csv.js';

async function cedentBook(db: Db, cedentId: string, yearsActive: number) {
  const { rows } = await db.query<{ gwp: string; bound: string; quoted: string; renewed: string; up_for_renewal: string }>(
    `select coalesce(sum(est_premium_minor),0)::bigint as gwp,
            count(*) filter (where stage='BOUND')::int as bound,
            count(*) filter (where stage in ('QUOTED','BOUND'))::int as quoted,
            count(*) filter (where stage='BOUND' and renewal_of_id is not null)::int as renewed,
            count(*) filter (where renewal_of_id is not null)::int as up_for_renewal
       from submission where cedent_party_id = $1`, [cedentId]);
  const s = rows[0]!;
  const incurred = await db.query<{ incurred: string; paid: string; outstanding: string }>(
    `select coalesce(sum(c.gross_loss_minor),0)::bigint as incurred,
            coalesce(sum(c.paid_minor),0)::bigint as paid,
            coalesce(sum(c.outstanding_minor),0)::bigint as outstanding
       from claim c join contract ct on ct.id = c.contract_id
      where ct.cedent_party_id = $1 and not c.is_deleted`, [cedentId]);
  return {
    gwpMinor: Number(s.gwp), incurredMinor: Number(incurred.rows[0]!.incurred),
    commissionMinor: Math.round(Number(s.gwp) * 0.2),
    contractsBound: Number(s.bound), contractsQuoted: Number(s.quoted),
    renewedCount: Number(s.renewed), upForRenewalCount: Number(s.up_for_renewal), yearsActive,
    paidMinor: Number(incurred.rows[0]!.paid), outstandingMinor: Number(incurred.rows[0]!.outstanding),
  };
}

export async function cedentsModule(app: FastifyInstance): Promise<void> {
  // ---- List cedents with derived KPIs --------------------------------------
  app.get('/api/cedents', { preHandler: requirePermission('party:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select p.id, p.legal_name as "legalName", p.short_name as "shortName", p.country,
                cp.rating, cp.rating_agency as "ratingAgency", cp.relationship_score as "relationshipScore",
                cp.capacity_allocated_minor as "capacityAllocatedMinor",
                coalesce(sub.gwp,0)::bigint as "gwpMinor", coalesce(sub.bound,0)::int as "boundCount"
           from party p
           join party_role pr on pr.party_id = p.id and pr.role_code = 'cedent' and pr.is_active
           left join cedent_profile cp on cp.party_id = p.id
           left join (select cedent_party_id, sum(est_premium_minor) gwp, count(*) filter (where stage='BOUND') bound
                        from submission group by cedent_party_id) sub on sub.cedent_party_id = p.id
          where not p.is_deleted
          order by "gwpMinor" desc, p.legal_name`,
      );
      return { cedents: rows };
    });
  });

  // ---- Cedent analytics ----------------------------------------------------
  app.get('/api/cedents/analytics', { preHandler: requirePermission('party:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string; legalName: string; gwp: string; incurred: string }>(
        `select p.id, p.legal_name as "legalName",
                coalesce(sum(s.est_premium_minor),0)::bigint as gwp,
                coalesce((select sum(c.gross_loss_minor) from claim c join contract ct on ct.id=c.contract_id where ct.cedent_party_id=p.id and not c.is_deleted),0)::bigint as incurred
           from party p join party_role pr on pr.party_id=p.id and pr.role_code='cedent' and pr.is_active
           left join submission s on s.cedent_party_id = p.id
          where not p.is_deleted group by p.id, p.legal_name order by gwp desc`,
      );
      const totalGwp = rows.reduce((a, r) => a + Number(r.gwp), 0);
      const totalIncurred = rows.reduce((a, r) => a + Number(r.incurred), 0);
      return {
        cedentCount: rows.length,
        totalGwpMinor: totalGwp,
        bookLossRatioPct: totalGwp > 0 ? Math.round((totalIncurred / totalGwp) * 1000) / 10 : 0,
        topCedents: rows.slice(0, 8).map((r) => ({ id: r.id, legalName: r.legalName, gwpMinor: Number(r.gwp), lossRatioPct: Number(r.gwp) > 0 ? Math.round((Number(r.incurred) / Number(r.gwp)) * 1000) / 10 : 0 })),
      };
    });
  });

  // ---- Cedent list export (CSV / Excel) ------------------------------------
  app.get('/api/cedents/export.csv', { preHandler: requirePermission('party:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ legalName: string; country: string | null; rating: string | null; ratingAgency: string | null; relationshipScore: number | null; gwpMinor: string; boundCount: number }>(
        `select p.legal_name as "legalName", p.country, cp.rating, cp.rating_agency as "ratingAgency", cp.relationship_score as "relationshipScore",
                coalesce(sub.gwp,0)::bigint as "gwpMinor", coalesce(sub.bound,0)::int as "boundCount"
           from party p join party_role pr on pr.party_id=p.id and pr.role_code='cedent' and pr.is_active
           left join cedent_profile cp on cp.party_id=p.id
           left join (select cedent_party_id, sum(est_premium_minor) gwp, count(*) filter (where stage='BOUND') bound from submission group by cedent_party_id) sub on sub.cedent_party_id=p.id
          where not p.is_deleted order by "gwpMinor" desc`,
      );
      const csv = toCsv(['Cedent', 'Country', 'Rating', 'Agency', 'Relationship score', 'GWP (major)', 'Bound'],
        rows.map((r) => [r.legalName, r.country ?? '', r.rating ?? '', r.ratingAgency ?? '', r.relationshipScore ?? '', majorFromMinor(r.gwpMinor), r.boundCount]));
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="cedents.csv"');
      return csv;
    });
  });

  // ---- Cedent workspace ----------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/cedents/:id', { preHandler: requirePermission('party:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const p = await db.query(
        `select p.id, p.legal_name as "legalName", p.short_name as "shortName", p.country, p.reference,
                cp.group_parent_id as "groupParentId", cp.domicile, cp.rating_agency as "ratingAgency", cp.rating,
                cp.financial_strength_minor as "financialStrengthMinor", cp.relationship_score as "relationshipScore",
                cp.capacity_allocated_minor as "capacityAllocatedMinor", cp.notes,
                parent.legal_name as "groupParentName"
           from party p left join cedent_profile cp on cp.party_id = p.id
           left join party parent on parent.id = cp.group_parent_id
          where p.id = $1 and not p.is_deleted`, [req.params.id]);
      if (!p.rows[0]) { reply.code(404); return { error: 'Cedent not found' }; }

      const groupMembers = await db.query(
        `select p.id, p.legal_name as "legalName" from cedent_profile cp
           join party p on p.id = cp.party_id where cp.group_parent_id = $1`, [req.params.id]);
      const portfolio = await db.query(
        `select s.id, s.reference, s.title, s.stage, s.currency, s.structure, s.line_of_business as "lineOfBusiness",
                s.est_premium_minor as "estPremiumMinor", s.risk_band as "riskBand"
           from submission s where s.cedent_party_id = $1 order by s.created_at desc limit 50`, [req.params.id]);
      const treaties = await db.query(
        `select ct.id, ct.reference, ct.name, ct.contract_kind as "contractKind", ct.basis, ct.status,
                to_char(ct.period_start,'YYYY-MM-DD') as "periodStart", to_char(ct.period_end,'YYYY-MM-DD') as "periodEnd"
           from contract ct where ct.cedent_party_id = $1 and not ct.is_deleted order by ct.period_start desc nulls last limit 50`, [req.params.id]);
      const claims = await db.query(
        `select c.id, c.reference, c.description, to_char(c.loss_date,'YYYY-MM-DD') as "lossDate", c.status, c.currency,
                c.gross_loss_minor as "grossLossMinor", c.outstanding_minor as "outstandingMinor", c.paid_minor as "paidMinor"
           from claim c join contract ct on ct.id = c.contract_id
          where ct.cedent_party_id = $1 and not c.is_deleted order by c.loss_date desc nulls last limit 50`, [req.params.id]);
      const comms = await db.query(
        `select id, kind, direction, subject, body, created_at as "createdAt"
           from counterparty_communication where party_id = $1 order by created_at desc limit 50`, [req.params.id]);

      const book = await cedentBook(db, req.params.id, 3);
      const score = counterpartyScore(book);
      const profitability = counterpartyProfitability(book);
      return {
        ...p.rows[0], groupMembers: groupMembers.rows, portfolio: portfolio.rows, treaties: treaties.rows,
        claims: claims.rows, communications: comms.rows,
        book, score, profitability,
        lossHistory: { incurredMinor: book.incurredMinor, paidMinor: book.paidMinor, outstandingMinor: book.outstandingMinor },
      };
    });
  });

  // ---- Upsert profile ------------------------------------------------------
  const profileSchema = z.object({
    groupParentId: z.string().uuid().nullable().optional(), domicile: z.string().length(2).optional(),
    ratingAgency: z.string().optional(), rating: z.string().optional(),
    financialStrength: z.number().optional(), relationshipScore: z.number().min(0).max(100).optional(),
    capacityAllocated: z.number().optional(), notes: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/cedents/:id/profile', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = profileSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid profile', details: parsed.error.flatten() }; }
    const b = parsed.data;
    const cap = b.capacityAllocated === undefined ? null : Math.round(b.capacityAllocated * 100);
    const fin = b.financialStrength === undefined ? null : Math.round(b.financialStrength * 100);
    return runAs(ctx, async (db) => {
      await db.query(
        `insert into cedent_profile (party_id, tenant_id, group_parent_id, domicile, rating_agency, rating, financial_strength_minor, relationship_score, capacity_allocated_minor, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (party_id) do update set group_parent_id=$3, domicile=coalesce($4,cedent_profile.domicile),
           rating_agency=coalesce($5,cedent_profile.rating_agency), rating=coalesce($6,cedent_profile.rating),
           financial_strength_minor=coalesce($7,cedent_profile.financial_strength_minor),
           relationship_score=coalesce($8,cedent_profile.relationship_score),
           capacity_allocated_minor=coalesce($9,cedent_profile.capacity_allocated_minor), notes=coalesce($10,cedent_profile.notes), updated_at=now()`,
        [req.params.id, ctx.tenantId, b.groupParentId ?? null, b.domicile ?? null, b.ratingAgency ?? null, b.rating ?? null, fin, b.relationshipScore ?? null, cap, b.notes ?? null],
      );
      await writeAudit(db, ctx, { action: 'cedent_profile', entityType: 'party', entityId: req.params.id, after: b });
      return { ok: true };
    });
  });

  // ---- Log a communication -------------------------------------------------
  const commSchema = z.object({
    kind: z.enum(['NOTE', 'EMAIL', 'CALL', 'MEETING', 'SUBMISSION', 'RENEWAL']).default('NOTE'),
    direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']).default('INTERNAL'),
    subject: z.string().optional(), body: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/cedents/:id/communications', { preHandler: requirePermission('party:write') }, async (req, reply) => {
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
