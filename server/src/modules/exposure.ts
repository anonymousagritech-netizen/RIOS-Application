/**
 * Exposure / Aggregate management module (brief §7.8, §9.9, §30).
 *
 * Accumulation points hold a zonal capacity (peril × zone) and aggregate the
 * gross/net exposure contributed by risks and contracts. The cat / exposure
 * manager view compares zonal aggregates against limits and flags breaches (§30).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromMajor } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

const createAccumulationSchema = z.object({
  peril: z.string().min(1),
  zone: z.string().min(1),
  currency: z.string().length(3),
  capacity: z.number().nonnegative().default(0),
});

const createEntrySchema = z.object({
  riskId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  grossExposure: z.number().nonnegative().default(0),
  netExposure: z.number().nonnegative().default(0),
  currency: z.string().length(3),
});

export async function exposureModule(app: FastifyInstance): Promise<void> {
  app.post('/api/exposure/accumulations', { preHandler: requirePermission('exposure:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = createAccumulationSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid accumulation', details: parsed.error.flatten() };
    }
    const b = parsed.data;
    const ccy = b.currency.toUpperCase();
    const capacity = fromMajor(b.capacity, ccy).amount;
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into accumulation (tenant_id, peril, zone, currency, capacity_minor)
         values ($1,$2,$3,$4,$5) returning id`,
        [ctx.tenantId, b.peril, b.zone, ccy, capacity],
      );
      const id = rows[0]!.id;
      await writeAudit(db, ctx, {
        action: 'create',
        entityType: 'accumulation',
        entityId: id,
        after: { peril: b.peril, zone: b.zone, capacityMinor: capacity },
        actorLabel: req.auth?.displayName,
      });
      reply.code(201);
      return { id, peril: b.peril, zone: b.zone, currency: ccy, capacityMinor: capacity };
    });
  });

  // List accumulations with their utilisation against capacity (zonal aggregates vs limits, §30).
  app.get('/api/exposure/accumulations', { preHandler: requirePermission('exposure:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        id: string;
        peril: string;
        zone: string;
        currency: string;
        capacityMinor: number;
        usedMinor: number;
        netMinor: number;
      }>(
        `select a.id, a.peril, a.zone, a.currency,
                a.capacity_minor as "capacityMinor",
                coalesce(sum(e.gross_exposure_minor), 0)::bigint as "usedMinor",
                coalesce(sum(e.net_exposure_minor), 0)::bigint as "netMinor"
           from accumulation a
           left join exposure_entry e on e.accumulation_id = a.id
          group by a.id
          order by a.peril, a.zone`,
      );
      const accumulations = rows.map((r) => ({
        ...r,
        utilisationPct: r.capacityMinor > 0 ? r.usedMinor / r.capacityMinor : null,
        breached: r.usedMinor > r.capacityMinor,
      }));
      return { accumulations };
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/exposure/accumulations/:id/entries',
    { preHandler: requirePermission('exposure:write') },
    async (req, reply) => {
      const ctx = authContext(req);
      const parsed = createEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid exposure entry', details: parsed.error.flatten() };
      }
      const b = parsed.data;
      const ccy = b.currency.toUpperCase();
      const gross = fromMajor(b.grossExposure, ccy).amount;
      const net = fromMajor(b.netExposure, ccy).amount;
      return runAs(ctx, async (db) => {
        const acc = await db.query<{ id: string }>(`select id from accumulation where id = $1`, [req.params.id]);
        if (!acc.rows[0]) {
          reply.code(404);
          return { error: 'Accumulation not found' };
        }
        const { rows } = await db.query<{ id: string }>(
          `insert into exposure_entry
             (tenant_id, accumulation_id, risk_id, contract_id, gross_exposure_minor, net_exposure_minor, currency)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [ctx.tenantId, req.params.id, b.riskId ?? null, b.contractId ?? null, gross, net, ccy],
        );
        const id = rows[0]!.id;
        await writeAudit(db, ctx, {
          action: 'create',
          entityType: 'exposure_entry',
          entityId: id,
          after: { accumulationId: req.params.id, grossExposureMinor: gross, netExposureMinor: net },
          actorLabel: req.auth?.displayName,
        });
        reply.code(201);
        return { id, grossExposureMinor: gross, netExposureMinor: net, currency: ccy };
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/exposure/accumulations/:id',
    { preHandler: requirePermission('exposure:read') },
    async (req, reply) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query<{
          id: string;
          peril: string;
          zone: string;
          currency: string;
          capacityMinor: number;
          usedMinor: number;
          netMinor: number;
        }>(
          `select a.id, a.peril, a.zone, a.currency,
                  a.capacity_minor as "capacityMinor",
                  coalesce(sum(e.gross_exposure_minor), 0)::bigint as "usedMinor",
                  coalesce(sum(e.net_exposure_minor), 0)::bigint as "netMinor"
             from accumulation a
             left join exposure_entry e on e.accumulation_id = a.id
            where a.id = $1
            group by a.id`,
          [req.params.id],
        );
        if (!rows[0]) {
          reply.code(404);
          return { error: 'Accumulation not found' };
        }
        const a = rows[0];
        const entries = await db.query(
          `select id, risk_id as "riskId", contract_id as "contractId",
                  gross_exposure_minor as "grossExposureMinor", net_exposure_minor as "netExposureMinor",
                  currency, created_at as "createdAt"
             from exposure_entry where accumulation_id = $1 order by created_at`,
          [req.params.id],
        );
        return {
          ...a,
          utilisationPct: a.capacityMinor > 0 ? a.usedMinor / a.capacityMinor : null,
          breached: a.usedMinor > a.capacityMinor,
          entries: entries.rows,
        };
      });
    },
  );

  // Aggregate gross/net exposure grouped by peril+zone across all accumulations.
  app.get<{ Querystring: { peril?: string; zone?: string } }>(
    '/api/exposure/summary',
    { preHandler: requirePermission('exposure:read') },
    async (req) => {
      const ctx = authContext(req);
      return runAs(ctx, async (db) => {
        const { rows } = await db.query(
          `select a.peril, a.zone,
                  coalesce(sum(e.gross_exposure_minor), 0)::bigint as "grossMinor",
                  coalesce(sum(e.net_exposure_minor), 0)::bigint as "netMinor"
             from accumulation a
             left join exposure_entry e on e.accumulation_id = a.id
            where ($1::text is null or a.peril = $1)
              and ($2::text is null or a.zone = $2)
            group by a.peril, a.zone
            order by a.peril, a.zone`,
          [req.query.peril ?? null, req.query.zone ?? null],
        );
        return { summary: rows };
      });
    },
  );
}
