/**
 * Placement / Slip module (brief §7.3 steps 3–5, §29.4).
 *
 * Markets the risk on a slip, captures written market lines (which may
 * oversubscribe the order), then signs down to the order - the final signed
 * shares flow into participations without re-keying (§29.4 acceptance).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { nextReference } from './parties.js';

const createSlipSchema = z.object({
  contractId: z.string().uuid(),
  umr: z.string().optional(),
  orderPct: z.number().positive().default(1.0),
});

const addLineSchema = z.object({
  partyId: z.string().uuid(),
  layerId: z.string().uuid().optional(),
  writtenLine: z.number().min(0).max(1),
});

// Tolerance for float noise when comparing the signed total against the order.
const SIGN_EPSILON = 1e-6;
// signed_line is numeric(9,6) in the DB, so each stored line can be off by up to
// 5e-7 from the computed share; the reconciliation view tolerates that per line.
const FULLY_SIGNED_EPSILON = 1e-4;

// Body of POST /slips/:id/sign - either explicit per-line signed shares, or
// classic proportional signing down of an oversubscribed slip.
const signSchema = z.union([
  z.object({ mode: z.literal('PRO_RATA') }),
  z.object({
    lines: z
      .array(
        z.object({
          lineId: z.string().uuid(),
          signedLine: z.number().gt(0).max(1),
        }),
      )
      .min(1),
  }),
]);

export async function placementModule(app: FastifyInstance): Promise<void> {
  // Create a slip for a contract (status DRAFT).
  app.post('/api/placement/slips', { preHandler: requirePermission('placement:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createSlipSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid slip', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const ref = await nextReference(db, ctx.tenantId, 'treaty_reference', 'SLIP');
      const { rows } = await db.query<{ id: string }>(
        `insert into slip (tenant_id, contract_id, reference, umr, order_pct, status, created_by)
         values ($1,$2,$3,$4,$5,'DRAFT',$6) returning id`,
        [ctx.tenantId, b.contractId, ref, b.umr ?? null, b.orderPct, ctx.userId],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'slip',
        entityId: id,
        after: { contractId: b.contractId, orderPct: b.orderPct, status: 'DRAFT' },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, reference: ref, status: 'DRAFT' };
    });
  });

  // A slip with its market lines.
  app.get<{ Params: { id: string } }>(
    '/api/placement/slips/:id',
    { preHandler: requirePermission('placement:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const slip = await loadSlip(db, req.params.id);
        if (!slip) {
          reply.code(404);
          return { error: 'Slip not found' };
        }
        return slip;
      });
    },
  );

  // List slips for a contract.
  app.get<{ Querystring: { contractId?: string } }>(
    '/api/placement/slips',
    { preHandler: requirePermission('placement:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select id, reference, contract_id as "contractId", umr, status,
                  order_pct as "orderPct", total_written as "totalWritten",
                  total_signed as "totalSigned", is_oversubscribed as "isOversubscribed"
             from slip
            where ($1::uuid is null or contract_id = $1)
            order by created_at desc`,
          [req.query.contractId ?? null],
        );
        return { slips: rows };
      });
    },
  );

  // Add a written market line; recompute total_written and oversubscription flag.
  app.post<{ Params: { id: string } }>(
    '/api/placement/slips/:id/lines',
    { preHandler: requirePermission('placement:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = addLineSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid market line', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const slip = await loadSlip(db, req.params.id);
        if (!slip) {
          reply.code(404);
          return { error: 'Slip not found' };
        }
        const { rows } = await db.query<{ id: string }>(
          `insert into market_line (tenant_id, slip_id, party_id, layer_id, written_line, status)
           values ($1,$2,$3,$4,$5,'WRITTEN') returning id`,
          [ctx.tenantId, slip.id, b.partyId, b.layerId ?? null, b.writtenLine],
        );
        const lineId = rows[0]!.id;

        const agg = await db.query<{ total_written: number }>(
          `select coalesce(sum(written_line), 0) as total_written from market_line where slip_id = $1`,
          [slip.id],
        );
        const totalWritten = Number(agg.rows[0]!.total_written);
        const isOversubscribed = totalWritten > Number(slip.orderPct);
        await db.query(
          `update slip set total_written = $1, is_oversubscribed = $2, updated_at = now() where id = $3`,
          [totalWritten, isOversubscribed, slip.id],
        );

        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'market_line',
          entityId: lineId,
          after: { slipId: slip.id, partyId: b.partyId, writtenLine: b.writtenLine, totalWritten, isOversubscribed },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { id: lineId, totalWritten, isOversubscribed };
      });
    },
  );

  // Signing workflow (gap-analysis §2.2 item 1): record signed shares against the
  // written lines - explicitly per line, or pro-rata when oversubscribed. Signed
  // shares only ever go DOWN from the written share, and the signed total may
  // never exceed the order.
  app.post<{ Params: { id: string } }>(
    '/api/placement/slips/:id/sign',
    { preHandler: requirePermission('placement:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = signSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid sign request', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      return runAs(ctx, async (db) => {
        const slip = await loadSlip(db, req.params.id);
        if (!slip) {
          reply.code(404);
          return { error: 'Slip not found' };
        }
        const orderPct = Number(slip.orderPct);
        const { rows: lines } = await db.query<{
          id: string;
          party_id: string;
          written_line: string;
          signed_line: string | null;
        }>(
          `select id, party_id, written_line, signed_line
             from market_line where slip_id = $1 order by written_at, created_at`,
          [slip.id],
        );
        if (lines.length === 0) {
          reply.code(400);
          return { error: 'Slip has no written lines to sign' };
        }
        const totalWritten = lines.reduce((acc, l) => acc + Number(l.written_line), 0);

        // Resolve the target signed share per line id.
        const targets = new Map<string, number>();
        if ('mode' in b) {
          // Classic signing down: scale every written line by order/total written,
          // capped at 1 (an undersubscribed slip signs each line as written).
          if (totalWritten <= 0) {
            reply.code(400);
            return { error: 'Slip has no written share to sign' };
          }
          const factor = Math.min(1, orderPct / totalWritten);
          for (const l of lines) targets.set(l.id, Number(l.written_line) * factor);
        } else {
          const byId = new Map(lines.map((l) => [l.id, l]));
          for (const item of b.lines) {
            const line = byId.get(item.lineId);
            if (!line) {
              reply.code(400);
              return { error: `Line ${item.lineId} does not belong to this slip` };
            }
            const writtenLine = Number(line.written_line);
            if (item.signedLine > writtenLine + SIGN_EPSILON) {
              reply.code(400);
              return {
                error: `Signed line ${item.signedLine} exceeds written line ${writtenLine} for line ${item.lineId} - signing down only, never up`,
              };
            }
            targets.set(item.lineId, item.signedLine);
          }
        }

        // Slip-level invariant: new targets plus untouched already-signed lines
        // must not exceed the order.
        let totalSigned = 0;
        for (const l of lines) {
          totalSigned += targets.get(l.id) ?? (l.signed_line === null ? 0 : Number(l.signed_line));
        }
        if (totalSigned > orderPct + SIGN_EPSILON) {
          reply.code(400);
          return { error: `Total signed ${totalSigned} exceeds the order ${orderPct}` };
        }

        const before = lines.map((l) => ({
          id: l.id,
          partyId: l.party_id,
          writtenLine: Number(l.written_line),
          signedLine: l.signed_line === null ? null : Number(l.signed_line),
        }));
        const signedLines: { id: string; partyId: string; writtenLine: number; signedLine: number | null }[] = [];
        for (const l of lines) {
          const target = targets.get(l.id);
          if (target !== undefined) {
            await db.query(`update market_line set signed_line = $1, status = 'SIGNED' where id = $2`, [target, l.id]);
          }
          signedLines.push({
            id: l.id,
            partyId: l.party_id,
            writtenLine: Number(l.written_line),
            signedLine: target ?? (l.signed_line === null ? null : Number(l.signed_line)),
          });
        }

        await db.query(`update slip set total_signed = $1, status = 'SIGNED', updated_at = now() where id = $2`, [
          totalSigned,
          slip.id,
        ]);
        // slip has no signed_at column (migration 0009); the timestamp is returned
        // and audited rather than persisted.
        const signedAt = new Date().toISOString();

        await writeAudit(db, ctx, {
          action: 'sign',
          entityType: 'slip',
          entityId: slip.id,
          before: { lines: before, totalSigned: Number(slip.totalSigned ?? 0), status: slip.status },
          after: {
            lines: signedLines,
            totalSigned,
            orderPct,
            status: 'SIGNED',
            mode: 'mode' in b ? 'PRO_RATA' : 'EXPLICIT',
          },
          actorLabel: req.auth?.displayName,
        });
        return { id: slip.id, status: 'SIGNED', orderPct, totalWritten, totalSigned, signedAt, lines: signedLines };
      });
    },
  );

  // Written-vs-signed reconciliation view for a slip.
  app.get<{ Params: { id: string } }>(
    '/api/placement/slips/:id/signing',
    { preHandler: requirePermission('placement:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const slip = await loadSlip(db, req.params.id);
        if (!slip) {
          reply.code(404);
          return { error: 'Slip not found' };
        }
        const raw = slip.marketLines as {
          id: string;
          partyId: string;
          partyName: string | null;
          writtenLine: string | number;
          signedLine: string | number | null;
        }[];
        const lines = raw.map((l) => {
          const writtenLine = Number(l.writtenLine);
          const signedLine = l.signedLine === null ? null : Number(l.signedLine);
          return {
            lineId: l.id,
            partyId: l.partyId,
            party: l.partyName,
            writtenLine,
            signedLine,
            deltaLine: signedLine === null ? null : signedLine - writtenLine,
          };
        });
        const writtenTotal = lines.reduce((acc, l) => acc + l.writtenLine, 0);
        const signedTotal = lines.reduce((acc, l) => acc + (l.signedLine ?? 0), 0);
        const orderPct = Number(slip.orderPct);
        return {
          slipId: slip.id,
          reference: slip.reference,
          status: slip.status,
          lines,
          totals: {
            writtenTotal,
            signedTotal,
            orderPct,
            oversubscribed: writtenTotal > orderPct + SIGN_EPSILON,
            fullySigned: Math.abs(signedTotal - orderPct) < FULLY_SIGNED_EPSILON,
          },
        };
      });
    },
  );

  // Signing down (§7.3 step 4): reconcile written lines to the order and create participations.
  app.post<{ Params: { id: string } }>(
    '/api/placement/slips/:id/sign-down',
    { preHandler: requirePermission('placement:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const slip = await loadSlip(db, req.params.id);
        if (!slip) {
          reply.code(404);
          return { error: 'Slip not found' };
        }
        const orderPct = Number(slip.orderPct);
        const lines = await db.query<{ id: string; party_id: string; layer_id: string | null; written_line: number }>(
          `select id, party_id, layer_id, written_line from market_line where slip_id = $1 order by written_at, created_at`,
          [slip.id],
        );
        const totalWritten = lines.rows.reduce((acc, l) => acc + Number(l.written_line), 0);

        // Over-subscribed → scale each line by order/total; otherwise the signed line equals the written line.
        const factor = totalWritten > orderPct ? orderPct / totalWritten : 1;

        const signedLines: { id: string; partyId: string; layerId: string | null; writtenLine: number; signedLine: number }[] = [];
        const participations: { id: string; partyId: string; layerId: string | null; writtenLine: number; signedLine: number }[] = [];
        let totalSigned = 0;

        for (const l of lines.rows) {
          const writtenLine = Number(l.written_line);
          const signedLine = writtenLine * factor;
          totalSigned += signedLine;
          await db.query(
            `update market_line set signed_line = $1, status = 'SIGNED' where id = $2`,
            [signedLine, l.id],
          );
          signedLines.push({ id: l.id, partyId: l.party_id, layerId: l.layer_id, writtenLine, signedLine });

          const part = await db.query<{ id: string }>(
            `insert into participation
               (tenant_id, contract_id, layer_id, party_id, written_line, signed_line, order_pct, status)
             values ($1,$2,$3,$4,$5,$6,$7,'SIGNED') returning id`,
            [ctx.tenantId, slip.contractId, l.layer_id, l.party_id, writtenLine, signedLine, orderPct],
          );
          participations.push({ id: part.rows[0]!.id, partyId: l.party_id, layerId: l.layer_id, writtenLine, signedLine });
        }

        await db.query(
          `update slip set total_signed = $1, status = 'SIGNED', updated_at = now() where id = $2`,
          [totalSigned, slip.id],
        );

        await writeAudit(db, ctx, {
          action: 'sign-down',
          entityType: 'slip',
          entityId: slip.id,
          after: { orderPct, totalWritten, totalSigned, participations: participations.length },
          actorLabel: req.auth?.displayName,
        });
        return { id: slip.id, status: 'SIGNED', orderPct, totalWritten, totalSigned, signedLines, participations };
      });
    },
  );
}

interface SlipRow {
  id: string;
  contractId: string;
  orderPct: number;
}

async function loadSlip(db: Db, id: string): Promise<(SlipRow & Record<string, unknown>) | null> {
  const { rows } = await db.query(
    `select id, reference, contract_id as "contractId", umr, status,
            order_pct as "orderPct", total_written as "totalWritten",
            total_signed as "totalSigned", is_oversubscribed as "isOversubscribed"
       from slip where id = $1`,
    [id],
  );
  const slip = rows[0] as (SlipRow & Record<string, unknown>) | undefined;
  if (!slip) return null;

  const lines = await db.query(
    `select ml.id, ml.party_id as "partyId", pty.short_name as "partyName",
            ml.layer_id as "layerId", ml.written_line as "writtenLine",
            ml.signed_line as "signedLine", ml.status
       from market_line ml left join party pty on pty.id = ml.party_id
      where ml.slip_id = $1 order by ml.written_at, ml.created_at`,
    [id],
  );
  slip.marketLines = lines.rows;
  return slip;
}
