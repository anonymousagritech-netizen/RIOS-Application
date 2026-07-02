/**
 * Governed reserving workflow (industry gap analysis Tier-3 #13).
 *
 * Triangles -> IBNR recommendation -> management approval -> GL booking, plus
 * actual-vs-expected (AvE) monitoring. The actuarial engine is @rios/domain
 * (volume-weighted chain-ladder: developmentFactors + projectUltimate) - the
 * server only orchestrates, snapshots the input triangle and persists integer
 * minor units. Approval is maker/checker (the creator cannot approve their own
 * study, same segregation-of-duties rule as cash calls) and booking posts a
 * balanced double-entry journal through the existing journal/ledger_posting
 * path: DR 5100 Claims / Loss Expense, CR 2100 Reinsurance Creditors (Control)
 * - the seed chart's loss-expense and liability accounts. Every state change is
 * audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  developmentFactors, projectUltimate, actualVsExpected, fromMajor,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

// GL accounts for the IBNR provision, from the seeded chart of accounts (same
// vocabulary as the technical-accounting POSTING_RULES in accounting.ts).
const IBNR_EXPENSE_ACCOUNT = '5100';   // Claims / Loss Expense
const IBNR_LIABILITY_ACCOUNT = '2100'; // Reinsurance Creditors (Control)

const createSchema = z.object({
  name: z.string().min(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lob: z.string().optional(),
  currency: z.string().length(3),
  // Cumulative loss triangle in MAJOR units: triangle[i] = origin period i's
  // cumulative amounts by development age (ragged - later origins have fewer ages).
  triangle: z.array(z.array(z.number().nonnegative()).min(1)).min(1),
});

const rejectSchema = z.object({ reason: z.string().min(1) });

const aveSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actual: z.number(),     // MAJOR units: actual emergence observed in the period
  note: z.string().optional(),
});

interface StudyRow {
  id: string;
  name: string;
  as_of: string;
  lob: string | null;
  method: string;
  recommendation_minor: number;
  currency: string;
  rationale: string | null;
  status: string;
  rejection_reason: string | null;
  created_by: string | null;
  recommended_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  booked_at: string | null;
  journal_id: string | null;
  created_at: string;
}

const STUDY_COLUMNS = `id, name, to_char(as_of,'YYYY-MM-DD') as as_of, lob, method,
       recommendation_minor, currency, rationale, status, rejection_reason,
       created_by, recommended_by, approved_by, approved_at, booked_at, journal_id, created_at`;

async function loadStudy(db: Db, id: string): Promise<StudyRow | null> {
  const { rows } = await db.query<StudyRow>(
    `select ${STUDY_COLUMNS} from ibnr_study where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function studyJson(s: StudyRow) {
  return {
    id: s.id,
    name: s.name,
    asOf: s.as_of,
    lob: s.lob,
    method: s.method,
    recommendationMinor: Number(s.recommendation_minor),
    currency: s.currency,
    rationale: s.rationale,
    status: s.status,
    rejectionReason: s.rejection_reason,
    createdBy: s.created_by,
    recommendedBy: s.recommended_by,
    approvedBy: s.approved_by,
    approvedAt: s.approved_at,
    bookedAt: s.booked_at,
    journalId: s.journal_id,
    createdAt: s.created_at,
  };
}

export async function reservingWorkflowModule(app: FastifyInstance): Promise<void> {
  // Create a study: run the domain chain-ladder engine on the triangle and store
  // the recommendation. The study lands directly in RECOMMENDED - the engine's
  // output IS the actuarial recommendation, awaiting management approval.
  app.post(
    '/api/reserving/studies',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid reserving study', details: parsed.error.flatten() };
      }
      const b = parsed.data;

      // Snapshot the triangle in integer minor units, then run the tested engine.
      const triangleMinor = b.triangle.map((row) => row.map((v) => fromMajor(v, b.currency).amount));
      const factors = developmentFactors(triangleMinor);
      const projection = projectUltimate(triangleMinor, factors);
      const method = 'CHAIN_LADDER';
      const rationale =
        `Volume-weighted chain-ladder on a ${triangleMinor.length}-origin cumulative triangle as of ${b.asOf}. ` +
        `Age-to-age development factors: [${factors.join(', ')}]. ` +
        `Latest observed ${projection.latestMinor} ${b.currency.toUpperCase()} (minor units); ` +
        `projected ultimate ${projection.totalUltimateMinor}; recommended IBNR ${projection.ibnrMinor}.`;

      return runAs(ctx, async (db) => {
        const { rows } = await db.query<StudyRow>(
          `insert into ibnr_study
             (tenant_id, name, as_of, lob, method, triangle, recommendation_minor, currency, rationale,
              status, created_by, recommended_by)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'RECOMMENDED',$10,$10)
           returning ${STUDY_COLUMNS}`,
          [
            ctx.tenantId, b.name, b.asOf, b.lob ?? null, method, JSON.stringify(triangleMinor),
            projection.ibnrMinor, b.currency.toUpperCase(), rationale, ctx.userId,
          ],
        );
        const study = rows[0]!;

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'ibnr_study',
          entityId: study.id,
          after: { name: b.name, asOf: b.asOf, method, recommendationMinor: projection.ibnrMinor, status: 'RECOMMENDED' },
          actorLabel: req.auth?.displayName,
        });

        reply.code(201);
        return {
          ...studyJson(study),
          developmentFactors: factors,
          latestMinor: projection.latestMinor,
          ultimateMinor: projection.totalUltimateMinor,
          ultimates: projection.ultimates,
        };
      });
    },
  );

  // Approve (maker/checker: the approver must not be the study's creator).
  app.post<{ Params: { id: string } }>(
    '/api/reserving/studies/:id/approve',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const study = await loadStudy(db, req.params.id);
        if (!study) { reply.code(404); return { error: 'Study not found' }; }
        if (study.status !== 'RECOMMENDED') {
          reply.code(409);
          return { error: `Study is ${study.status}; only a RECOMMENDED study can be approved` };
        }
        if (study.created_by && study.created_by === ctx.userId) {
          reply.code(403);
          return { error: 'Segregation of duties: the creator cannot approve their own reserve study' };
        }
        const updated = await db.query<StudyRow>(
          `update ibnr_study set status = 'APPROVED', approved_by = $2, approved_at = now()
            where id = $1 returning ${STUDY_COLUMNS}`,
          [req.params.id, ctx.userId],
        );
        await writeAudit(db, ctx, {
          action: 'approve', entityType: 'ibnr_study', entityId: req.params.id,
          before: { status: 'RECOMMENDED' }, after: { status: 'APPROVED' },
          actorLabel: req.auth?.displayName,
        });
        return studyJson(updated.rows[0]!);
      });
    },
  );

  // Reject a recommendation, with the management reason on the record.
  app.post<{ Params: { id: string } }>(
    '/api/reserving/studies/:id/reject',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = rejectSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'A rejection reason is required', details: parsed.error.flatten() };
      }
      return runAs(ctx, async (db) => {
        const study = await loadStudy(db, req.params.id);
        if (!study) { reply.code(404); return { error: 'Study not found' }; }
        if (study.status !== 'RECOMMENDED') {
          reply.code(409);
          return { error: `Study is ${study.status}; only a RECOMMENDED study can be rejected` };
        }
        const updated = await db.query<StudyRow>(
          `update ibnr_study set status = 'REJECTED', rejection_reason = $2
            where id = $1 returning ${STUDY_COLUMNS}`,
          [req.params.id, parsed.data.reason],
        );
        await writeAudit(db, ctx, {
          action: 'reject', entityType: 'ibnr_study', entityId: req.params.id,
          before: { status: 'RECOMMENDED' }, after: { status: 'REJECTED', reason: parsed.data.reason },
          actorLabel: req.auth?.displayName,
        });
        return studyJson(updated.rows[0]!);
      });
    },
  );

  // Book the approved recommendation to the GL as a balanced journal
  // (DR loss expense / CR liability) - the same journal + ledger_posting path
  // technical accounting uses, so the trial balance stays self-balancing.
  app.post<{ Params: { id: string } }>(
    '/api/reserving/studies/:id/book',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const study = await loadStudy(db, req.params.id);
        if (!study) { reply.code(404); return { error: 'Study not found' }; }
        if (study.status !== 'APPROVED') {
          reply.code(409);
          return { error: `Study is ${study.status}; only an APPROVED study can be booked` };
        }

        const accounts = await db.query<{ code: string; id: string }>(
          `select code, id from gl_account where code = any($1::citext[])`,
          [[IBNR_EXPENSE_ACCOUNT, IBNR_LIABILITY_ACCOUNT]],
        );
        const byCode = new Map(accounts.rows.map((r) => [String(r.code), r.id]));
        const drAcc = byCode.get(IBNR_EXPENSE_ACCOUNT);
        const crAcc = byCode.get(IBNR_LIABILITY_ACCOUNT);
        if (!drAcc || !crAcc) {
          reply.code(409);
          return { error: `GL accounts ${IBNR_EXPENSE_ACCOUNT}/${IBNR_LIABILITY_ACCOUNT} are not configured in the chart of accounts` };
        }

        const amount = Number(study.recommendation_minor);
        const journal = await db.query<{ id: string }>(
          `insert into journal (tenant_id, reference, description, currency, source, created_by)
           values ($1, $2, $3, $4, 'reserving', $5) returning id`,
          [ctx.tenantId, `IBNR-${study.id.slice(0, 8)}`, `IBNR reserve booking for study "${study.name}" as of ${study.as_of}`, study.currency, ctx.userId],
        );
        const journalId = journal.rows[0]!.id;
        const narrative = `IBNR_RESERVE ${study.name}`;
        await db.query(
          `insert into ledger_posting (tenant_id, journal_id, gl_account_id, debit_minor, credit_minor, currency, narrative)
           values ($1,$2,$3,$4,0,$5,$6), ($1,$2,$7,0,$4,$5,$6)`,
          [ctx.tenantId, journalId, drAcc, amount, study.currency, narrative, crAcc],
        );

        const updated = await db.query<StudyRow>(
          `update ibnr_study set status = 'BOOKED', booked_at = now(), journal_id = $2
            where id = $1 returning ${STUDY_COLUMNS}`,
          [req.params.id, journalId],
        );

        await writeAudit(db, ctx, {
          action: 'post',
          entityType: 'ibnr_study',
          entityId: req.params.id,
          before: { status: 'APPROVED' },
          after: { status: 'BOOKED', journalId, amountMinor: amount, drAccount: IBNR_EXPENSE_ACCOUNT, crAccount: IBNR_LIABILITY_ACCOUNT },
          actorLabel: req.auth?.displayName,
        });

        return {
          ...studyJson(updated.rows[0]!),
          journalId,
          postings: [
            { account: IBNR_EXPENSE_ACCOUNT, debitMinor: amount, creditMinor: 0 },
            { account: IBNR_LIABILITY_ACCOUNT, debitMinor: 0, creditMinor: amount },
          ],
        };
      });
    },
  );

  // List studies.
  app.get(
    '/api/reserving/studies',
    { preHandler: requirePermission('accounting:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<StudyRow>(
          `select ${STUDY_COLUMNS} from ibnr_study order by created_at desc`,
        );
        return { studies: rows.map(studyJson) };
      });
    },
  );

  // Study detail: triangle snapshot, AvE rows and the cumulative deviation
  // (computed by the pure domain helper, never in SQL or floats).
  app.get<{ Params: { id: string } }>(
    '/api/reserving/studies/:id',
    { preHandler: requirePermission('accounting:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const study = await loadStudy(db, req.params.id);
        if (!study) { reply.code(404); return { error: 'Study not found' }; }
        const tri = await db.query<{ triangle: number[][] }>(
          `select triangle from ibnr_study where id = $1`,
          [req.params.id],
        );
        const ave = await db.query<{
          id: string; period: string; expected_minor: number; actual_minor: number; currency: string;
          note: string | null; created_at: string;
        }>(
          `select id, to_char(period,'YYYY-MM-DD') as period, expected_minor, actual_minor, currency, note, created_at
             from ibnr_ave where study_id = $1 order by period, created_at`,
          [req.params.id],
        );
        const summary = actualVsExpected(
          Number(study.recommendation_minor),
          ave.rows.map((r) => Number(r.actual_minor)),
        );
        return {
          ...studyJson(study),
          triangleMinor: tri.rows[0]?.triangle ?? [],
          ave: ave.rows.map((r) => ({
            id: r.id,
            period: r.period,
            expectedMinor: Number(r.expected_minor),
            actualMinor: Number(r.actual_minor),
            currency: r.currency,
            note: r.note,
            createdAt: r.created_at,
          })),
          aveSummary: {
            periods: summary.periods,
            cumulativeActualMinor: summary.cumulativeActualMinor,
            expectedMinor: summary.expectedMinor,
            cumulativeDeviationMinor: summary.cumulativeDeviationMinor,
            deviationPct: summary.deviationPct,
          },
        };
      });
    },
  );

  // Record an actual-vs-expected observation for a monitoring period. The row
  // snapshots the study's expected IBNR at recording time so later re-studies
  // never rewrite history.
  app.post<{ Params: { id: string } }>(
    '/api/reserving/studies/:id/ave',
    { preHandler: requirePermission('accounting:post') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = aveSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid AvE observation', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const study = await loadStudy(db, req.params.id);
        if (!study) { reply.code(404); return { error: 'Study not found' }; }
        if (study.status === 'REJECTED') {
          reply.code(409);
          return { error: 'Study is REJECTED; a rejected study is not monitored' };
        }
        const actual = fromMajor(b.actual, study.currency);
        const { rows } = await db.query<{ id: string }>(
          `insert into ibnr_ave (tenant_id, study_id, period, expected_minor, actual_minor, currency, note)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [ctx.tenantId, study.id, b.period, Number(study.recommendation_minor), actual.amount, study.currency, b.note ?? null],
        );
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'ibnr_ave',
          entityId: rows[0]!.id,
          after: { studyId: study.id, period: b.period, actualMinor: actual.amount, expectedMinor: Number(study.recommendation_minor) },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return {
          id: rows[0]!.id,
          studyId: study.id,
          period: b.period,
          expectedMinor: Number(study.recommendation_minor),
          actualMinor: actual.amount,
          currency: study.currency,
          note: b.note ?? null,
        };
      });
    },
  );
}
