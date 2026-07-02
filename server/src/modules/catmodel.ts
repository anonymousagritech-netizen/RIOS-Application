/**
 * Catastrophe-model provider adapter & Event Loss Table (ELT) import (brief §13).
 *
 * Imports an ELT (annual event rate + loss per event) from a catastrophe
 * modelling vendor, persists it, and computes the standard cat metrics - Average
 * Annual Loss, the occurrence-exceedance-probability (OEP) curve and the PML at
 * a set of return periods - using the pure @rios/domain catastrophe engine.
 *
 * The import is abstracted behind the `CatEltImporter` interface. RIOS ships two
 * working in-repo adapters (CSV and JSON); a licensed vendor API (RMS/Moody's,
 * Verisk/AIR, CoreLogic) is the labelled integration seam that implements the
 * same interface and writes ELTs behind it. Reads need exposure:read; importing
 * needs exposure:write and is audited.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { averageAnnualLoss, exceedanceCurve, pmlProfile, type EltEvent } from '@rios/domain';
import { parseCsvRecords, CsvParseError } from '../csv.js';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

/** Standard return periods the PML profile is computed at. */
const RETURN_PERIODS = [10, 25, 50, 100, 250, 500, 1000];

interface ParsedElt {
  events: (EltEvent & { eventRef?: string; eventName?: string })[];
}

/** The import seam: turn a vendor source into ELT events. */
export interface CatEltImporter {
  readonly format: string;
  parse(source: unknown): ParsedElt;
}

/** Default CSV adapter: header row with rate + loss(Minor) columns (+ optional ref/name). */
export class CsvEltImporter implements CatEltImporter {
  readonly format = 'CSV';
  parse(source: unknown): ParsedElt {
    if (typeof source !== 'string' || !source.trim()) throw new Error('CSV source must be non-empty text');
    const records = parseCsvRecords(source);
    if (records.length < 2) throw new Error('CSV needs a header row and at least one event row');
    const header = records[0]!.map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const rateIdx = col('rate', 'frequency', 'lambda');
    const lossIdx = col('lossminor', 'loss_minor', 'loss', 'meanloss', 'mean_loss');
    const refIdx = col('eventref', 'event_ref', 'eventid', 'event_id', 'id');
    const nameIdx = col('eventname', 'event_name', 'name');
    if (rateIdx < 0 || lossIdx < 0) throw new Error('CSV must have a rate column and a loss/lossMinor column');
    const events = records.slice(1).map((r, i) => {
      const rate = Number(r[rateIdx]);
      const lossMinor = Math.round(Number(r[lossIdx]));
      if (!Number.isFinite(rate) || rate < 0) throw new Error(`row ${i + 2}: invalid rate`);
      if (!Number.isFinite(lossMinor) || lossMinor < 0) throw new Error(`row ${i + 2}: invalid loss`);
      return { rate, lossMinor, eventRef: refIdx >= 0 ? r[refIdx] : undefined, eventName: nameIdx >= 0 ? r[nameIdx] : undefined };
    });
    return { events };
  }
}

/** Default JSON adapter: an array of {rate, lossMinor, eventRef?, eventName?}. */
export class JsonEltImporter implements CatEltImporter {
  readonly format = 'JSON';
  parse(source: unknown): ParsedElt {
    const arr = Array.isArray(source) ? source : (source as { events?: unknown[] })?.events;
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('JSON source must be a non-empty array of events');
    const events = arr.map((e: any, i) => {
      const rate = Number(e.rate ?? e.frequency);
      const lossMinor = Math.round(Number(e.lossMinor ?? e.loss ?? e.meanLoss));
      if (!Number.isFinite(rate) || rate < 0) throw new Error(`event ${i}: invalid rate`);
      if (!Number.isFinite(lossMinor) || lossMinor < 0) throw new Error(`event ${i}: invalid loss`);
      return { rate, lossMinor, eventRef: e.eventRef ?? e.id, eventName: e.eventName ?? e.name };
    });
    return { events };
  }
}

const importers: Record<string, CatEltImporter> = {
  CSV: new CsvEltImporter(),
  JSON: new JsonEltImporter(),
};

const importSchema = z.object({
  name: z.string().min(1),
  vendor: z.string().default('IMPORT'),
  peril: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  currency: z.string().length(3).default('USD'),
  format: z.enum(['CSV', 'JSON']),
  data: z.union([z.string(), z.array(z.any()), z.record(z.any())]),
  contractId: z.string().uuid().nullable().optional(),
});

