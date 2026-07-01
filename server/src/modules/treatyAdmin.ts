/**
 * Treaty Administration (brief §28). Enterprise treaty management on top of the
 * contract / contract_layer / contract_endorsement model: the treaty register,
 * a priced layer tower (@rios/domain/treatyLayer), versioning (immutable
 * snapshots), amendments/endorsements, special clauses/wording, a tax schedule,
 * a technical account and a timeline stitched from the audit trail. Ties to
 * underwriting (a bound submission references its contract) and finance/claims.
 *
 * Reads gate on treaty:read, writes on treaty:write. Money is integer minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { treatyLayerBook, technicalAccount, type LayerInput } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const minor = (v: number | undefined) => (v === undefined ? 0 : Math.round(v * 100));

async function layersFor(db: Db, contractId: string): Promise<LayerInput[]> {
  const { rows } = await db.query<{ attachment_minor: string; limit_minor: string; rate_on_line: string | null; reinstatements: number | null }>(
    `select attachment_minor, limit_minor, rate_on_line, reinstatements from contract_layer where contract_id = $1 order by layer_no`,
    [contractId],
  );
  return rows.map((r) => ({
    attachmentMinor: Number(r.attachment_minor), limitMinor: Number(r.limit_minor),
    // rate_on_line is stored as a fraction (0.10 = 10%); the domain wants a percentage.
    rolPct: r.rate_on_line != null ? Number(r.rate_on_line) * 100 : undefined, reinstatements: r.reinstatements,
  }));
}

export async function treatyAdminModule(app: FastifyInstance): Promise<void> {
  // ---- Register ------------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>('/api/treaty-admin/register', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    const status = req.query.status;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select ct.id, ct.reference, ct.name, ct.basis, ct.proportional_type as "proportionalType", ct.np_type as "npType",
                ct.line_of_business as "lineOfBusiness", ct.currency, ct.status,
                to_char(ct.period_start,'YYYY-MM-DD') as "periodStart", to_char(ct.period_end,'YYYY-MM-DD') as "periodEnd",
                ced.short_name as "cedentName", brk.short_name as "brokerName",
                (select count(*) from contract_layer cl where cl.contract_id = ct.id)::int as "layerCount",
                (select coalesce(sum(cl.limit_minor),0) from contract_layer cl where cl.contract_id = ct.id)::bigint as "totalLimitMinor",
                (select coalesce(sum(fe.amount_minor),0) from financial_event fe where fe.contract_id = ct.id and fe.event_type ilike '%premium%')::bigint as "premiumMinor"
           from contract ct
           left join party ced on ced.id = ct.cedent_party_id
           left join party brk on brk.id = ct.broker_party_id
          where ct.contract_kind = 'TREATY' and not ct.is_deleted
            and ($1::text is null or ct.status = $1)
          order by ct.period_start desc nulls last, ct.name`,
        [status ?? null],
      );
      return { treaties: rows };
    });
  });

  // ---- Dashboard analytics -------------------------------------------------
  app.get('/api/treaty-admin/analytics', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const totals = await db.query<{ n: string; total_limit: string; premium: string; layers: string }>(
        `select count(distinct ct.id)::int n,
                coalesce(sum(cl.limit_minor),0)::bigint total_limit,
                coalesce((select sum(fe.amount_minor) from financial_event fe join contract c2 on c2.id=fe.contract_id where c2.contract_kind='TREATY' and fe.event_type ilike '%premium%'),0)::bigint premium,
                count(cl.id)::int layers
           from contract ct left join contract_layer cl on cl.contract_id = ct.id
          where ct.contract_kind='TREATY' and not ct.is_deleted`,
      );
      const byStructure = await db.query<{ key: string; n: number }>(
        `select coalesce(np_type, proportional_type, basis, 'Other') key, count(*)::int n
           from contract where contract_kind='TREATY' and not is_deleted group by 1 order by n desc`,
      );
      const byStatus = await db.query<{ key: string; n: number }>(
        `select status key, count(*)::int n from contract where contract_kind='TREATY' and not is_deleted group by status order by n desc`,
      );
      const t = totals.rows[0]!;
      return {
        treatyCount: Number(t.n), totalLimitMinor: Number(t.total_limit), premiumMinor: Number(t.premium), layerCount: Number(t.layers),
        byStructure: byStructure.rows, byStatus: byStatus.rows,
      };
    });
  });

  // ---- Treaty detail (layers priced, versions, clauses, timeline) ----------
  app.get<{ Params: { id: string } }>('/api/treaty-admin/:id', { preHandler: requirePermission('treaty:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const c = await db.query(
        `select ct.id, ct.reference, ct.name, ct.contract_kind as "contractKind", ct.basis, ct.direction,
                ct.proportional_type as "proportionalType", ct.np_type as "npType", ct.line_of_business as "lineOfBusiness",
                ct.currency, ct.status, ct.wording_ref as "wordingRef", nullif(ct.market_refs::text, '{}') as "marketRefs",
                to_char(ct.period_start,'YYYY-MM-DD') as "periodStart", to_char(ct.period_end,'YYYY-MM-DD') as "periodEnd",
                ced.short_name as "cedentName", brk.short_name as "brokerName"
           from contract ct left join party ced on ced.id = ct.cedent_party_id left join party brk on brk.id = ct.broker_party_id
          where ct.id = $1 and not ct.is_deleted`, [req.params.id]);
      if (!c.rows[0]) { reply.code(404); return { error: 'Treaty not found' }; }

      const layerRows = await db.query(
        `select id, layer_no as "layerNo", name, currency, attachment_minor as "attachmentMinor", limit_minor as "limitMinor",
                aad_minor as "aadMinor", reinstatements, rate_on_line as "rateOnLine"
           from contract_layer where contract_id = $1 order by layer_no`, [req.params.id]);
      const book = treatyLayerBook(await layersFor(db, req.params.id));

      const endorsements = await db.query(
        `select id, endorsement_no as "endorsementNo", to_char(effective_date,'YYYY-MM-DD') as "effectiveDate", description, nullif(changes::text, '{}') as changes, created_at as "createdAt"
           from contract_endorsement where contract_id = $1 order by endorsement_no desc`, [req.params.id]);
      const versions = await db.query(
        `select id, version_no as "versionNo", note, created_at as "createdAt" from treaty_version where contract_id = $1 order by version_no desc`, [req.params.id]);
      const clauses = await db.query(
        `select id, code, title, category, body from treaty_clause where contract_id = $1 order by category, title`, [req.params.id]);
      const taxes = await db.query(
        `select id, kind, rate_pct as "ratePct", note from treaty_tax where contract_id = $1 order by kind`, [req.params.id]);

      // Technical account: premium / commission from the ledger, claims from claim.
      const fin = await db.query<{ premium: string; commission: string }>(
        `select coalesce(sum(amount_minor) filter (where event_type ilike '%premium%'),0)::bigint premium,
                coalesce(sum(amount_minor) filter (where event_type ilike '%commission%'),0)::bigint commission
           from financial_event where contract_id = $1`, [req.params.id]);
      const clm = await db.query<{ incurred: string }>(
        `select coalesce(sum(gross_loss_minor),0)::bigint incurred from claim where contract_id = $1 and not is_deleted`, [req.params.id]);
      const ta = technicalAccount({ premiumMinor: Number(fin.rows[0]!.premium), commissionMinor: Number(fin.rows[0]!.commission), claimsMinor: Number(clm.rows[0]!.incurred) });

      // Timeline: audit entries for this contract + its endorsements/versions.
      const timeline = await db.query(
        `select occurred_at as "at", action, actor_label as "actor", entity_type as "entityType"
           from audit_log where entity_id = $1 order by id desc limit 40`, [req.params.id]);

      return {
        ...c.rows[0], layers: layerRows.rows, layerBook: book,
        endorsements: endorsements.rows, versions: versions.rows, clauses: clauses.rows, taxes: taxes.rows,
        technicalAccount: ta, timeline: timeline.rows,
      };
    });
  });

  // ---- Add a layer ---------------------------------------------------------
  const layerSchema = z.object({
    name: z.string().optional(), attachment: z.number().nonnegative(), limit: z.number().nonnegative(),
    aad: z.number().nonnegative().optional(), reinstatements: z.number().nullable().optional(), rateOnLine: z.number().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/treaty-admin/:id/layers', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = layerSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid layer', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const cur = await db.query<{ currency: string; next: number }>(
        `select ct.currency, coalesce(max(cl.layer_no),0)+1 as next
           from contract ct left join contract_layer cl on cl.contract_id = ct.id where ct.id = $1 group by ct.currency`, [req.params.id]);
      if (!cur.rows[0]) { reply.code(404); return { error: 'Treaty not found' }; }
      const { rows } = await db.query<{ id: string }>(
        `insert into contract_layer (tenant_id, contract_id, layer_no, name, currency, attachment_minor, limit_minor, aad_minor, reinstatements, rate_on_line)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        // Client sends rate on line as a percentage (15 = 15%); store as a fraction (0.15) to match the DB convention.
        [ctx.tenantId, req.params.id, cur.rows[0].next, b.name ?? `Layer ${cur.rows[0].next}`, cur.rows[0].currency, minor(b.attachment), minor(b.limit), minor(b.aad), b.reinstatements ?? null, b.rateOnLine != null ? b.rateOnLine / 100 : null],
      );
      await writeAudit(db, ctx, { action: 'layer_add', entityType: 'contract', entityId: req.params.id, after: { layerNo: cur.rows[0].next, limit: b.limit } });
      return { id: rows[0]!.id, layerNo: cur.rows[0].next };
    });
  });

  // ---- Snapshot a version --------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/treaty-admin/:id/version', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const note = (req.body as { note?: string })?.note;
    return runAs(ctx, async (db) => {
      const c = await db.query(`select row_to_json(ct) as snap from contract ct where ct.id = $1`, [req.params.id]);
      if (!c.rows[0]) { reply.code(404); return { error: 'Treaty not found' }; }
      const layers = await db.query(`select * from contract_layer where contract_id = $1 order by layer_no`, [req.params.id]);
      const snapshot = { contract: c.rows[0].snap, layers: layers.rows };
      const { rows } = await db.query<{ version_no: number }>(
        `insert into treaty_version (tenant_id, contract_id, version_no, note, snapshot, created_by)
         select $1,$2, coalesce(max(version_no),0)+1, $3, $4, $5 from treaty_version where contract_id = $2
         returning version_no`,
        [ctx.tenantId, req.params.id, note ?? null, JSON.stringify(snapshot), ctx.userId],
      );
      await writeAudit(db, ctx, { action: 'version_snapshot', entityType: 'contract', entityId: req.params.id, after: { versionNo: rows[0]!.version_no } });
      return { versionNo: rows[0]!.version_no };
    });
  });

  // ---- Add a clause --------------------------------------------------------
  const clauseSchema = z.object({
    code: z.string().optional(), title: z.string().min(1),
    category: z.enum(['GENERAL', 'EXCLUSION', 'CONDITION', 'WARRANTY', 'COMMISSION', 'REINSTATEMENT', 'SANCTIONS', 'WORDING']).default('GENERAL'),
    body: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/treaty-admin/:id/clauses', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = clauseSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid clause', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into treaty_clause (tenant_id, contract_id, code, title, category, body) values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, req.params.id, b.code ?? null, b.title, b.category, b.body ?? null]);
      await writeAudit(db, ctx, { action: 'clause_add', entityType: 'contract', entityId: req.params.id, after: { title: b.title, category: b.category } });
      return { id: rows[0]!.id };
    });
  });

  // ---- Add an endorsement (amendment) --------------------------------------
  app.post<{ Params: { id: string } }>('/api/treaty-admin/:id/endorsements', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const b = (req.body ?? {}) as { description?: string; effectiveDate?: string; changes?: Record<string, unknown> };
    if (!b.description) { reply.code(400); return { error: 'description is required' }; }
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ endorsement_no: number }>(
        `insert into contract_endorsement (tenant_id, contract_id, endorsement_no, effective_date, description, changes, created_by)
         select $1,$2, coalesce(max(endorsement_no),0)+1, coalesce($3::date, current_date), $4, $5, $6
           from contract_endorsement where contract_id = $2 returning endorsement_no`,
        [ctx.tenantId, req.params.id, b.effectiveDate ?? null, b.description, JSON.stringify(b.changes ?? {}), ctx.userId]);
      await writeAudit(db, ctx, { action: 'endorsement_add', entityType: 'contract', entityId: req.params.id, after: { endorsementNo: rows[0]!.endorsement_no } });
      return { endorsementNo: rows[0]!.endorsement_no };
    });
  });
}
