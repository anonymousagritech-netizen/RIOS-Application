/**
 * Territory Management (brief §17). The geographic master - a country → state →
 * city hierarchy plus the accumulation-zone taxonomies (CRESTA, peril, risk,
 * postal) - joined to live exposure so every territory carries its TIV, modelled
 * PML and a blended risk score (@rios/domain/territory). This is the reference
 * side of exposure accumulation; the per-risk geo dimensions live on
 * exposure_item and roll up here.
 *
 * Reads gate on exposure:read, writes on exposure:write. Money is integer minor units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { territoryBook, type RiskGrade, type TerritoryExposureInput } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';

interface TerritoryRow {
  id: string; parentId: string | null; kind: string; code: string; name: string;
  countryCode: string | null; riskGrade: RiskGrade | null; perils: string[];
}

/** Load every territory row for the tenant (small reference set). */
async function allTerritories(db: Db): Promise<TerritoryRow[]> {
  const { rows } = await db.query<TerritoryRow>(
    `select id, parent_id as "parentId", kind, code, name, country_code as "countryCode",
            risk_grade as "riskGrade", perils::text[] as perils
       from territory order by kind, code`,
  );
  return rows;
}

/** Exposure aggregated by a geo column (country or cresta). */
async function exposureBy(db: Db, column: 'country' | 'cresta'): Promise<Map<string, { tivMinor: number; pmlMinor: number; itemCount: number }>> {
  const { rows } = await db.query<{ k: string; tiv: string; pml: string; n: string }>(
    `select ${column} k, coalesce(sum(tiv_minor),0)::bigint tiv,
            coalesce(sum(pml_minor),0)::bigint pml, count(*)::int n
       from exposure_item where ${column} is not null group by ${column}`,
  );
  const m = new Map<string, { tivMinor: number; pmlMinor: number; itemCount: number }>();
  for (const r of rows) m.set(r.k, { tivMinor: Number(r.tiv), pmlMinor: Number(r.pml), itemCount: Number(r.n) });
  return m;
}