export async function catModelModule(app: FastifyInstance): Promise<void> {
  // Import an ELT, persist it and its computed metrics.
  app.post('/api/catmodel/elt', { preHandler: requirePermission('exposure:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const input = importSchema.parse(req.body);
    const importer = importers[input.format]!;
    let parsed: ParsedElt;
    try {
      parsed = importer.parse(input.data);
    } catch (err) {
      const msg = err instanceof CsvParseError ? `CSV line ${err.line}: ${err.message}` : (err as Error).message;
      return reply.code(400).send({ error: 'ELT parse failed', detail: msg });
    }

    const elt: EltEvent[] = parsed.events.map((e) => ({ rate: e.rate, lossMinor: e.lossMinor }));
    const aalMinor = averageAnnualLoss(elt);
    const epCurve = exceedanceCurve(elt).map((p) => ({
      ...p, returnPeriod: Number.isFinite(p.returnPeriod) ? p.returnPeriod : null,
    }));
    const pml = pmlProfile(elt, RETURN_PERIODS);

    return runAs(ctx, async (db) => {
      const { rows: eltRows } = await db.query(
        `insert into cat_elt (tenant_id, name, vendor, peril, region, currency, source, event_count, contract_id, created_by)
         values (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, name, vendor, peril, region, currency, source, event_count as "eventCount", created_at as "createdAt"`,
        [input.name, input.vendor, input.peril ?? null, input.region ?? null, input.currency,
         input.format, parsed.events.length, input.contractId ?? null, ctx.userId],
      );
      const eltId = eltRows[0]!.id as string;

      for (const e of parsed.events) {
        await db.query(
          `insert into cat_elt_event (tenant_id, elt_id, event_ref, event_name, rate, loss_minor)
           values (app_current_tenant(), $1, $2, $3, $4, $5)`,
          [eltId, e.eventRef ?? null, e.eventName ?? null, e.rate, e.lossMinor],
        );
      }
      await db.query(
        `insert into cat_elt_metric (elt_id, tenant_id, aal_minor, ep_curve, pml_profile)
         values ($1, app_current_tenant(), $2, $3::jsonb, $4::jsonb)`,
        [eltId, aalMinor, JSON.stringify(epCurve), JSON.stringify(pml)],
      );
      await writeAudit(db, ctx, {
        action: 'catmodel.elt.import', entityType: 'cat_elt', entityId: eltId,
        after: { name: input.name, vendor: input.vendor, events: parsed.events.length, aalMinor },
      });
      return { elt: eltRows[0], metrics: { aalMinor, epCurve, pmlProfile: pml } };
    });
  });

  // List imported ELTs.
  app.get('/api/catmodel/elt', { preHandler: requirePermission('exposure:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query(
        `select e.id, e.name, e.vendor, e.peril, e.region, e.currency, e.source,
                e.event_count as "eventCount", e.contract_id as "contractId",
                e.created_at as "createdAt", m.aal_minor as "aalMinor"
           from cat_elt e left join cat_elt_metric m on m.elt_id = e.id
          order by e.created_at desc limit 200`,
      );
      return { elts: rows };
    });
  });

  // View one ELT with its events and computed metrics.
  app.get('/api/catmodel/elt/:id', { preHandler: requirePermission('exposure:read') }, async (req, reply) => {
    const ctx = authContext(req);
    const { id } = req.params as { id: string };
    return runAs(ctx, async (db) => {
      const { rows: head } = await db.query(
        `select e.id, e.name, e.vendor, e.peril, e.region, e.currency, e.source,
                e.event_count as "eventCount", e.contract_id as "contractId", e.created_at as "createdAt",
                m.aal_minor as "aalMinor", m.ep_curve as "epCurve", m.pml_profile as "pmlProfile"
           from cat_elt e left join cat_elt_metric m on m.elt_id = e.id
          where e.id = $1`,
        [id],
      );
      if (!head[0]) return reply.code(404).send({ error: 'ELT not found' });
      const { rows: events } = await db.query(
        `select event_ref as "eventRef", event_name as "eventName", rate, loss_minor as "lossMinor"
           from cat_elt_event where elt_id = $1 order by loss_minor desc limit 1000`,
        [id],
      );
      return { ...head[0], events };
    });
  });
}
