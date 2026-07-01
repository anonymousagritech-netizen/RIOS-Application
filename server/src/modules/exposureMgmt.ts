/**
 * Exposure management (brief §7 / §28, §30). A register of geolocated,
 * peril/line-tagged exposure items with total insured value and PML. The console
 * aggregates by country / CRESTA / peril / line, finds the peak accumulation,
 * builds a heatmap and measures concentration. Math is in @rios/domain
 * (exposureMgmt); this module persists + orchestrates.
 *
 * Namespaced under /api/underwriting/exposure to sit within the UW platform and
 * avoid clashing with the accumulation module. Reads gate on exposure:read,
 * writes on exposure:write. Money is integer minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exposureSummary, aggregateExposure, exposureHeatmap, type ExposureItemInput } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { toCsv, majorFromMinor } from '../csv.js';

async function loadItems(db: Db): Promise<(ExposureItemInput & { id: string; name: string | null })[]> {
  const { rows } = await db.query<{
    id: string; name: string | null; country: string | null; admin1: string | null; city: string | null;
    cresta: string | null; peril: string | null; line_of_business: string | null; tiv_minor: string; pml_minor: string | null;
  }>(`select id, name, country, admin1, city, cresta, peril, line_of_business, tiv_minor, pml_minor from exposure_item`);
  return rows.map((r) => ({
    id: r.id, name: r.name, country: r.country, admin1: r.admin1, city: r.city, cresta: r.cresta,
    peril: r.peril, lineOfBusiness: r.line_of_business, tivMinor: Number(r.tiv_minor), pmlMinor: r.pml_minor == null ? null : Number(r.pml_minor),
  }));
}

export async function exposureMgmtModule(app: FastifyInstance): Promise<void> {
  // ---- Exposure summary (aggregation + accumulation + heatmap) -------------
  app.get('/api/underwriting/exposure/summary', { preHandler: requirePermission('exposure:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const items = await loadItems(db);
      const summary = exposureSummary(items);
      return {
        summary,
        byCresta: aggregateExposure(items, 'cresta'),
        byAdmin1: aggregateExposure(items, 'admin1'),
        heatmap: exposureHeatmap(items, 'peril', 'country'),
      };
    });
  });

  // ---- List exposure items -------------------------------------------------
  app.get('/api/underwriting/exposure/items', { preHandler: requirePermission('exposure:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select id, name, country, admin1, city, cresta, peril, line_of_business as "lineOfBusiness",
                tiv_minor as "tivMinor", pml_minor as "pmlMinor"
           from exposure_item order by tiv_minor desc limit 200`,
      );
      return { items: rows };
    });
  });

  // ---- Exposure export (CSV / Excel) ---------------------------------------
  app.get('/api/underwriting/exposure/export.csv', { preHandler: requirePermission('exposure:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ name: string | null; country: string | null; admin1: string | null; city: string | null; cresta: string | null; peril: string | null; line_of_business: string | null; tiv_minor: string; pml_minor: string | null }>(
        `select name, country, admin1, city, cresta, peril, line_of_business, tiv_minor, pml_minor from exposure_item order by tiv_minor desc`,
      );
      const csv = toCsv(['Name', 'Country', 'State', 'City', 'CRESTA', 'Peril', 'Line of business', 'TIV (major)', 'PML (major)'],
        rows.map((r) => [r.name ?? '', r.country ?? '', r.admin1 ?? '', r.city ?? '', r.cresta ?? '', r.peril ?? '', r.line_of_business ?? '', majorFromMinor(r.tiv_minor), majorFromMinor(r.pml_minor)]));
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="exposure.csv"');
      return csv;
    });
  });

  // ---- Add an exposure item ------------------------------------------------
  const itemSchema = z.object({
    name: z.string().optional(), submissionId: z.string().uuid().optional(),
    country: z.string().length(2).optional(), admin1: z.string().optional(), city: z.string().optional(),
    cresta: z.string().optional(), postal: z.string().optional(), peril: z.string().optional(),
    lineOfBusiness: z.string().optional(), tiv: z.number().nonnegative(), pml: z.number().nonnegative().optional(),
  });
  app.post('/api/underwriting/exposure/items', { preHandler: requirePermission('exposure:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = itemSchema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid exposure item', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into exposure_item (tenant_id, submission_id, name, country, admin1, city, cresta, postal, peril, line_of_business, tiv_minor, pml_minor)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [ctx.tenantId, b.submissionId ?? null, b.name ?? null, b.country ?? null, b.admin1 ?? null, b.city ?? null, b.cresta ?? null, b.postal ?? null, b.peril ?? null, b.lineOfBusiness ?? null, Math.round(b.tiv * 100), b.pml === undefined ? null : Math.round(b.pml * 100)],
      );
      await writeAudit(db, ctx, { action: 'exposure_item', entityType: 'exposure_item', entityId: rows[0]!.id, after: { country: b.country, peril: b.peril, tiv: b.tiv } });
      reply.code(201);
      return { id: rows[0]!.id };
    });
  });
}
