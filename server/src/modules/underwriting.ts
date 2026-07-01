/**
 * Underwriting Workbench (brief §7 / §28). A submission is the unit of work that
 * moves through the underwriting lifecycle. This module orchestrates it: create a
 * submission, score its risk (pure @rios/domain), price it, move it through the
 * stage machine (illegal moves rejected the same way the treaty lifecycle guards
 * transitions), and record every material step in an auditable activity trail.
 *
 * Reads gate on `treaty:read`, mutations on `treaty:write` (underwriters). The
 * reinsurance math lives in @rios/domain; this module only orchestrates + persists.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  riskScore, technicalPremium, canTransition, isTerminalStage,
  scenarioGrid, sensitivity, ratios,
  modelCatalog, validateTerms,
  requiredApproval, levelCovers, LEVEL_PERMISSION,
  recommendedClauses, missingInformation, attentionFlags, executiveSummary,
  extractDocument, inferKind, nextVersion, signatureDigest,
  type UwStage, type RiskFactorInput, type RiskBand, type ApprovalLevel, type AdvisorInput, type DocumentKind,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const createSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(['TREATY', 'FACULTATIVE']).default('TREATY'),
  basis: z.enum(['PROPORTIONAL', 'NON_PROPORTIONAL']).optional(),
  structure: z.string().optional(),
  lineOfBusiness: z.string().optional(),
  cedentPartyId: z.string().uuid().optional(),
  brokerPartyId: z.string().uuid().optional(),
  currency: z.string().length(3).default('USD'),
  inception: z.string().optional(),
  expiry: z.string().optional(),
  territory: z.string().optional(),
  sumInsured: z.number().nonnegative().optional(),
  attachment: z.number().nonnegative().optional(),
  limit: z.number().nonnegative().optional(),
  estPremium: z.number().nonnegative().optional(),
  lossRatioPct: z.number().optional(),
  catExposed: z.boolean().optional(),
  classHazard: z.number().min(1).max(5).optional(),
  priorClaims: z.number().nonnegative().optional(),
  yearsWithCedent: z.number().nonnegative().optional(),
  capacityUtilPct: z.number().min(0).max(100).optional(),
  terms: z.record(z.unknown()).optional(),
});

/** Read the stored risk factors off a submission row for (re)scoring. */
function factorsFromRow(r: {
  loss_ratio_pct: number | null; cat_exposed: boolean; class_hazard: number | null;
  prior_claims: number | null; years_with_cedent: number | null; terms: Record<string, unknown> | null;
}): RiskFactorInput {
  const capacity = typeof r.terms?.capacityUtilPct === 'number' ? (r.terms!.capacityUtilPct as number) : undefined;
  return {
    lossRatioPct: r.loss_ratio_pct ?? undefined,
    catExposed: r.cat_exposed,
    classHazard: r.class_hazard ?? undefined,
    priorClaims: r.prior_claims ?? undefined,
    yearsWithCedent: r.years_with_cedent ?? undefined,
    capacityUtilPct: capacity,
  };
}

/** Approval matrix: which senior sign-off (if any) a transition requires. The
 *  thresholds are deliberately simple + explainable; a fuller matrix would be
 *  configuration (code-list driven). Large limit ≥ 25m major units (2.5bn minor)
 *  or a HIGH risk band gates quoting/binding to underwriting:approve. */
const LARGE_LIMIT_MINOR = 25_000_000 * 100;
function approvalRequired(to: string, band: string | null, limitMinor: number | null): string | null {
  if (to !== 'QUOTED' && to !== 'BOUND') return null;
  if (band === 'HIGH') return 'HIGH risk band';
  if ((limitMinor ?? 0) >= LARGE_LIMIT_MINOR) return 'limit ≥ 25m';
  return null;
}