export async function territoryMgmtModule(app: FastifyInstance): Promise<void> {
  // ---- Dashboard: hierarchy tree, zones, accumulation books ----------------
  app.get('/api/territory-management', { preHandler: requirePermission('exposure:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const terrs = await allTerritories(db);
      const byCountryExp = await exposureBy(db, 'country');
      const byCrestaExp = await exposureBy(db, 'cresta');

      // Geographic hierarchy: country → state → city.
      const childrenOf = new Map<string | null, TerritoryRow[]>();
      for (const t of terrs.filter((x) => ['COUNTRY', 'STATE', 'CITY'].includes(x.kind))) {
        const key = t.parentId;
        const arr = childrenOf.get(key) ?? [];
        arr.push(t);
        childrenOf.set(key, arr);
      }
      const build = (t: TerritoryRow): unknown => ({
        id: t.id, code: t.code, name: t.name, kind: t.kind, riskGrade: t.riskGrade,
        children: (childrenOf.get(t.id) ?? []).map(build),
      });
      const tree = terrs.filter((t) => t.kind === 'COUNTRY').map(build);

      // Zone taxonomies with exposure rolled in where a CRESTA code matches.
      const zoneRow = (t: TerritoryRow) => {
        const exp = byCrestaExp.get(t.code);
        return {
          id: t.id, code: t.code, name: t.name, kind: t.kind, countryCode: t.countryCode,
          riskGrade: t.riskGrade, perils: t.perils,
          tivMinor: exp?.tivMinor ?? 0, pmlMinor: exp?.pmlMinor ?? 0, itemCount: exp?.itemCount ?? 0,
        };
      };
      const zones = {
        cresta: terrs.filter((t) => t.kind === 'CRESTA').map(zoneRow),
        peril: terrs.filter((t) => t.kind === 'PERIL').map(zoneRow),
        risk: terrs.filter((t) => t.kind === 'RISK').map(zoneRow),
        postal: terrs.filter((t) => t.kind === 'POSTAL').map(zoneRow),
      };

      // Accumulation books: by country and by CRESTA zone, risk-scored.
      const countryInputs: TerritoryExposureInput[] = terrs
        .filter((t) => t.kind === 'COUNTRY')
        .map((t) => {
          const exp = byCountryExp.get(t.code) ?? { tivMinor: 0, pmlMinor: 0, itemCount: 0 };
          return { code: t.code, name: t.name, ...exp, riskGrade: t.riskGrade };
        });
      const crestaInputs: TerritoryExposureInput[] = terrs
        .filter((t) => t.kind === 'CRESTA')
        .map((t) => {
          const exp = byCrestaExp.get(t.code) ?? { tivMinor: 0, pmlMinor: 0, itemCount: 0 };
          return { code: t.code, name: t.name, ...exp, riskGrade: t.riskGrade };
        });
      const countryBook = territoryBook(countryInputs);
      const crestaBook = territoryBook(crestaInputs);

      const countByKind: Record<string, number> = {};
      for (const t of terrs) countByKind[t.kind] = (countByKind[t.kind] ?? 0) + 1;

      return {
        totals: {
          countries: countByKind.COUNTRY ?? 0,
          states: countByKind.STATE ?? 0,
          cities: countByKind.CITY ?? 0,
          zones: (countByKind.CRESTA ?? 0) + (countByKind.PERIL ?? 0) + (countByKind.RISK ?? 0) + (countByKind.POSTAL ?? 0),
          tivMinor: countryBook.totalTivMinor,
          pmlMinor: countryBook.totalPmlMinor,
          highRisk: countryBook.highRiskCount + crestaBook.highRiskCount,
        },
        byKind: Object.entries(countByKind).map(([key, n]) => ({ key, n })),
        tree,
        zones,
        countryBook,
        crestaBook,
      };
    });
  });

  // ---- Territory detail (children + local exposure) ------------------------
  app.get<{ Params: { id: string } }>('/api/territory-management/:id', { preHandler: requirePermission('exposure:read') }, async (req, reply) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const t = await db.query<TerritoryRow>(
        `select id, parent_id as "parentId", kind, code, name, country_code as "countryCode",
                risk_grade as "riskGrade", perils::text[] as perils
           from territory where id = $1`, [req.params.id]);
      if (!t.rows[0]) { reply.code(404); return { error: 'Territory not found' }; }
      const row = t.rows[0];
      const children = await db.query(
        `select id, code, name, kind, risk_grade as "riskGrade" from territory where parent_id = $1 order by kind, name`, [req.params.id]);
      // Local exposure: match on the geo column relevant to the kind.
      const col = row.kind === 'CRESTA' ? 'cresta' : row.kind === 'CITY' ? 'city' : 'country';
      const matchVal = row.kind === 'COUNTRY' ? row.code : row.kind === 'CRESTA' ? row.code : row.name;
      const exp = await db.query<{ tiv: string; pml: string; n: string }>(
        `select coalesce(sum(tiv_minor),0)::bigint tiv, coalesce(sum(pml_minor),0)::bigint pml, count(*)::int n
           from exposure_item where ${col} = $1`, [matchVal]);
      const e = exp.rows[0]!;
      return {
        ...row, children: children.rows,
        exposure: { tivMinor: Number(e.tiv), pmlMinor: Number(e.pml), itemCount: Number(e.n) },
      };
    });
  });

  // ---- Create a territory --------------------------------------------------
  const schema = z.object({
    kind: z.enum(['COUNTRY', 'REGION', 'STATE', 'CITY', 'CRESTA', 'POSTAL', 'PERIL', 'RISK']).default('COUNTRY'),
    code: z.string().min(1), name: z.string().min(1),
    countryCode: z.string().length(2).optional(),
    parentId: z.string().uuid().nullable().optional(),
    riskGrade: z.enum(['LOW', 'MODERATE', 'ELEVATED', 'HIGH', 'SEVERE']).nullable().optional(),
    perils: z.array(z.string()).optional(),
  });
  app.post('/api/territory-management', { preHandler: requirePermission('exposure:write') }, async (req, reply) => {
    const ctx = authContext(req);
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'Invalid territory', details: parsed.error.flatten() }; }
    const b = parsed.data;
    return runAs(ctx, async (db) => {
      try {
        const { rows } = await db.query<{ id: string }>(
          `insert into territory (tenant_id, parent_id, kind, code, name, country_code, risk_grade, perils)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [ctx.tenantId, b.parentId ?? null, b.kind, b.code, b.name, b.countryCode ?? null, b.riskGrade ?? null, b.perils ?? []]);
        await writeAudit(db, ctx, { action: 'territory_create', entityType: 'territory', entityId: rows[0]!.id, after: { kind: b.kind, code: b.code } });
        reply.code(201);
        return { id: rows[0]!.id };
      } catch {
        reply.code(409); return { error: 'A territory with that kind + code already exists' };
      }
    });
  });
}
