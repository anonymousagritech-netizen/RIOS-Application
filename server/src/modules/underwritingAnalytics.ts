/**
 * Underwriting analytics (brief §13 / §30): portfolio, catastrophe and risk views
 * over the submission book. Aggregation lives in SQL; the catastrophe shapes (PML,
 * AAL, EP curve, TVaR) come from the @rios/domain CAT model adapter - the default
 * mock provider today, a licensed RMS/AIR adapter later behind the same interface.
 *
 * Read-only, gated on treaty:read, tenant-isolated via runAs.
 */

import type { FastifyInstance } from 'fastify';
import { defaultCatModel, tvarFromEpCurve, RETURN_PERIODS } from '@rios/domain';
import { runAs } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

export async function underwritingAnalyticsModule(app: FastifyInstance): Promise<void> {
  // ---- Portfolio analytics -------------------------------------------------
  app.get('/api/underwriting/analytics/portfolio', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const byStructure = await db.query(
        `select coalesce(structure, kind) as key, count(*)::int as n,
                coalesce(sum(est_premium_minor),0)::bigint as epi
           from submission group by coalesce(structure, kind) order by n desc`,
      );
      const byLob = await db.query(
        `select coalesce(line_of_business,'unspecified') as key, count(*)::int as n,
                coalesce(sum(est_premium_minor),0)::bigint as epi
           from submission group by coalesce(line_of_business,'unspecified') order by n desc`,
      );
      const byBand = await db.query(
        `select coalesce(risk_band,'UNSCORED') as key, count(*)::int as n
           from submission group by coalesce(risk_band,'UNSCORED')`,
      );
      const byCedent = await db.query(
        `select coalesce(p.short_name, p.legal_name, 'Unknown') as key, count(*)::int as n,
                coalesce(sum(s.est_premium_minor),0)::bigint as epi
           from submission s left join party p on p.id = s.cedent_party_id
          group by coalesce(p.short_name, p.legal_name, 'Unknown') order by epi desc limit 10`,
      );
      const totals = await db.query<{ total: number; epi: number; avg_score: number }>(
        `select count(*)::int as total, coalesce(sum(est_premium_minor),0)::bigint as epi,
                coalesce(round(avg(risk_score)),0)::int as avg_score from submission`,
      );
      return {
        totalSubmissions: totals.rows[0]!.total,
        totalEpiMinor: Number(totals.rows[0]!.epi),
        avgRiskScore: totals.rows[0]!.avg_score,
        byStructure: byStructure.rows.map((r) => ({ ...r, epi: Number(r.epi) })),
        byLineOfBusiness: byLob.rows.map((r) => ({ ...r, epi: Number(r.epi) })),
        byRiskBand: byBand.rows,
        topCedents: byCedent.rows.map((r) => ({ ...r, epi: Number(r.epi) })),
      };
    });
  });

  // ---- Risk analytics (band distribution + high-risk queue) ----------------
  app.get('/api/underwriting/analytics/risk', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const dist = await db.query(
        `select coalesce(risk_band,'UNSCORED') as band, count(*)::int as n from submission group by coalesce(risk_band,'UNSCORED')`,
      );
      // A structure × band heatmap.
      const heat = await db.query(
        `select coalesce(structure, kind) as structure, coalesce(risk_band,'UNSCORED') as band, count(*)::int as n
           from submission group by coalesce(structure, kind), coalesce(risk_band,'UNSCORED')`,
      );
      const highRisk = await db.query(
        `select s.id, s.reference, s.title, s.risk_score as "riskScore", s.risk_band as "riskBand",
                s.stage, s.est_premium_minor as "estPremiumMinor", s.currency, p.short_name as "cedentName"
           from submission s left join party p on p.id = s.cedent_party_id
          where s.risk_band in ('ELEVATED','HIGH') and s.stage not in ('BOUND','DECLINED','LAPSED')
          order by s.risk_score desc nulls last limit 15`,
      );
      return {
        distribution: dist.rows,
        heatmap: heat.rows,
        highRisk: highRisk.rows.map((r) => ({ ...r, estPremiumMinor: r.estPremiumMinor == null ? null : Number(r.estPremiumMinor) })),
      };
    });
  });

  // ---- Catastrophe analytics (accumulation + PML/AAL/EP via CAT adapter) ---
  app.get('/api/underwriting/analytics/cat', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      // Aggregate cat-exposed exposure by territory (a proxy for peril/zone). Use
      // the layer limit where present, else the sum insured.
      const { rows } = await db.query<{ zone: string; exposure: number; n: number }>(
        `select coalesce(nullif(territory,''),'Unzoned') as zone,
                coalesce(sum(coalesce(limit_minor, sum_insured_minor, 0)),0)::bigint as exposure,
                count(*)::int as n
           from submission
          where cat_exposed = true and stage not in ('DECLINED','LAPSED')
          group by coalesce(nullif(territory,''),'Unzoned')
          order by exposure desc`,
      );
      const zones = rows.map((r) => {
        const exposure = Number(r.exposure);
        const model = defaultCatModel.run({ aggregateExposureMinor: exposure, peril: perilForZone(r.zone) });
        return {
          zone: r.zone,
          submissions: r.n,
          aggregateExposureMinor: exposure,
          peril: model.peril,
          aalMinor: model.aalMinor,
          pmlMinor: model.pmlMinor,
          epCurve: model.epCurve,
          tvar99Minor: tvarFromEpCurve(model.epCurve, 0.99),
        };
      });
      // Book-level roll-up on total cat-exposed aggregate.
      const totalExposure = zones.reduce((a, z) => a + z.aggregateExposureMinor, 0);
      const book = defaultCatModel.run({ aggregateExposureMinor: totalExposure, peril: 'HURRICANE' });
      return {
        provider: book.provider,
        returnPeriods: RETURN_PERIODS,
        totalExposureMinor: totalExposure,
        totalAalMinor: zones.reduce((a, z) => a + z.aalMinor, 0),
        bookPmlMinor: book.pmlMinor,
        bookEpCurve: book.epCurve,
        bookTvar99Minor: tvarFromEpCurve(book.epCurve, 0.99),
        zones,
      };
    });
  });
}

/** Map a free-text territory to a modelled peril (until real geocoding). */
function perilForZone(zone: string): string {
  const z = zone.toLowerCase();
  if (/japan|chile|california|turkey|quake|earthquake|nz|new zealand/.test(z)) return 'EARTHQUAKE';
  if (/flood|monsoon|thailand|bangladesh/.test(z)) return 'FLOOD';
  if (/europe|uk|germany|wind|storm/.test(z)) return 'WINDSTORM';
  if (/fire|wildfire|australia/.test(z)) return 'WILDFIRE';
  return 'HURRICANE';
}
