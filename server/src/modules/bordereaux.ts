/**
 * Bordereaux ingestion module (brief §7.10, §9.6, §29.6).
 *
 * Mapped, validated ingestion of premium and loss bordereaux. Each uploaded file
 * is validated line-by-line; a malformed bordereau is rejected with line-level
 * errors, while a fully-valid one converts to reconciling Financial Events
 * (premium) or feeds Claims (loss) on processing - the §29.6 acceptance contract.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ingestBordereau, type BordereauMapping } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const createMappingSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['PREMIUM', 'LOSS']),
  mapping: z.record(z.unknown()).default({}),
});

const uploadSchema = z.object({
  contractId: z.string().uuid().optional(),
  programmeId: z.string().uuid().optional(),
  kind: z.enum(['PREMIUM', 'LOSS']),
  currency: z.string().length(3),
  mappingId: z.string().uuid().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  // Optional declared header total (major units): the line sum must tie out to it.
  controlTotalMajor: z.number().positive().optional(),
  rows: z.array(z.record(z.unknown())).default([]),
});

export async function bordereauxModule(app: FastifyInstance): Promise<void> {
  app.post('/api/bordereaux/mappings', { preHandler: requirePermission('bordereaux:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createMappingSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid mapping', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into bordereau_mapping (tenant_id, name, kind, mapping)
         values ($1,$2,$3,$4) returning id`,
        [ctx.tenantId, b.name, b.kind, JSON.stringify(b.mapping)],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'bordereau_mapping',
        entityId: id,
        after: { name: b.name, kind: b.kind },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, name: b.name, kind: b.kind };
    });
  });

  app.get('/api/bordereaux/mappings', { preHandler: requirePermission('bordereaux:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, kind, mapping, created_at as "createdAt"
           from bordereau_mapping order by created_at desc`,
      );
      return { mappings: rows };
    });
  });

  // Upload a bordereau: insert header + lines, validate each line, and set the
  // header status to VALIDATED (no errors) or REJECTED (one or more errors).
  app.post('/api/bordereaux', { preHandler: requirePermission('bordereaux:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid bordereau', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const ccy = b.currency.toUpperCase();
    return runAs(ctx, async (db) => {
      // Load a stored column mapping when referenced, so arbitrary source headers
      // are projected onto canonical fields before validation.
      let mapping: BordereauMapping | undefined;
      if (b.mappingId) {
        const m = await db.query<{ mapping: unknown }>(
          `select mapping from bordereau_mapping where id = $1`,
          [b.mappingId],
        );
        if (m.rows[0] && m.rows[0].mapping && typeof m.rows[0].mapping === 'object') {
          mapping = m.rows[0].mapping as BordereauMapping;
        }
      }

      const result = ingestBordereau({
        kind: b.kind,
        currency: ccy,
        rows: b.rows,
        mapping,
        controlTotalMajor: b.controlTotalMajor,
      });
      const lines = result.rows;
      const errorCount = result.invalidCount;
      const totalMinor = result.totalMinor;
      // A file is VALIDATED only when every line is valid AND it ties out to any
      // declared control total; otherwise it is REJECTED.
      const status = result.accepted ? 'VALIDATED' : 'REJECTED';
      const ref = await nextReference(db, ctx.tenantId, 'bordereau_reference', 'BDX');

      const { rows } = await db.query<{ id: string }>(
        `insert into bordereau
           (tenant_id, contract_id, programme_id, mapping_id, kind, reference, period_start, period_end,
            currency, status, row_count, error_count, total_minor, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [
          ctx.tenantId, b.contractId ?? null, b.programmeId ?? null, b.mappingId ?? null, b.kind, ref,
          b.periodStart ?? null, b.periodEnd ?? null, ccy, status, lines.length, errorCount, totalMinor, ctx.userId,
        ],
      );
      const id = rows[0]!.id;

      for (const l of lines) {
        await db.query(
          `insert into bordereau_line
             (tenant_id, bordereau_id, line_no, raw, mapped, amount_minor, currency, is_valid, errors)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            ctx.tenantId, id, l.lineNo, JSON.stringify(l.raw), JSON.stringify(l.fields),
            l.amountMinor, ccy, l.isValid, JSON.stringify(l.errors),
          ],
        );
      }

      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'bordereau',
        entityId: id,
        after: { kind: b.kind, rowCount: lines.length, errorCount, status, reconciles: result.reconciles },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return {
        id,
        status,
        rowCount: lines.length,
        errorCount,
        totalMinor,
        reconciles: result.reconciles,
        varianceMinor: result.varianceMinor,
      };
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/bordereaux/:id',
    { preHandler: requirePermission('bordereaux:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, contract_id as "contractId", programme_id as "programmeId", mapping_id as "mappingId",
                  kind, reference, period_start as "periodStart", period_end as "periodEnd", currency, status,
                  row_count as "rowCount", error_count as "errorCount", total_minor as "totalMinor",
                  processed_at as "processedAt", created_at as "createdAt"
             from bordereau where id = $1`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Bordereau not found' };
        }
        const lines = await db.query(
          `select id, line_no as "lineNo", raw, mapped, amount_minor as "amountMinor", currency,
                  is_valid as "isValid", errors, financial_event_id as "financialEventId", claim_id as "claimId"
             from bordereau_line where bordereau_id = $1 order by line_no`,
          [req.params.id],
        );
        return { ...rows[0], lines: lines.rows };
      });
    },
  );

  // Process a validated bordereau: premium -> Financial Events, loss -> Claims.
  app.post<{ Params: { id: string } }>(
    '/api/bordereaux/:id/process',
    { preHandler: requirePermission('bordereaux:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const head = await db.query<{
          id: string;
          contract_id: string | null;
          kind: 'PREMIUM' | 'LOSS';
          currency: string;
          status: string;
          error_count: number;
        }>(
          `select id, contract_id, kind, currency, status, error_count
             from bordereau where id = $1`,
          [req.params.id],
        );
        if (!head.rows[0]) {
          reply.code(404);
          return { error: 'Bordereau not found' };
        }
        const h = head.rows[0];
        if (h.status !== 'VALIDATED' || h.error_count !== 0) {
          reply.code(409);
          return { error: `malformed bordereau rejected with ${h.error_count} line-level errors` };
        }

        const validLines = await db.query<{ id: string; amount_minor: number }>(
          `select id, amount_minor from bordereau_line
            where bordereau_id = $1 and is_valid order by line_no`,
          [h.id],
        );

        let financialEvents = 0;
        let claims = 0;
        for (const line of validLines.rows) {
          if (h.kind === 'PREMIUM') {
            const fe = await db.query<{ id: string }>(
              `insert into financial_event
                 (tenant_id, contract_id, event_type, direction, amount_minor, currency, narrative, created_by)
               values ($1,$2,'INSTALMENT_PREMIUM','DR',$3,$4,$5,$6) returning id`,
              [ctx.tenantId, h.contract_id, line.amount_minor, h.currency, 'Bordereau instalment premium', ctx.userId],
            );
            await db.query(`update bordereau_line set financial_event_id = $1 where id = $2`, [fe.rows[0]!.id, line.id]);
            financialEvents += 1;
          } else {
            const cref = await nextReference(db, ctx.tenantId, 'claim_reference', 'CLM');
            const cl = await db.query<{ id: string }>(
              `insert into claim
                 (tenant_id, reference, contract_id, currency, gross_loss_minor, outstanding_minor, status, created_by)
               values ($1,$2,$3,$4,$5,$5,'NOTIFIED',$6) returning id`,
              [ctx.tenantId, cref, h.contract_id, h.currency, line.amount_minor, ctx.userId],
            );
            await db.query(`update bordereau_line set claim_id = $1 where id = $2`, [cl.rows[0]!.id, line.id]);
            claims += 1;
          }
        }

        await db.query(`update bordereau set status = 'PROCESSED', processed_at = now() where id = $1`, [h.id]);
        await writeAudit(db, ctx, {
          action: 'process',
          entityType: 'bordereau',
          entityId: h.id,
          after: { kind: h.kind, financialEvents, claims },
          actorLabel: req.auth?.displayName,
        });
        return { id: h.id, status: 'PROCESSED', financialEvents, claims };
      });
    },
  );
}
