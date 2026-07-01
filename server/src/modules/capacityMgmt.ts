/**
 * Capacity management (brief §7 / §28.3). A register of capacity lines - overall
 * and by geography / line / peril / broker / cedent - each carrying an available
 * and consumed amount. The console reports utilisation, remaining, RAG status,
 * threshold alerts and a straight-line year-end forecast. Math is in
 * @rios/domain (capacityMgmt); this module persists + orchestrates.
 *
 * Namespaced under /api/underwriting/capacity to sit within the UW platform.
 * Reads gate on treaty:read, writes on treaty:write. Money is integer minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { capacityBook, capacityAlerts, capacityForecast } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/** Fraction of the calendar year elapsed (server clock; domain stays clockless). */
function yearFractionElapsed(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1).getTime();
  const end = new Date(now.getFullYear() + 1, 0, 1).getTime();
  return Math.max(0.01, Math.min(1, (now.getTime() - start) / (end - start)));
}

export async function capacityMgmtModule(app: FastifyInstance): Promise<void> {
  // ---- Capacity book (utilisation, alerts, forecast) -----------------------
  app.get<{ Querystring: { dimension?: string } }>('/api/underwriting/capacity', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    const dimension = req.query.dimension;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        id: string; dimension: string; dim_key: string; label: string | null;
        period: string | null; available_minor: string; consumed_minor: string; warn_pct: number;
      }>(
        `select id, dimension, dim_key, label, period, available_minor, consumed_minor, warn_pct
           from capacity_line where ($1::text is null or dimension = $1) order by consumed_minor::numeric / nullif(available_minor,0) desc nulls last`,
        [dimension ?? null],
      );
      const input = rows.map((r) => ({
        dimension: r.dimension, dimKey: r.dim_key, label: r.label,
        availableMinor: Number(r.available_minor), consumedMinor: Number(r.consumed_minor), warnPct: r.warn_pct,
      }));
      const book = capacityBook(input);
      const alerts = capacityAlerts(input);
      const frac = yearFractionElapsed();
      const forecast = capacityForecast(book.consumedMinor, book.availableMinor, frac);
      // Attach the row id back to each line for the UI.
      const linesById = new Map(rows.map((r) => [`${r.dimension}|${r.dim_key}`, r.id]));
      const lines = book.lines.map((l) => ({ ...l, id: linesById.get(`${l.dimension}|${l.dimKey}`) }));
      return { book: { ...book, lines }, alerts, forecast, fractionElapsed: Math.round(frac * 100) / 100 };
    });
  });

  // ---- Upsert a capacity line ----------------------------------------------
  const lineSchema = z.object({
    dimension: z.enum(['OVERALL', 'GEOGRAPHY', 'LINE_OF_BUSINESS', 'PERIL', 'BROKER', 'CEDENT']).default('OVERALL'),
    dimKey: z.string().min(1).default('ALL'), label: z.string().optional(), period: z.string().optional(),
    available: z.number().nonnegative(), consumed: z.number().nonnegative().default(0),
    warnPct: z.number().min(1).max(100).optional(), notes: z.string().optional(),
  });
  app.post('/api/underwriting/capacity/lines', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = lineSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid capacity line', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into capacity_line (tenant_id, dimension, dim_key, label, period, available_minor, consumed_minor, warn_pct, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [ctx.tenantId, b.dimension, b.dimKey, b.label ?? null, b.period ?? null, Math.round(b.available * 100), Math.round(b.consumed * 100), b.warnPct ?? 80, b.notes ?? null],
      );
      await writeAudit(db, ctx, { action: 'capacity_line', entityType: 'capacity_line', entityId: rows[0]!.id, after: { dimension: b.dimension, dimKey: b.dimKey } });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });

  // ---- Set consumed on a line ----------------------------------------------
  app.post<{ Params: { id: string } }>('/api/underwriting/capacity/lines/:id/consume', { preHandler: requirePermission('treaty:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const consumed = (req.body as { consumed?: number })?.consumed;
    if (typeof consumed !== 'number') { reply.code(400); return { error: 'consumed (number) is required' }; }
    return runAs(ctx, async (db) => {
      const r = await db.query(`update capacity_line set consumed_minor = $2, updated_at = now() where id = $1 returning id`, [req.params.id, Math.round(consumed * 100)]);
      if (!r.rows[0]) { reply.code(404); return { error: 'Capacity line not found' }; }
      return { ok: true };
    });
  });
}
