/**
 * Client / Contact management (brief §7 / Business Management). A unified 360 over
 * every counterparty (party) regardless of role — cedent, broker, reinsurer,
 * retrocessionaire — with its roles, contacts, communications and its footprint
 * across the book (submissions, contracts, claims). Ties parties to underwriting,
 * claims and finance so no counterparty is an island.
 *
 * Reads gate on party:read, contact writes on party:write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

export async function clientsModule(app: FastifyInstance): Promise<void> {
  // ---- Directory (all parties + roles + footprint counts) ------------------
  app.get<{ Querystring: { role?: string; q?: string } }>('/api/clients', { preHandler: requirePermission('party:read') }, async (req) => {
    const ctx = authContext(req);
    const { role, q } = req.query;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select p.id, p.legal_name as "legalName", p.short_name as "shortName", p.kind, p.country, p.status,
                coalesce(array_agg(distinct pr.role_code) filter (where pr.is_active), '{}') as roles,
                (select count(*) from submission s where s.cedent_party_id = p.id or s.broker_party_id = p.id)::int as submissions,
                (select count(*) from contract c where (c.cedent_party_id = p.id or c.broker_party_id = p.id) and not c.is_deleted)::int as contracts
           from party p
           left join party_role pr on pr.party_id = p.id
          where not p.is_deleted
            and ($1::text is null or exists (select 1 from party_role r2 where r2.party_id = p.id and r2.role_code = $1 and r2.is_active))
            and ($2::text is null or p.legal_name ilike '%'||$2||'%' or p.short_name ilike '%'||$2||'%')
          group by p.id
          order by p.legal_name
          limit 300`,
        [role ?? null, q ?? null],
      );
      // Role facet counts for filter chips.
      const facets = await db.query<{ role_code: string; n: number }>(
        `select role_code, count(*)::int n from party_role pr join party p on p.id = pr.party_id
          where pr.is_active and not p.is_deleted group by role_code order by n desc`,
      );
      return { clients: rows, roles: facets.rows.map((f) => ({ key: f.role_code, n: f.n })) };
    });
  });

  // ---- Client 360 ----------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/clients/:id', { preHandler: requirePermission('party:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const p = await db.query(
        `select p.id, p.legal_name as "legalName", p.short_name as "shortName", p.kind, p.country, p.status, p.reference, p.identifiers,
                coalesce(array_agg(distinct pr.role_code) filter (where pr.is_active), '{}') as roles
           from party p left join party_role pr on pr.party_id = p.id
          where p.id = $1 and not p.is_deleted group by p.id`, [req.params.id]);
      if (!p.rows[0]) { reply.code(404); return { error: 'Client not found' }; }

      const contacts = await db.query(
        `select id, kind, value, label, is_primary as "isPrimary" from party_contact where party_id = $1 order by is_primary desc, kind`, [req.params.id]);
      const comms = await db.query(
        `select id, kind, direction, subject, body, created_at as "createdAt" from counterparty_communication where party_id = $1 order by created_at desc limit 30`, [req.params.id]);
      const submissions = await db.query(
        `select s.id, s.reference, s.title, s.stage, s.currency, s.est_premium_minor as "estPremiumMinor",
                case when s.cedent_party_id = $1 then 'cedent' else 'broker' end as "asRole"
           from submission s where s.cedent_party_id = $1 or s.broker_party_id = $1 order by s.created_at desc limit 30`, [req.params.id]);
      const contracts = await db.query(
        `select ct.id, ct.reference, ct.name, ct.contract_kind as "contractKind", ct.status, ct.currency,
                to_char(ct.period_start,'YYYY-MM-DD') as "periodStart"
           from contract ct where (ct.cedent_party_id = $1 or ct.broker_party_id = $1) and not ct.is_deleted order by ct.period_start desc nulls last limit 30`, [req.params.id]);
      const claims = await db.query(
        `select c.id, c.reference, c.description, c.status, c.currency, c.gross_loss_minor as "grossLossMinor"
           from claim c join contract ct on ct.id = c.contract_id
          where (ct.cedent_party_id = $1 or ct.broker_party_id = $1) and not c.is_deleted order by c.created_at desc limit 30`, [req.params.id]);

      return {
        ...p.rows[0], contacts: contacts.rows, communications: comms.rows,
        submissions: submissions.rows, contracts: contracts.rows, claims: claims.rows,
      };
    });
  });

  // ---- Add a contact -------------------------------------------------------
  const contactSchema = z.object({
    kind: z.enum(['email', 'phone', 'address', 'portal_user']).default('email'),
    value: z.string().min(1), label: z.string().optional(), isPrimary: z.boolean().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/clients/:id/contacts', { preHandler: requirePermission('party:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = contactSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid contact', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into party_contact (tenant_id, party_id, kind, value, label, is_primary)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, req.params.id, b.kind, b.value, b.label ?? null, b.isPrimary ?? false],
      );
      await writeAudit(db, ctx, { action: 'contact_add', entityType: 'party', entityId: req.params.id, after: { kind: b.kind } });
      return { id: rows[0]!.id };
    });
  });
}