async function logActivity(
  db: Db, tenantId: string, submissionId: string, actor: string,
  kind: string, opts: { fromStage?: string; toStage?: string; note?: string } = {},
) {
  await db.query(
    `insert into submission_activity (tenant_id, submission_id, kind, from_stage, to_stage, note, actor)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, submissionId, kind, opts.fromStage ?? null, opts.toStage ?? null, opts.note ?? null, actor],
  );
}

export async function underwritingModule(app: FastifyInstance): Promise<void> {
  // ---- Model catalog -------------------------------------------------------
  // The declarative structure × line-of-business catalog the slip renders from.
  // Static metadata (no tenant data), so it needs only an authenticated read.
  app.get('/api/underwriting/models', { preHandler: requirePermission('treaty:read') }, async () => modelCatalog());

  // ---- Pipeline KPIs -------------------------------------------------------
  app.get('/api/underwriting/kpis', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ stage: string; n: number; epi: number; avg_score: number }>(
        `select stage, count(*)::int as n,
                coalesce(sum(est_premium_minor),0)::bigint as epi,
                coalesce(round(avg(risk_score)),0)::int as avg_score
           from submission group by stage`,
      );
      const byStage: Record<string, number> = {};
      let pipelineEpi = 0, scoreSum = 0, scoreCount = 0, bound = 0, declined = 0, lapsed = 0;
      for (const r of rows) {
        byStage[r.stage] = r.n;
        if (r.stage === 'BOUND') bound += r.n;
        else if (r.stage === 'DECLINED') declined += r.n;
        else if (r.stage === 'LAPSED') lapsed += r.n;
        else pipelineEpi += Number(r.epi);
        if (r.avg_score) { scoreSum += r.avg_score * r.n; scoreCount += r.n; }
      }
      const open = rows.filter((r) => !['BOUND', 'DECLINED', 'LAPSED'].includes(r.stage)).reduce((a, r) => a + r.n, 0);
      const decided = bound + declined + lapsed;
      return {
        byStage,
        open,
        bound,
        declined,
        lapsed,
        pipelineEpiMinor: pipelineEpi,
        avgRiskScore: scoreCount ? Math.round(scoreSum / scoreCount) : 0,
        hitRatioPct: decided ? Math.round((bound / decided) * 100) : 0,
      };
    });
  });

  // ---- List ----------------------------------------------------------------
  app.get('/api/underwriting/submissions', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    const stage = (req.query as { stage?: string }).stage;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select s.id, s.reference, s.title, s.kind, s.basis, s.structure,
                s.line_of_business as "lineOfBusiness", s.currency, s.stage,
                s.risk_score as "riskScore", s.risk_band as "riskBand",
                s.est_premium_minor as "estPremiumMinor", s.target_premium_minor as "targetPremiumMinor",
                to_char(s.inception,'YYYY-MM-DD') as inception, to_char(s.expiry,'YYYY-MM-DD') as expiry,
                ced.short_name as "cedentName", brk.short_name as "brokerName",
                s.created_at as "createdAt"
           from submission s
           left join party ced on ced.id = s.cedent_party_id
           left join party brk on brk.id = s.broker_party_id
          where ($1::text is null or s.stage = $1)
          order by s.created_at desc`,
        [stage ?? null],
      );
      return { submissions: rows };
    });
  });

  // ---- Pipeline export (CSV, opens in Excel) -------------------------------
  app.get('/api/underwriting/export.csv', { preHandler: requirePermission('reporting:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const stage = (req.query as { stage?: string }).stage;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        reference: string; title: string; kind: string; structure: string | null; line_of_business: string | null;
        currency: string; stage: string; risk_score: number | null; risk_band: string | null;
        est_premium_minor: number | null; target_premium_minor: number | null;
        cedentName: string | null; brokerName: string | null; inception: string | null; expiry: string | null;
      }>(
        `select s.reference, s.title, s.kind, s.structure, s.line_of_business,
                s.currency, s.stage, s.risk_score, s.risk_band,
                s.est_premium_minor, s.target_premium_minor,
                ced.short_name as "cedentName", brk.short_name as "brokerName",
                to_char(s.inception,'YYYY-MM-DD') as inception, to_char(s.expiry,'YYYY-MM-DD') as expiry
           from submission s
           left join party ced on ced.id = s.cedent_party_id
           left join party brk on brk.id = s.broker_party_id
          where ($1::text is null or s.stage = $1)
          order by s.created_at desc`,
        [stage ?? null],
      );
      const headers = [
        'Reference', 'Title', 'Kind', 'Structure', 'Line of business', 'Cedent', 'Broker',
        'Currency', 'Inception', 'Expiry', 'Stage', 'Risk score', 'Risk band',
        'EPI (major)', 'Technical premium (major)',
      ];
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const major = (m: number | null) => (m == null ? '' : (Number(m) / 100).toFixed(2));
      const lines = [headers.join(',')];
      for (const r of rows) {
        lines.push([
          r.reference, r.title, r.kind, r.structure ?? '', r.line_of_business ?? '', r.cedentName ?? '', r.brokerName ?? '',
          r.currency, r.inception ?? '', r.expiry ?? '', r.stage, r.risk_score ?? '', r.risk_band ?? '',
          major(r.est_premium_minor), major(r.target_premium_minor),
        ].map(esc).join(','));
      }
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="underwriting-pipeline.csv"');
      return lines.join('\n');
    });
  });

  // ---- Create --------------------------------------------------------------
  app.post('/api/underwriting/submissions', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'Invalid submission', details: parsed.error.flatten() }; }
    const b = parsed.data;
    const terms = { ...(b.terms ?? {}), ...(b.capacityUtilPct !== undefined ? { capacityUtilPct: b.capacityUtilPct } : {}) };
    // Check the model-specific terms against the catalog. A slip missing required
    // model terms is still accepted (submissions are captured incrementally) but
    // the gaps are returned so the underwriter can complete them before quoting.
    const termsCheck = validateTerms(b.structure, b.lineOfBusiness, terms);
    // Money in — major units on the wire, stored as integer minor units.
    const minor = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100));
    // Score up-front so a new submission already carries a risk read.
    const rs = riskScore({
      lossRatioPct: b.lossRatioPct, catExposed: b.catExposed, classHazard: b.classHazard,
      priorClaims: b.priorClaims, yearsWithCedent: b.yearsWithCedent, capacityUtilPct: b.capacityUtilPct,
    });
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'submission_reference', 'SUB');
      const { rows } = await db.query<{ id: string }>(
        `insert into submission
           (tenant_id, reference, title, kind, basis, structure, line_of_business,
            cedent_party_id, broker_party_id, currency, inception, expiry, territory,
            sum_insured_minor, attachment_minor, limit_minor, est_premium_minor,
            loss_ratio_pct, cat_exposed, class_hazard, prior_claims, years_with_cedent,
            risk_score, risk_band, stage, terms, created_by, assigned_to)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'SUBMISSION',$25,$26,$26)
         returning id`,
        [
          ctx.tenantId, ref, b.title, b.kind, b.basis ?? null, b.structure ?? null, b.lineOfBusiness ?? null,
          b.cedentPartyId ?? null, b.brokerPartyId ?? null, b.currency, b.inception ?? null, b.expiry ?? null, b.territory ?? null,
          minor(b.sumInsured), minor(b.attachment), minor(b.limit), minor(b.estPremium),
          b.lossRatioPct ?? null, b.catExposed ?? false, b.classHazard ?? null, b.priorClaims ?? null, b.yearsWithCedent ?? null,
          rs.score, rs.band, JSON.stringify(terms), ctx.userId,
        ],
      );
      const id = rows[0]!.id;
      await logActivity(db, ctx.tenantId, id, ctx.userId, 'CREATE', { toStage: 'SUBMISSION', note: `Risk score ${rs.score} (${rs.band})` });
      await writeAudit(db, ctx, { action: 'create', entityType: 'submission', entityId: id, after: { reference: ref, riskScore: rs.score } });
      reply.code(201);
      return { id, reference: ref, riskScore: rs.score, riskBand: rs.band, termsCheck };
    });
  });

  // ---- Detail (+ activity + score breakdown) -------------------------------
  app.get<{ Params: { id: string } }>('/api/underwriting/submissions/:id', { preHandler: requirePermission('treaty:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<Record<string, unknown> & {
        loss_ratio_pct: number | null; cat_exposed: boolean; class_hazard: number | null;
        prior_claims: number | null; years_with_cedent: number | null; terms: Record<string, unknown> | null;
      }>(
        `select s.*, ced.short_name as "cedentName", brk.short_name as "brokerName"
           from submission s
           left join party ced on ced.id = s.cedent_party_id
           left join party brk on brk.id = s.broker_party_id
          where s.id = $1`,
        [req.params.id],
      );
      const r = rows[0];
      if (!r) { reply.code(404); return { error: 'Submission not found' }; }
      const activity = await db.query(
        `select kind, from_stage as "fromStage", to_stage as "toStage", note, created_at as "createdAt"
           from submission_activity where submission_id = $1 order by created_at desc limit 50`,
        [req.params.id],
      );
      // Referral / approval history (the referral engine).
      const approvals = await db.query(
        `select id, level, reason, status, sla_due_at as "slaDueAt", decided_at as "decidedAt", note, created_at as "createdAt",
                (status = 'PENDING' and sla_due_at is not null and sla_due_at < now()) as "slaBreached"
           from submission_approval where submission_id = $1 order by created_at desc`,
        [req.params.id],
      );
      // What the authority matrix requires for this submission right now.
      const requirement = requiredApproval({ band: r.risk_band as RiskBand | null, limitMinor: (r.limit_minor as number | null) ?? (r.est_premium_minor as number | null) });
      // Live score breakdown so the detail view can explain the score.
      const breakdown = riskScore(factorsFromRow(r));
      return {
        id: r.id, reference: r.reference, title: r.title, kind: r.kind, basis: r.basis, structure: r.structure,
        lineOfBusiness: r.line_of_business, currency: r.currency, stage: r.stage,
        cedentName: r.cedentName, brokerName: r.brokerName,
        inception: r.inception, expiry: r.expiry, territory: r.territory,
        sumInsuredMinor: r.sum_insured_minor, attachmentMinor: r.attachment_minor, limitMinor: r.limit_minor,
        estPremiumMinor: r.est_premium_minor, targetPremiumMinor: r.target_premium_minor,
        lossRatioPct: r.loss_ratio_pct, catExposed: r.cat_exposed, classHazard: r.class_hazard,
        priorClaims: r.prior_claims, yearsWithCedent: r.years_with_cedent,
        riskScore: r.risk_score, riskBand: r.risk_band, scoreBreakdown: breakdown.contributions,
        terms: r.terms, activity: activity.rows,
        termsCheck: validateTerms(r.structure as string | null, r.line_of_business as string | null, r.terms),
        approvals: approvals.rows, approvalRequirement: requirement,
      };
    });
  });

  // ---- Stage transition (guarded by the domain stage machine + approval matrix)
  app.post<{ Params: { id: string } }>('/api/underwriting/submissions/:id/transition', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const to = (req.body as { to?: string })?.to as UwStage | undefined;
    const note = (req.body as { note?: string })?.note;
    if (!to) { reply.code(400); return { error: 'Target stage `to` is required' }; }
    const perms = req.auth?.permissions ?? [];
    const canApprove = perms.includes('underwriting:approve') || perms.includes('admin:manage');
    return runAs(ctx, async (db) => {
      const cur = await db.query<{ stage: UwStage; risk_band: string | null; limit_minor: number | null; est_premium_minor: number | null }>(
        `select stage, risk_band, limit_minor, est_premium_minor from submission where id = $1`, [req.params.id],
      );
      if (!cur.rows[0]) { reply.code(404); return { error: 'Submission not found' }; }
      const from = cur.rows[0].stage;
      if (isTerminalStage(from)) { reply.code(409); return { error: `Submission is ${from} and cannot move` }; }
      if (!canTransition(from, to)) { reply.code(409); return { error: `Illegal transition ${from} → ${to}` }; }
      // Approval matrix: quoting or binding a HIGH-risk or large-limit submission
      // requires senior/chief sign-off. An approver (underwriting:approve /
      // admin:manage) may proceed directly; a plain underwriter must first obtain
      // an APPROVED referral at or above the required level (maker/checker split).
      const gate = approvalRequired(to, cur.rows[0].risk_band, cur.rows[0].limit_minor);
      if (gate && !canApprove) {
        if (to === 'BOUND') {
          const need = requiredApproval({ band: cur.rows[0].risk_band as RiskBand | null, limitMinor: cur.rows[0].limit_minor ?? cur.rows[0].est_premium_minor });
          const approved = await db.query<{ level: ApprovalLevel }>(
            `select level from submission_approval where submission_id = $1 and status = 'APPROVED'`, [req.params.id],
          );
          const covered = approved.rows.some((a) => levelCovers(a.level, need.level));
          if (!covered) {
            reply.code(403);
            return { error: `Binding requires ${need.level.replace(/_/g, ' ')} sign-off (${need.reason}). Raise a referral and obtain approval first.` };
          }
        } else {
          reply.code(403);
          return { error: `${to} requires senior approval (${gate}). You do not hold underwriting:approve.` };
        }
      }
      await db.query(`update submission set stage = $2, updated_at = now() where id = $1`, [req.params.id, to]);
      await logActivity(db, ctx.tenantId, req.params.id, ctx.userId, to === 'REFERRAL' ? 'REFERRAL' : isTerminalStage(to) ? 'DECISION' : 'STAGE', { fromStage: from, toStage: to, note });
      await writeAudit(db, ctx, { action: 'transition', entityType: 'submission', entityId: req.params.id, before: { stage: from }, after: { stage: to } });
      return { id: req.params.id, from, to };
    });
  });

  // ---- Recompute risk score ------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/submissions/:id/score', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        loss_ratio_pct: number | null; cat_exposed: boolean; class_hazard: number | null;
        prior_claims: number | null; years_with_cedent: number | null; terms: Record<string, unknown> | null;
      }>(`select loss_ratio_pct, cat_exposed, class_hazard, prior_claims, years_with_cedent, terms from submission where id = $1`, [req.params.id]);
      const r = rows[0];
      if (!r) { reply.code(404); return { error: 'Submission not found' }; }
      const rs = riskScore(factorsFromRow(r));
      await db.query(`update submission set risk_score = $2, risk_band = $3, updated_at = now() where id = $1`, [req.params.id, rs.score, rs.band]);
      await logActivity(db, ctx.tenantId, req.params.id, ctx.userId, 'SCORE', { note: `Re-scored ${rs.score} (${rs.band})` });
      await writeAudit(db, ctx, { action: 'score', entityType: 'submission', entityId: req.params.id, after: { riskScore: rs.score } });
      return { id: req.params.id, riskScore: rs.score, riskBand: rs.band, breakdown: rs.contributions };
    });
  });

  // ---- Technical price ------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/submissions/:id/price', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ est_premium_minor: number | null; loss_ratio_pct: number | null; risk_score: number | null }>(
        `select est_premium_minor, loss_ratio_pct, risk_score from submission where id = $1`, [req.params.id],
      );
      const r = rows[0];
      if (!r) { reply.code(404); return { error: 'Submission not found' }; }
      // Expected loss = EPI × historical loss ratio (a first-cut burn cost).
      const epi = Number(r.est_premium_minor ?? 0);
      const expectedLoss = Math.round(epi * ((r.loss_ratio_pct ?? 60) / 100));
      const tp = technicalPremium({ expectedLossMinor: expectedLoss, riskScore: r.risk_score ?? 50 });
      await db.query(`update submission set target_premium_minor = $2, updated_at = now() where id = $1`, [req.params.id, tp.technicalPremiumMinor]);
      await logActivity(db, ctx.tenantId, req.params.id, ctx.userId, 'PRICE', { note: `Technical premium ${tp.technicalPremiumMinor} (implied LR ${tp.impliedLossRatioPct}%)` });
      await writeAudit(db, ctx, { action: 'price', entityType: 'submission', entityId: req.params.id, after: { targetPremiumMinor: tp.technicalPremiumMinor } });
      return { id: req.params.id, ...tp, expectedLossMinor: expectedLoss };
    });
  });

  // ---- Note ----------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/submissions/:id/note', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const note = (req.body as { note?: string })?.note?.trim();
    if (!note) { reply.code(400); return { error: 'note is required' }; }
    return runAs(ctx, async (db) => {
      const cur = await db.query(`select 1 from submission where id = $1`, [req.params.id]);
      if (!cur.rows[0]) { reply.code(404); return { error: 'Submission not found' }; }
      await logActivity(db, ctx.tenantId, req.params.id, ctx.userId, 'NOTE', { note });
      return { ok: true };
    });
  });

  // ---- Pricing scenarios & sensitivity (what-if) ---------------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/submissions/:id/scenarios', { preHandler: requirePermission('treaty:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const body = (req.body ?? {}) as { rateChanges?: number[]; lossShocks?: number[]; expenseRatio?: number };
    const rateChanges = Array.isArray(body.rateChanges) && body.rateChanges.length ? body.rateChanges : [-0.15, -0.05, 0, 0.05, 0.15, 0.25];
    const lossShocks = Array.isArray(body.lossShocks) && body.lossShocks.length ? body.lossShocks : [0.8, 0.9, 1, 1.1, 1.25, 1.5];
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ est_premium_minor: number | null; loss_ratio_pct: number | null; target_premium_minor: number | null }>(
        `select est_premium_minor, loss_ratio_pct, target_premium_minor from submission where id = $1`, [req.params.id],
      );
      const r = rows[0];
      if (!r) { reply.code(404); return { error: 'Submission not found' }; }
      const basePremium = Number(r.target_premium_minor ?? r.est_premium_minor ?? 0);
      const expectedLoss = Math.round(Number(r.est_premium_minor ?? 0) * ((r.loss_ratio_pct ?? 60) / 100));
      const expenseRatio = body.expenseRatio ?? 0.15;
      return {
        basePremiumMinor: basePremium,
        expectedLossMinor: expectedLoss,
        base: ratios({ premiumMinor: basePremium, expectedLossMinor: expectedLoss, expenseRatio }),
        grid: scenarioGrid({ basePremiumMinor: basePremium, expectedLossMinor: expectedLoss, expenseRatio, rateChanges, lossShocks }),
        sensitivity: sensitivity({ basePremiumMinor: basePremium, expectedLossMinor: expectedLoss, expenseRatio, rateChanges, lossShocks }),
        rateChanges, lossShocks,
      };
    });
  });

  // ---- Data room: register a document (runs extraction) --------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/submissions/:id/documents', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const b = (req.body ?? {}) as { name?: string; kind?: string; mime?: string; sizeBytes?: number; storageRef?: string };
    const name = b.name?.trim();
    if (!name) { reply.code(400); return { error: 'Document name is required' }; }
    const kind = (b.kind as DocumentKind) || inferKind(name);
    const extraction = extractDocument(kind, name);
    return runAs(ctx, async (db) => {
      const cur = await db.query(`select 1 from submission where id = $1`, [req.params.id]);
      if (!cur.rows[0]) { reply.code(404); return { error: 'Submission not found' }; }
      const ins = await db.query<{ id: string }>(
        `insert into submission_document (tenant_id, submission_id, name, kind, version, mime, size_bytes, storage_ref, status, extraction, uploaded_by)
         values ($1,$2,$3,$4,1,$5,$6,$7,'EXTRACTED',$8,$9) returning id`,
        [ctx.tenantId, req.params.id, name, kind, b.mime ?? null, b.sizeBytes ?? null, b.storageRef ?? null, JSON.stringify(extraction), ctx.userId],
      );
      await logActivity(db, ctx.tenantId, req.params.id, ctx.userId, 'DOCUMENT', { note: `Added ${kind} “${name}” (extraction ${Math.round(extraction.confidence * 100)}%)` });
      await writeAudit(db, ctx, { action: 'document_add', entityType: 'submission', entityId: req.params.id, after: { document: name, kind } });
      return { id: ins.rows[0]!.id, kind, extraction };
    });
  });

  // ---- Data room: list documents (current versions first) ------------------
  app.get<{ Params: { id: string } }>('/api/underwriting/submissions/:id/documents', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select d.id, d.name, d.kind, d.version, d.mime, d.size_bytes as "sizeBytes", d.status,
                d.extraction, d.supersedes_id as "supersedesId", d.signature, d.signed_at as "signedAt",
                d.created_at as "createdAt", u.display_name as "uploadedBy"
           from submission_document d
           left join app_user u on u.id = d.uploaded_by
          where d.submission_id = $1
          order by d.created_at desc`,
        [req.params.id],
      );
      return { documents: rows };
    });
  });

  // ---- Data room: supersede with a new version -----------------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/documents/:id/supersede', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const b = (req.body ?? {}) as { name?: string; storageRef?: string };
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ submission_id: string; name: string; kind: DocumentKind; version: number }>(
        `select submission_id, name, kind, version from submission_document where id = $1`, [req.params.id],
      );
      const old = rows[0];
      if (!old) { reply.code(404); return { error: 'Document not found' }; }
      const name = b.name?.trim() || old.name;
      const version = nextVersion(old.version);
      const extraction = extractDocument(old.kind, name);
      await db.query(`update submission_document set status = 'SUPERSEDED' where id = $1`, [req.params.id]);
      const ins = await db.query<{ id: string }>(
        `insert into submission_document (tenant_id, submission_id, name, kind, version, status, extraction, supersedes_id, storage_ref, uploaded_by)
         values ($1,$2,$3,$4,$5,'EXTRACTED',$6,$7,$8,$9) returning id`,
        [ctx.tenantId, old.submission_id, name, old.kind, version, JSON.stringify(extraction), req.params.id, b.storageRef ?? null, ctx.userId],
      );
      await logActivity(db, ctx.tenantId, old.submission_id, ctx.userId, 'DOCUMENT', { note: `Superseded ${old.kind} “${name}” → v${version}` });
      return { id: ins.rows[0]!.id, version, supersedesId: req.params.id };
    });
  });

  // ---- Data room: sign / seal a document -----------------------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/documents/:id/sign', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ submission_id: string; name: string; version: number; status: string }>(
        `select submission_id, name, version, status from submission_document where id = $1`, [req.params.id],
      );
      const d = rows[0];
      if (!d) { reply.code(404); return { error: 'Document not found' }; }
      if (d.status === 'SUPERSEDED') { reply.code(409); return { error: 'Cannot sign a superseded document' }; }
      const digest = signatureDigest([d.submission_id, d.name, d.version, ctx.userId]);
      await db.query(
        `update submission_document set status = 'SIGNED', signature = $2, signed_by = $3, signed_at = now() where id = $1`,
        [req.params.id, digest, ctx.userId],
      );
      await logActivity(db, ctx.tenantId, d.submission_id, ctx.userId, 'DOCUMENT', { note: `Signed “${d.name}” v${d.version} (${digest})` });
      await writeAudit(db, ctx, { action: 'document_sign', entityType: 'submission', entityId: d.submission_id, after: { document: d.name, signature: digest } });
      return { id: req.params.id, signature: digest, status: 'SIGNED' };
    });
  });

  // ---- Underwriting advisor (deterministic decision support) ---------------
  // Clause recommendations, missing-info detection, consistency flags, an
  // executive summary and similar-risk benchmarking from the book. No LLM.
  app.get<{ Params: { id: string } }>('/api/underwriting/submissions/:id/advisor', { preHandler: requirePermission('treaty:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<Record<string, unknown>>(
        `select s.*, ced.short_name as "cedentName"
           from submission s left join party ced on ced.id = s.cedent_party_id
          where s.id = $1`, [req.params.id],
      );
      const r = rows[0];
      if (!r) { reply.code(404); return { error: 'Submission not found' }; }
      const input: AdvisorInput = {
        title: r.title as string, kind: r.kind as string, structure: r.structure as string | null,
        lineOfBusiness: r.line_of_business as string | null, currency: r.currency as string,
        cedentName: r.cedentName as string | null, territory: r.territory as string | null,
        inception: r.inception as string | null, expiry: r.expiry as string | null,
        sumInsuredMinor: r.sum_insured_minor as number | null, limitMinor: r.limit_minor as number | null,
        attachmentMinor: r.attachment_minor as number | null, estPremiumMinor: r.est_premium_minor as number | null,
        targetPremiumMinor: r.target_premium_minor as number | null, lossRatioPct: r.loss_ratio_pct as number | null,
        catExposed: r.cat_exposed as boolean | null, priorClaims: r.prior_claims as number | null,
        yearsWithCedent: r.years_with_cedent as number | null, riskScore: r.risk_score as number | null,
        riskBand: r.risk_band as string | null, terms: r.terms as Record<string, unknown> | null,
      };

      // Similar risks: other submissions sharing the structure or line, most
      // comparable first (same structure + line ranks highest), priced ones only.
      const similar = await db.query(
        `select s.id, s.reference, s.title, s.structure, s.line_of_business as "lineOfBusiness",
                s.stage, s.currency, s.risk_score as "riskScore", s.risk_band as "riskBand",
                s.loss_ratio_pct as "lossRatioPct", s.est_premium_minor as "estPremiumMinor",
                s.target_premium_minor as "targetPremiumMinor",
                (case when s.structure is not distinct from $2 then 2 else 0 end)
              + (case when s.line_of_business is not distinct from $3 then 1 else 0 end) as match
           from submission s
          where s.id <> $1
            and (s.structure is not distinct from $2 or s.line_of_business is not distinct from $3)
          order by match desc, s.created_at desc
          limit 5`,
        [req.params.id, r.structure ?? null, r.line_of_business ?? null],
      );

      return {
        clauses: recommendedClauses(input.structure, input.lineOfBusiness),
        missingInfo: missingInformation(input),
        flags: attentionFlags(input),
        executiveSummary: executiveSummary(input),
        similar: similar.rows,
      };
    });
  });

  // ---- Raise an approval referral ------------------------------------------
  // Evaluates the authority matrix for the submission and, if it exceeds
  // delegated authority, opens a PENDING referral at the required level with its
  // SLA. Idempotent: an open referral at that level is returned rather than duped.
  app.post<{ Params: { id: string } }>('/api/underwriting/submissions/:id/approvals', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ risk_band: string | null; limit_minor: number | null; est_premium_minor: number | null }>(
        `select risk_band, limit_minor, est_premium_minor from submission where id = $1`, [req.params.id],
      );
      const s = rows[0];
      if (!s) { reply.code(404); return { error: 'Submission not found' }; }
      const need = requiredApproval({ band: s.risk_band as RiskBand | null, limitMinor: s.limit_minor ?? s.est_premium_minor });
      if (!need.referralRequired) return { referralRequired: false, level: need.level, reason: need.reason };
      // Reuse an existing open referral at this level.
      const existing = await db.query<{ id: string }>(
        `select id from submission_approval where submission_id = $1 and level = $2 and status = 'PENDING'`, [req.params.id, need.level],
      );
      if (existing.rows[0]) return { referralRequired: true, level: need.level, reason: need.reason, slaHours: need.slaHours, approvalId: existing.rows[0].id, alreadyOpen: true };
      const ins = await db.query<{ id: string; sla_due_at: string }>(
        `insert into submission_approval (tenant_id, submission_id, level, reason, sla_due_at, requested_by)
         values ($1,$2,$3,$4, now() + ($5 || ' hours')::interval, $6)
         returning id, sla_due_at`,
        [ctx.tenantId, req.params.id, need.level, need.reason, String(need.slaHours), ctx.userId],
      );
      await logActivity(db, ctx.tenantId, req.params.id, ctx.userId, 'REFERRAL', { note: `Referred to ${need.level.replace(/_/g, ' ')} — ${need.reason} (SLA ${need.slaHours}h)` });
      await writeAudit(db, ctx, { action: 'refer', entityType: 'submission', entityId: req.params.id, after: { level: need.level, reason: need.reason } });
      return { referralRequired: true, level: need.level, reason: need.reason, slaHours: need.slaHours, approvalId: ins.rows[0]!.id, slaDueAt: ins.rows[0]!.sla_due_at };
    });
  });

  // ---- Approver queue ------------------------------------------------------
  app.get('/api/underwriting/approvals', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    const status = (req.query as { status?: string }).status ?? 'PENDING';
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select a.id, a.submission_id as "submissionId", a.level, a.reason, a.status,
                a.sla_due_at as "slaDueAt", a.created_at as "createdAt",
                a.decided_at as "decidedAt", a.note,
                (a.status = 'PENDING' and a.sla_due_at is not null and a.sla_due_at < now()) as "slaBreached",
                s.reference, s.title, s.currency, s.risk_score as "riskScore", s.risk_band as "riskBand",
                s.limit_minor as "limitMinor", s.est_premium_minor as "estPremiumMinor",
                ced.short_name as "cedentName"
           from submission_approval a
           join submission s on s.id = a.submission_id
           left join party ced on ced.id = s.cedent_party_id
          where ($1::text = 'ALL' or a.status = $1)
          order by (a.sla_due_at is not null and a.sla_due_at < now()) desc, a.sla_due_at asc nulls last, a.created_at desc`,
        [status],
      );
      return { approvals: rows };
    });
  });

  // ---- Decide an approval (approve / reject) -------------------------------
  // The decider must hold the authority for the referral's level (senior/chief/
  // committee all exercise underwriting:approve; admin:manage overrides).
  app.post<{ Params: { id: string } }>('/api/underwriting/approvals/:id/decision', { preHandler: requirePermission('treaty:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const body = (req.body ?? {}) as { decision?: string; note?: string };
    const decision = body.decision;
    if (decision !== 'APPROVED' && decision !== 'REJECTED') { reply.code(400); return { error: "decision must be 'APPROVED' or 'REJECTED'" }; }
    const perms = req.auth?.permissions ?? [];
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ submission_id: string; level: ApprovalLevel; status: string }>(
        `select submission_id, level, status from submission_approval where id = $1`, [req.params.id],
      );
      const a = rows[0];
      if (!a) { reply.code(404); return { error: 'Approval not found' }; }
      if (a.status !== 'PENDING') { reply.code(409); return { error: `Approval already ${a.status}` }; }
      const holds = perms.includes(LEVEL_PERMISSION[a.level]) || perms.includes('admin:manage');
      if (!holds) { reply.code(403); return { error: `You are not authorised to sign off at ${a.level.replace(/_/g, ' ')} level.` }; }
      await db.query(
        `update submission_approval set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1`,
        [req.params.id, decision, ctx.userId, body.note ?? null],
      );
      await logActivity(db, ctx.tenantId, a.submission_id, ctx.userId, 'DECISION', { note: `${a.level.replace(/_/g, ' ')} ${decision.toLowerCase()}${body.note ? ' — ' + body.note : ''}` });
      await writeAudit(db, ctx, { action: 'approval_decision', entityType: 'submission', entityId: a.submission_id, after: { level: a.level, decision } });
      return { id: req.params.id, status: decision, submissionId: a.submission_id };
    });
  });
}
