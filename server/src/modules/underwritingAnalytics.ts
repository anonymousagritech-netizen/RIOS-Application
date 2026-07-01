/**
 * Underwriting analytics (brief §13 / §30): portfolio, catastrophe and risk views
 * over the submission book. Aggregation lives in SQL; the catastrophe shapes (PML,
 * AAL, EP curve, TVaR) come from the @rios/domain CAT model adapter - the default
 * mock provider today, a licensed RMS/AIR adapter later behind the same interface.
 *
 * Read-only, gated on treaty:read, tenant-isolated via runAs.
 */

import type { FastifyInstance } from 'fastify';
import {
  defaultCatModel, tvarFromEpCurve, RETURN_PERIODS, renewalBook, renewalRateChangePct,
  lossRatioPct, frequencySeverity, technicalAccount,
} from '@rios/domain';
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

  // ---- Renewal pipeline ----------------------------------------------------
  // Submissions that renew a prior submission (or carry an expiring premium):
  // retention by count + premium, average rate change, and the renewal list.
  app.get('/api/underwriting/analytics/renewal', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const { rows } = await db.query<{
        id: string; reference: string; title: string; stage: string; currency: string;
        cedentName: string | null; expiring_premium_minor: number | null;
        est_premium_minor: number | null; target_premium_minor: number | null;
      }>(
        `select s.id, s.reference, s.title, s.stage, s.currency,
                ced.short_name as "cedentName",
                s.expiring_premium_minor, s.est_premium_minor, s.target_premium_minor
           from submission s
           left join party ced on ced.id = s.cedent_party_id
          where s.renewal_of_id is not null or s.expiring_premium_minor is not null
          order by s.created_at desc`,
      );
      const bookRows = rows.map((r) => ({
        stage: r.stage,
        expiringPremiumMinor: Number(r.expiring_premium_minor ?? 0),
        renewalPremiumMinor: Number(r.target_premium_minor ?? r.est_premium_minor ?? 0),
      }));
      const book = renewalBook(bookRows);
      const renewals = rows.map((r) => {
        const renewalPremium = Number(r.target_premium_minor ?? r.est_premium_minor ?? 0);
        const expiring = Number(r.expiring_premium_minor ?? 0);
        return {
          id: r.id, reference: r.reference, title: r.title, stage: r.stage, currency: r.currency,
          cedentName: r.cedentName, expiringPremiumMinor: expiring, renewalPremiumMinor: renewalPremium,
          rateChangePct: renewalRateChangePct(renewalPremium, expiring),
        };
      });
      return { book, renewals };
    });
  });

  // ---- Claims integration dashboard ----------------------------------------
  // Loss ratio, frequency/severity, development-by-year and the technical
  // account, from the claim book joined to contracts. Ties underwriting to claims.
  app.get('/api/underwriting/analytics/claims', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const tot = await db.query<{ n: string; incurred: string; paid: string; outstanding: string; recovered: string }>(
        `select count(*)::int n,
                coalesce(sum(gross_loss_minor),0)::bigint incurred,
                coalesce(sum(paid_minor),0)::bigint paid,
                coalesce(sum(outstanding_minor),0)::bigint outstanding,
                coalesce(sum(recovered_minor),0)::bigint recovered
           from claim where not is_deleted`,
      );
      const t = tot.rows[0]!;
      const prem = await db.query<{ premium: string }>(`select coalesce(sum(amount_minor),0)::bigint premium from financial_event where event_type ilike '%premium%'`);
      const contracts = await db.query<{ n: string }>(`select count(*)::int n from contract where not is_deleted`);
      const byLine = await db.query<{ key: string; incurred: string; n: string }>(
        `select coalesce(ct.line_of_business,'Unspecified') key, coalesce(sum(c.gross_loss_minor),0)::bigint incurred, count(*)::int n
           from claim c join contract ct on ct.id = c.contract_id where not c.is_deleted
          group by coalesce(ct.line_of_business,'Unspecified') order by incurred desc`,
      );
      const byStatus = await db.query<{ key: string; n: string; incurred: string }>(
        `select status key, count(*)::int n, coalesce(sum(gross_loss_minor),0)::bigint incurred from claim where not is_deleted group by status order by n desc`,
      );
      const byYear = await db.query<{ yr: string; incurred: string; n: string }>(
        `select to_char(coalesce(loss_date, notified_date),'YYYY') yr, coalesce(sum(gross_loss_minor),0)::bigint incurred, count(*)::int n
           from claim where not is_deleted group by 1 order by 1`,
      );
      const top = await db.query(
        `select c.id, c.reference, c.description, to_char(c.loss_date,'YYYY-MM-DD') as "lossDate", c.status, c.currency,
                c.gross_loss_minor as "grossLossMinor", c.outstanding_minor as "outstandingMinor",
                ced.short_name as "cedentName"
           from claim c join contract ct on ct.id = c.contract_id left join party ced on ced.id = ct.cedent_party_id
          where not c.is_deleted order by c.gross_loss_minor desc limit 10`,
      );
      const incurred = Number(t.incurred), premium = Number(prem.rows[0]!.premium);
      const commission = Math.round(premium * 0.2);
      return {
        totals: { claimCount: Number(t.n), incurredMinor: incurred, paidMinor: Number(t.paid), outstandingMinor: Number(t.outstanding), recoveredMinor: Number(t.recovered), premiumMinor: premium },
        lossRatioPct: lossRatioPct(incurred, premium),
        frequencySeverity: frequencySeverity(Number(t.n), Number(contracts.rows[0]!.n), incurred),
        technicalAccount: technicalAccount({ premiumMinor: premium, commissionMinor: commission, claimsMinor: incurred }),
        byLine: byLine.rows.map((r) => ({ key: r.key, incurredMinor: Number(r.incurred), n: Number(r.n) })),
        byStatus: byStatus.rows.map((r) => ({ key: r.key, n: Number(r.n), incurredMinor: Number(r.incurred) })),
        byYear: byYear.rows.map((r) => ({ key: r.yr, incurredMinor: Number(r.incurred), n: Number(r.n) })),
        topClaims: top.rows,
      };
    });
  });

  // ---- Finance integration dashboard ---------------------------------------
  // Premium / commission / claims cashflow and the technical account, from the
  // financial_event ledger. Ties underwriting to finance & accounting.
  app.get('/api/underwriting/analytics/finance', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const agg = await db.query<{ premium: string; commission: string; claims: string; other: string }>(
        `select
            coalesce(sum(amount_minor) filter (where event_type ilike '%premium%'),0)::bigint premium,
            coalesce(sum(amount_minor) filter (where event_type ilike '%commission%'),0)::bigint commission,
            coalesce(sum(amount_minor) filter (where claim_id is not null or event_type ilike '%claim%' or event_type ilike '%loss%'),0)::bigint claims,
            coalesce(sum(amount_minor) filter (where event_type not ilike '%premium%' and event_type not ilike '%commission%' and claim_id is null and event_type not ilike '%claim%' and event_type not ilike '%loss%'),0)::bigint other
           from financial_event`,
      );
      const a = agg.rows[0]!;
      const byType = await db.query<{ key: string; amount: string; n: string }>(
        `select event_type key, coalesce(sum(amount_minor),0)::bigint amount, count(*)::int n from financial_event group by event_type order by amount desc limit 12`,
      );
      const cashflow = await db.query<{ mon: string; inflow: string; outflow: string }>(
        `select to_char(booked_at,'YYYY-MM') mon,
                coalesce(sum(amount_minor) filter (where direction='CR'),0)::bigint inflow,
                coalesce(sum(amount_minor) filter (where direction='DR'),0)::bigint outflow
           from financial_event group by 1 order by 1 desc limit 12`,
      );
      const premium = Number(a.premium), commission = Number(a.commission), claims = Number(a.claims);
      return {
        technicalAccount: technicalAccount({ premiumMinor: premium, commissionMinor: commission, claimsMinor: claims }),
        totals: { premiumMinor: premium, commissionMinor: commission, claimsMinor: claims, otherMinor: Number(a.other) },
        byType: byType.rows.map((r) => ({ key: r.key, amountMinor: Number(r.amount), n: Number(r.n) })),
        cashflow: cashflow.rows.reverse().map((r) => ({ key: r.mon, inflowMinor: Number(r.inflow), outflowMinor: Number(r.outflow), netMinor: Number(r.inflow) - Number(r.outflow) })),
      };
    });
  });

  // ---- Retrocession dashboard ----------------------------------------------
  // Outwards / retrocession contracts: ceded premium, layers, recoveries, mix.
  // Ties underwriting to retrocession, claims and recoveries.
  app.get('/api/underwriting/analytics/retro', { preHandler: requirePermission('treaty:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const summary = await db.query<{ n: string; layers: string }>(
        `select count(distinct ct.id)::int n, count(cl.id)::int layers
           from contract ct left join contract_layer cl on cl.contract_id = ct.id
          where not ct.is_deleted and (ct.contract_kind = 'RETROCESSION' or ct.direction = 'OUTWARDS')`,
      );
      const ceded = await db.query<{ premium: string }>(
        `select coalesce(sum(fe.amount_minor),0)::bigint premium
           from financial_event fe join contract ct on ct.id = fe.contract_id
          where fe.event_type ilike '%premium%' and (ct.contract_kind='RETROCESSION' or ct.direction='OUTWARDS')`,
      );
      const recoveries = await db.query<{ recovered: string; outstanding: string }>(
        `select coalesce(sum(c.recovered_minor),0)::bigint recovered, coalesce(sum(c.outstanding_minor),0)::bigint outstanding
           from claim c join contract ct on ct.id = c.contract_id
          where not c.is_deleted and (ct.contract_kind='RETROCESSION' or ct.direction='OUTWARDS')`,
      );
      const byStructure = await db.query<{ key: string; n: string }>(
        `select coalesce(np_type, proportional_type, basis, 'Other') key, count(*)::int n
           from contract where not is_deleted and (contract_kind='RETROCESSION' or direction='OUTWARDS')
          group by 1 order by n desc`,
      );
      const programmes = await db.query(
        `select ct.id, ct.reference, ct.name, ct.basis, ct.np_type as "npType", ct.status, ct.currency,
                to_char(ct.period_start,'YYYY-MM-DD') as "periodStart", to_char(ct.period_end,'YYYY-MM-DD') as "periodEnd"
           from contract ct where not ct.is_deleted and (ct.contract_kind='RETROCESSION' or ct.direction='OUTWARDS')
          order by ct.period_start desc nulls last limit 20`,
      );
      return {
        summary: { programmes: Number(summary.rows[0]!.n), layers: Number(summary.rows[0]!.layers), cededPremiumMinor: Number(ceded.rows[0]!.premium), recoveredMinor: Number(recoveries.rows[0]!.recovered), outstandingMinor: Number(recoveries.rows[0]!.outstanding) },
        byStructure: byStructure.rows.map((r) => ({ key: r.key, n: Number(r.n) })),
        programmes: programmes.rows,
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
