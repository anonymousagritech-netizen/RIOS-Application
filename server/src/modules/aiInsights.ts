/**
 * AI Platform - per-domain insights (brief §31). Deterministic, grounded
 * "AI insights" for each domain (underwriting, claims, finance, portfolio,
 * exposure): live metrics classified into ranked observations with a plain-
 * language recommendation. No LLM - the same data always yields the same
 * insights, so the surface is auditable and works with AI disabled (ADR 0005).
 * Combined/loss ratios from @rios/domain (technicalAccount); concentration from
 * territoryBook; severity + ranking from @rios/domain/insight.
 *
 * Read-only; gated on authentication.
 */

import type { FastifyInstance } from 'fastify';
import {
  technicalAccount, territoryBook, type RiskGrade,
  severityLowerBetter, severityHigherBetter, severityFromCount, rankInsights, insightSummary, type Insight,
} from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

const n = (v: unknown) => Number(v ?? 0);
const pct = (v: number) => `${Math.round(v * 10) / 10}%`;

async function metrics(db: Db) {
  const q = <T extends Record<string, unknown>>(sql: string) => db.query<T>(sql).then((r) => r.rows);
  const fin = (await q<{ gwp: string; commission: string }>(
    `select coalesce(sum(amount_minor) filter (where event_type ilike '%premium%'),0)::bigint gwp,
            coalesce(sum(amount_minor) filter (where event_type ilike '%commission%'),0)::bigint commission from financial_event`))[0] ?? { gwp: '0', commission: '0' };
  const cl = (await q<{ open: number; outstanding: string; incurred: string }>(
    `select count(*) filter (where status not in ('SETTLED','CLOSED'))::int open,
            coalesce(sum(outstanding_minor),0)::bigint outstanding,
            coalesce(sum(gross_loss_minor),0)::bigint incurred from claim where not is_deleted`))[0] ?? { open: 0, outstanding: '0', incurred: '0' };
  const cap = (await q<{ available: string; consumed: string; breaches: number }>(
    `select coalesce(sum(available_minor),0)::bigint available, coalesce(sum(consumed_minor),0)::bigint consumed,
            count(*) filter (where available_minor > 0 and consumed_minor::numeric/nullif(available_minor,0) >= 1.0)::int breaches from capacity_line`))[0] ?? { available: '0', consumed: '0', breaches: 0 };
  const subs = (await q<{ pipeline: number }>(`select count(*) filter (where stage='SUBMISSION')::int pipeline from submission`))[0] ?? { pipeline: 0 };
  const exp = await q<{ code: string; name: string; tiv: string; pml: string; items: number; grade: string | null }>(
    `select ei.country code, coalesce(t.name, ei.country) name, coalesce(sum(ei.tiv_minor),0)::bigint tiv,
            coalesce(sum(ei.pml_minor),0)::bigint pml, count(*)::int items, max(t.risk_grade) grade
       from exposure_item ei left join territory t on t.kind='COUNTRY' and t.code=ei.country
      where ei.country is not null group by ei.country, t.name`);
  const tasks = (await q<{ overdue: number }>(
    `select count(*) filter (where status not in ('done','skipped') and due_at is not null and due_at < now())::int overdue from workflow_task`))[0] ?? { overdue: 0 };
  return { fin, cl, cap, subs, exp, tasks };
}

