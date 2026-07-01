/**
 * Territory management (brief §7 / §28). A cross-module geographic roll-up: for
 * each territory (country) it combines the exposure register (TIV / PML) with the
 * geographic capacity lines (available / consumed) so an underwriter sees, in one
 * place, where the book is concentrated and how much capacity is left there.
 * Integrates exposureMgmt + capacityMgmt; no new tables (derived from both).
 *
 * Reads gate on exposure:read. Money is integer minor units.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { capacityUtilisation } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';
import { toCsv, majorFromMinor } from '../csv.js';

const COUNTRY_NAME: Record<string, string> = {
  US: 'United States', JP: 'Japan', GB: 'United Kingdom', NL: 'Netherlands', DE: 'Germany',
  FR: 'France', CN: 'China', AU: 'Australia', CA: 'Canada', BM: 'Bermuda', CH: 'Switzerland',
  IT: 'Italy', ES: 'Spain', IN: 'India', BR: 'Brazil', MX: 'Mexico', NZ: 'New Zealand',
};
const territoryName = (code: string) => COUNTRY_NAME[code] ?? code;

interface TerritoryRow {
  code: string; name: string; items: number; tivMinor: number; pmlMinor: number;
  availableMinor: number; consumedMinor: number; remainingMinor: number; utilisationPct: number;
  status: string; sharePct: number;
}

async function buildTerritories(req: FastifyRequest): Promise<{ territories: TerritoryRow[]; totals: { count: number; tivMinor: number; pmlMinor: number; availableMinor: number; consumedMinor: number } }> {
  const ctx = authContext(req);
  return runAs(ctx, async (db) => {
    const exp = await db.query<{ country: string | null; items: string; tiv: string; pml: string }>(
      `select country, count(*)::int items, coalesce(sum(tiv_minor),0)::bigint tiv, coalesce(sum(pml_minor),0)::bigint pml
         from exposure_item group by country`,
    );
    const cap = await db.query<{ dim_key: string; available: string; consumed: string; warn: number }>(
      `select dim_key, coalesce(sum(available_minor),0)::bigint available, coalesce(sum(consumed_minor),0)::bigint consumed, max(warn_pct) warn
         from capacity_line where dimension='GEOGRAPHY' group by dim_key`,
    );
    const capByKey = new Map(cap.rows.map((c) => [c.dim_key, c]));
    const codes = new Set<string>();
    for (const e of exp.rows) if (e.country) codes.add(e.country);
    for (const c of cap.rows) codes.add(c.dim_key);

    const totalTiv = exp.rows.reduce((a, e) => a + Number(e.tiv), 0);
    const rows: TerritoryRow[] = [];
    for (const code of codes) {
      const e = exp.rows.find((x) => x.country === code);
      const c = capByKey.get(code);
      const available = Number(c?.available ?? 0), consumed = Number(c?.consumed ?? 0);
      const util = capacityUtilisation({ dimension: 'GEOGRAPHY', dimKey: code, availableMinor: available, consumedMinor: consumed, warnPct: c?.warn ?? 80 });
      const tiv = Number(e?.tiv ?? 0);
      rows.push({
        code, name: territoryName(code), items: Number(e?.items ?? 0),
        tivMinor: tiv, pmlMinor: Number(e?.pml ?? 0),
        availableMinor: available, consumedMinor: consumed, remainingMinor: util.remainingMinor,
        utilisationPct: util.utilisationPct, status: util.status,
        sharePct: totalTiv > 0 ? Math.round((tiv / totalTiv) * 1000) / 10 : 0,
      });
    }
    rows.sort((a, b) => b.tivMinor - a.tivMinor || b.consumedMinor - a.consumedMinor);
    return {
      territories: rows,
      totals: {
        count: rows.length, tivMinor: totalTiv, pmlMinor: exp.rows.reduce((a, e) => a + Number(e.pml), 0),
        availableMinor: cap.rows.reduce((a, c) => a + Number(c.available), 0),
        consumedMinor: cap.rows.reduce((a, c) => a + Number(c.consumed), 0),
      },
    };
  });
}

export async function territoriesModule(app: FastifyInstance): Promise<void> {
  app.get('/api/territories', { preHandler: requirePermission('exposure:read') }, async (req) => buildTerritories(req));

  app.get('/api/territories/export.csv', { preHandler: requirePermission('exposure:read') }, async (req, reply) => {
    const { territories } = await buildTerritories(req);
    const csv = toCsv(
      ['Territory', 'Code', 'Exposure items', 'TIV (major)', 'PML (major)', 'Capacity available (major)', 'Consumed (major)', 'Remaining (major)', 'Utilisation %', 'Status', 'TIV share %'],
      territories.map((t) => [t.name, t.code, t.items, majorFromMinor(t.tivMinor), majorFromMinor(t.pmlMinor), majorFromMinor(t.availableMinor), majorFromMinor(t.consumedMinor), majorFromMinor(t.remainingMinor), t.utilisationPct, t.status, t.sharePct]),
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="territories.csv"');
    return csv;
  });
}
