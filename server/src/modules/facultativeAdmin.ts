/**
 * Facultative Administration workspace (brief §7). Enterprise depth on top of
 * the `risk` table: market quotes (for quote comparison), a signed-down
 * placement tower (lead / follow / coinsurance / retro) and engineering /
 * inspection reports, with a placement dashboard. Placement roll-up and best-
 * quote selection come from @rios/domain/facultative. Ties to parties (markets)
 * and the audit trail (timeline). Money is integer minor units.
 *
 * Reads gate on facultative:read, writes on facultative:write.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { facPlacement, bestQuote, averageQuotedRate, type PlacementLine, type Quote } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const minor = (v: number | undefined) => (v === undefined ? 0 : Math.round(v * 100));

async function placementFor(db: Db, riskId: string): Promise<PlacementLine[]> {
  const { rows } = await db.query<{ written_pct: string; signed_pct: string; premium_minor: string }>(
    `select written_pct, signed_pct, premium_minor from fac_placement_line where risk_id = $1`, [riskId]);
  return rows.map((r) => ({ writtenPct: Number(r.written_pct), signedPct: Number(r.signed_pct), premiumMinor: Number(r.premium_minor) }));
}

async function quotesFor(db: Db, riskId: string): Promise<(Quote & { reinsurerName: string | null; validUntil: string | null })[]> {
  const { rows } = await db.query<{ id: string; reinsurerName: string | null; sharePct: string; premiumMinor: string; ratePct: string | null; status: string; validUntil: string | null; note: string | null }>(
    `select q.id, coalesce(q.reinsurer_name, p.short_name) as "reinsurerName", q.share_pct as "sharePct",
            q.premium_minor as "premiumMinor", q.rate_pct as "ratePct", q.status,
            to_char(q.valid_until,'YYYY-MM-DD') as "validUntil", q.note
       from fac_quote q left join party p on p.id = q.reinsurer_party_id where q.risk_id = $1 order by q.rate_pct nulls last`, [riskId]);
  return rows.map((r) => ({
    id: r.id, reinsurerName: r.reinsurerName, sharePct: Number(r.sharePct), premiumMinor: Number(r.premiumMinor),
    ratePct: r.ratePct != null ? Number(r.ratePct) : null, status: r.status, validUntil: r.validUntil,
    note: r.note as unknown as undefined,
  }));
}

export async function facultativeAdminModule(app: FastifyInstance): Promise<void> {
  // ---- Dashboard / register ------------------------------------------------
  app.get('/api/facultative-admin', { preHandler: requirePermission('facultative:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const risks = await db.query<{ id: string; reference: string; insuredName: string | null; lineOfBusiness: string | null; country: string | null; perilZone: string | null; sumInsuredMinor: string; currency: string; inception: string | null; expiry: string | null; signed: string | null; quotes: string }>(
        `select r.id, r.reference, r.insured_name as "insuredName", r.line_of_business::text as "lineOfBusiness",
                r.country, r.peril_zone as "perilZone", r.sum_insured_minor as "sumInsuredMinor", r.currency,
                to_char(r.inception,'YYYY-MM-DD') as inception, to_char(r.expiry,'YYYY-MM-DD') as expiry,
                (select coalesce(sum(signed_pct),0) from fac_placement_line pl where pl.risk_id = r.id) as signed,
                (select count(*) from fac_quote q where q.risk_id = r.id)::int as quotes
           from risk r order by r.inception desc nulls last, r.reference`);
      const rows = risks.rows.map((r) => {
        const signedPct = Number(r.signed ?? 0);
        const status = signedPct <= 0 ? 'UNPLACED' : signedPct >= 100 ? 'COMPLETE' : signedPct > 100 ? 'OVERSUBSCRIBED' : 'PARTIAL';
        return {
          id: r.id, reference: r.reference, insuredName: r.insuredName, lineOfBusiness: r.lineOfBusiness,
          country: r.country, perilZone: r.perilZone, sumInsuredMinor: Number(r.sumInsuredMinor), currency: r.currency,
          inception: r.inception, expiry: r.expiry, signedPct, quotes: Number(r.quotes), placementStatus: status,
        };
      });
      const byLob = await db.query<{ key: string; n: number }>(
        `select coalesce(line_of_business::text,'Other') key, count(*)::int n from risk group by 1 order by n desc limit 8`);
      const totalTsi = rows.reduce((a, r) => a + r.sumInsuredMinor, 0);
      const placed = rows.filter((r) => r.placementStatus === 'COMPLETE' || r.placementStatus === 'OVERSUBSCRIBED').length;
      const byStatus: Record<string, number> = {};
      for (const r of rows) byStatus[r.placementStatus] = (byStatus[r.placementStatus] ?? 0) + 1;
      return {
        risks: rows,
        byLob: byLob.rows,
        byStatus: Object.entries(byStatus).map(([key, n]) => ({ key, n })),
        totals: {
          risks: rows.length, placed, unplaced: rows.filter((r) => r.placementStatus === 'UNPLACED').length,
          totalTsiMinor: totalTsi, quotes: rows.reduce((a, r) => a + r.quotes, 0),
          placementRatePct: rows.length ? Math.round((placed / rows.length) * 1000) / 10 : 0,
        },
      };
    });
  });

  // ---- Risk detail (quotes, placement tower, engineering, timeline) --------
  app.get<{ Params: { id: string } }>('/api/facultative-admin/:id', { preHandler: requirePermission('facultative:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const r = await db.query(
        `select id, reference, description, insured_name as "insuredName", line_of_business::text as "lineOfBusiness",
                country, peril_zone as "perilZone", sum_insured_minor as "sumInsuredMinor", currency,
                to_char(inception,'YYYY-MM-DD') as inception, to_char(expiry,'YYYY-MM-DD') as expiry
           from risk where id = $1`, [req.params.id]);
      if (!r.rows[0]) { reply.code(404); return { error: 'Risk not found' }; }
      const sumInsured = Number(r.rows[0].sumInsuredMinor);

      const quotes = await quotesFor(db, req.params.id);
      const best = bestQuote(quotes, sumInsured);
      const lines = await db.query(
        `select l.id, coalesce(l.reinsurer_name, p.short_name) as "reinsurerName", l.kind, l.written_pct as "writtenPct",
                l.signed_pct as "signedPct", l.premium_minor as "premiumMinor", l.status
           from fac_placement_line l left join party p on p.id = l.reinsurer_party_id where l.risk_id = $1 order by l.kind, l.signed_pct desc`, [req.params.id]);
      const placement = facPlacement(await placementFor(db, req.params.id));
      const engineering = await db.query(
        `select id, kind, inspector, risk_grade as "riskGrade", findings, to_char(inspected_on,'YYYY-MM-DD') as "inspectedOn"
           from fac_engineering where risk_id = $1 order by inspected_on desc nulls last`, [req.params.id]);
      const timeline = await db.query(
        `select occurred_at as at, action, actor_label as actor, entity_type as "entityType"
           from audit_log where entity_id = $1 order by id desc limit 30`, [req.params.id]);

      return {
        ...r.rows[0], sumInsuredMinor: sumInsured,
        quotes, bestQuoteId: best?.id ?? null, averageRatePct: averageQuotedRate(quotes),
        placementLines: lines.rows, placement,
        engineering: engineering.rows, timeline: timeline.rows,
      };
    });
  });

  // ---- Add a market quote --------------------------------------------------
  const quoteSchema = z.object({
    reinsurerPartyId: z.string().uuid().nullable().optional(), reinsurerName: z.string().optional(),
    sharePct: z.number().min(0).max(100), premium: z.number().nonnegative(), ratePct: z.number().nonnegative().optional(),
    status: z.enum(['PENDING', 'QUOTED', 'ACCEPTED', 'DECLINED', 'EXPIRED']).default('QUOTED'),
    validUntil: z.string().optional(), note: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/facultative-admin/:id/quotes', { preHandler: requirePermission('facultative:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = quoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid quote', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into fac_quote (tenant_id, risk_id, reinsurer_party_id, reinsurer_name, share_pct, premium_minor, rate_pct, status, valid_until, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [ctx.tenantId, req.params.id, b.reinsurerPartyId ?? null, b.reinsurerName ?? null, b.sharePct, minor(b.premium), b.ratePct ?? null, b.status, b.validUntil ?? null, b.note ?? null]);
      await writeAudit(db, ctx, { action: 'fac_quote_add', entityType: 'risk', entityId: req.params.id, after: { sharePct: b.sharePct, status: b.status } });
      return { id: rows[0]!.id };
    });
  });

  // ---- Add a placement line ------------------------------------------------
  const lineSchema = z.object({
    reinsurerPartyId: z.string().uuid().nullable().optional(), reinsurerName: z.string().optional(),
    kind: z.enum(['LEAD', 'FOLLOW', 'COINSURANCE', 'RETRO']).default('FOLLOW'),
    writtenPct: z.number().min(0).max(100), signedPct: z.number().min(0).max(100), premium: z.number().nonnegative().optional(),
    status: z.enum(['OFFERED', 'WRITTEN', 'SIGNED']).default('WRITTEN'),
  });
  app.post<{ Params: { id: string } }>('/api/facultative-admin/:id/placement', { preHandler: requirePermission('facultative:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = lineSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid line', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into fac_placement_line (tenant_id, risk_id, reinsurer_party_id, reinsurer_name, kind, written_pct, signed_pct, premium_minor, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.tenantId, req.params.id, b.reinsurerPartyId ?? null, b.reinsurerName ?? null, b.kind, b.writtenPct, b.signedPct, minor(b.premium), b.status]);
      await writeAudit(db, ctx, { action: 'fac_line_add', entityType: 'risk', entityId: req.params.id, after: { kind: b.kind, signedPct: b.signedPct } });
      return { id: rows[0]!.id };
    });
  });

  // ---- Add an engineering / inspection report ------------------------------
  const engSchema = z.object({
    kind: z.enum(['ENGINEERING', 'INSPECTION', 'SURVEY', 'VALUATION']).default('ENGINEERING'),
    inspector: z.string().optional(), riskGrade: z.enum(['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'SEVERE']).nullable().optional(),
    findings: z.string().optional(), inspectedOn: z.string().optional(),
  });
  app.post<{ Params: { id: string } }>('/api/facultative-admin/:id/engineering', { preHandler: requirePermission('facultative:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = engSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid report', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into fac_engineering (tenant_id, risk_id, kind, inspector, risk_grade, findings, inspected_on)
         values ($1,$2,$3,$4,$5,$6,coalesce($7::date, current_date)) returning id`,
        [ctx.tenantId, req.params.id, b.kind, b.inspector ?? null, b.riskGrade ?? null, b.findings ?? null, b.inspectedOn ?? null]);
      await writeAudit(db, ctx, { action: 'fac_engineering_add', entityType: 'risk', entityId: req.params.id, after: { kind: b.kind, riskGrade: b.riskGrade } });
      return { id: rows[0]!.id };
    });
  });
}