export async function aiInsightsModule(app: FastifyInstance): Promise<void> {
  app.get('/api/ai/insights', { preHandler: requirePermission() }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const m = await metrics(db);
      const gwp = n(m.fin.gwp), commission = n(m.fin.commission), incurred = n(m.cl.incurred);
      const ta = technicalAccount({ premiumMinor: gwp, commissionMinor: commission, claimsMinor: incurred });
      const available = n(m.cap.available), consumed = n(m.cap.consumed);
      const util = available > 0 ? (consumed / available) * 100 : 0;
      const book = territoryBook(m.exp.map((r) => ({ code: r.code, name: r.name, tivMinor: n(r.tiv), pmlMinor: n(r.pml), itemCount: r.items, riskGrade: (r.grade as RiskGrade | null) ?? null })));

      const insights: Insight[] = [];
      const add = (i: Insight) => insights.push(i);

      // --- Underwriting ---
      add({
        domain: 'underwriting', severity: severityLowerBetter(ta.lossRatioPct, 70, 100),
        title: `Loss ratio at ${pct(ta.lossRatioPct)}`, metricLabel: 'Loss ratio', metricValue: pct(ta.lossRatioPct),
        detail: `Incurred losses are running at ${pct(ta.lossRatioPct)} of earned premium across the book.`,
        recommendation: ta.lossRatioPct > 100 ? 'Review pricing adequacy and loss-affected programmes before renewal.' : 'Loss experience is within appetite; hold current terms.',
      });
      add({
        domain: 'underwriting', severity: severityLowerBetter(util, 80, 100),
        title: `Capacity utilisation ${pct(util)}`, metricLabel: 'Utilisation', metricValue: pct(util),
        detail: `${pct(util)} of available capacity is consumed${m.cap.breaches ? `, with ${m.cap.breaches} line(s) in breach` : ''}.`,
        recommendation: util > 90 ? 'Free up or buy retro capacity before writing further peak-zone risk.' : 'Headroom remains for selective growth.',
      });
      if (m.subs.pipeline > 0) add({
        domain: 'underwriting', severity: 'INFO', title: `${m.subs.pipeline} submissions in the pipeline`,
        metricLabel: 'Pipeline', metricValue: String(m.subs.pipeline),
        detail: `${m.subs.pipeline} submission(s) are awaiting triage or quote.`,
        recommendation: 'Prioritise submissions nearing their quote-by date to protect the hit ratio.',
      });

      // --- Claims ---
      add({
        domain: 'claims', severity: severityFromCount(m.cl.open, 1, 25), title: `${m.cl.open} open claims`,
        metricLabel: 'Open claims', metricValue: String(m.cl.open),
        detail: `Outstanding reserve stands at ${(n(m.cl.outstanding) / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}.`,
        recommendation: m.cl.open > 25 ? 'Escalate the oldest reserves for review and possible commutation.' : 'Claims inventory is manageable at current staffing.',
      });

      // --- Finance ---
      add({
        domain: 'finance', severity: ta.technicalResultMinor >= 0 ? 'POSITIVE' : 'RISK',
        title: `Technical result ${(ta.technicalResultMinor / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}`,
        metricLabel: 'Combined ratio', metricValue: pct(ta.combinedRatioPct),
        detail: `Combined ratio is ${pct(ta.combinedRatioPct)} on gross written premium of ${(gwp / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}.`,
        recommendation: ta.combinedRatioPct > 100 ? 'The book is running at an underwriting loss — tighten terms and expenses.' : 'Underwriting is profitable; consider redeploying capital to growth lines.',
      });

      // --- Portfolio ---
      add({
        domain: 'portfolio', severity: severityLowerBetter(book.peakTivSharePct, 40, 60),
        title: `Peak concentration ${pct(book.peakTivSharePct)}${book.peakTivCode ? ` in ${book.peakTivCode}` : ''}`,
        metricLabel: 'Peak share', metricValue: pct(book.peakTivSharePct),
        detail: `The largest single territory holds ${pct(book.peakTivSharePct)} of total insured value.`,
        recommendation: book.peakTivSharePct > 50 ? 'Diversify or buy zonal retro to reduce single-territory accumulation.' : 'Diversification is healthy across territories.',
      });
      add({
        domain: 'portfolio', severity: severityLowerBetter(book.bookPmlRatioPct, 20, 35),
        title: `Modelled PML ratio ${pct(book.bookPmlRatioPct)}`, metricLabel: 'PML ratio', metricValue: pct(book.bookPmlRatioPct),
        detail: `Modelled PML is ${pct(book.bookPmlRatioPct)} of total insured value across the portfolio.`,
        recommendation: 'Validate against the latest cat model vendor view before the next treaty renewal.',
      });

      // --- Exposure ---
      add({
        domain: 'exposure', severity: severityFromCount(book.highRiskCount + m.cap.breaches, 1, 4),
        title: `${book.highRiskCount} high-risk territories`, metricLabel: 'High-risk zones', metricValue: String(book.highRiskCount),
        detail: `${book.highRiskCount} territory(ies) are graded HIGH or SEVERE${m.cap.breaches ? ` and ${m.cap.breaches} capacity line(s) breached` : ''}.`,
        recommendation: book.highRiskCount ? 'Cap new peak-peril exposure and confirm reinstatement cover is intact.' : 'No elevated accumulation flagged.',
      });
      if (m.tasks.overdue > 0) add({
        domain: 'operations', severity: severityFromCount(m.tasks.overdue, 1, 5),
        title: `${m.tasks.overdue} overdue workflow tasks`, metricLabel: 'Overdue tasks', metricValue: String(m.tasks.overdue),
        detail: `${m.tasks.overdue} workflow task(s) are past their SLA due date.`,
        recommendation: 'Reassign or escalate overdue tasks to restore SLA compliance.',
      });

      const ranked = rankInsights(insights);
      const domains = [...new Set(ranked.map((i) => i.domain))].map((domain) => ({
        domain, insights: ranked.filter((i) => i.domain === domain),
      }));
      return { summary: insightSummary(ranked), total: ranked.length, insights: ranked, domains };
    });
  });
}
