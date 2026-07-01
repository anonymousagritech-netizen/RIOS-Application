/**
 * Executive Intelligence (brief §30). Boardroom dashboards for eight personas
 * (CEO, CFO, Chief Underwriter, Operations, Finance, Claims, Portfolio, Risk),
 * each a pack of KPI cards + charts aggregated LIVE across every module -
 * treaties, financial events, claims, exposure, capacity, tasks, ledger. This
 * is the integration surface: no persona owns its own data, it reads the whole
 * platform. Combined/loss ratios come from @rios/domain (technicalAccount);
 * portfolio concentration from territoryBook.
 *
 * Read-only; gated on reporting:read. Money is integer minor units; KPIs are
 * returned with a `format` hint and charts as {label,value,status?} series.
 */

import type { FastifyInstance } from 'fastify';
import { technicalAccount, territoryBook, type RiskGrade } from '@rios/domain';
import { runAs, type Db } from '../db.js';
import { authContext, requirePermission } from '../auth.js';

type Fmt = 'MONEY' | 'INT' | 'PCT';
interface Kpi { label: string; value: number; format: Fmt; hint?: string; intent?: 'good' | 'warn' | 'bad' }
interface ChartDatum { label: string; value: number; status?: string }
interface Chart { title: string; kind: 'bar' | 'donut'; data: ChartDatum[]; money?: boolean }
interface Pack { kpis: Kpi[]; charts: Chart[] }

const n = (v: unknown) => Number(v ?? 0);

async function gather(db: Db) {
  const q = <T extends Record<string, unknown>>(sql: string) => db.query<T>(sql).then((r) => r.rows);

  const fin = (await q<{ gwp: string; commission: string; instalment: string }>(
    `select coalesce(sum(amount_minor) filter (where event_type ilike '%premium%'),0)::bigint gwp,
            coalesce(sum(amount_minor) filter (where event_type ilike '%commission%'),0)::bigint commission,
            coalesce(sum(amount_minor) filter (where event_type ilike '%instalment%'),0)::bigint instalment
       from financial_event`))[0] ?? { gwp: '0', commission: '0', instalment: '0' };
  const cl = (await q<{ open: number; total: number; outstanding: string; incurred: string; paid: string }>(
    `select count(*) filter (where status not in ('SETTLED','CLOSED'))::int open,
            count(*)::int total,
            coalesce(sum(outstanding_minor),0)::bigint outstanding,
            coalesce(sum(gross_loss_minor),0)::bigint incurred,
            coalesce(sum(gross_loss_minor) filter (where status in ('SETTLED','CLOSED')),0)::bigint paid
       from claim where not is_deleted`))[0] ?? { open: 0, total: 0, outstanding: '0', incurred: '0', paid: '0' };
  const ct = (await q<{ total: number; bound: number; draft: number }>(
    `select count(*)::int total,
            count(*) filter (where status in ('BOUND','ACTIVE'))::int bound,
            count(*) filter (where status = 'DRAFT')::int draft
       from contract where not is_deleted`))[0] ?? { total: 0, bound: 0, draft: 0 };
  const treatiesByStatus = await q<{ label: string; value: number }>(
    `select status label, count(*)::int value from contract where not is_deleted group by status order by value desc`);
  const premiumByLob = await q<{ label: string; value: string }>(
    `select coalesce(c.line_of_business,'Other') label, coalesce(sum(fe.amount_minor),0)::bigint value
       from financial_event fe join contract c on c.id = fe.contract_id
      where fe.event_type ilike '%premium%' group by 1 order by 2 desc limit 8`);
  const subs = await q<{ label: string; value: number }>(
    `select stage label, count(*)::int value from submission group by stage order by value desc`);
  const cap = (await q<{ available: string; consumed: string; lines: number; breaches: number }>(
    `select coalesce(sum(available_minor),0)::bigint available,
            coalesce(sum(consumed_minor),0)::bigint consumed,
            count(*)::int lines,
            count(*) filter (where available_minor > 0 and consumed_minor::numeric / nullif(available_minor,0) >= 1.0)::int breaches
       from capacity_line`))[0] ?? { available: '0', consumed: '0', lines: 0, breaches: 0 };
  const capByDim = await q<{ label: string; value: string }>(
    `select dimension label, coalesce(sum(consumed_minor),0)::bigint value from capacity_line group by dimension order by 2 desc`);
  const tk = (await q<{ open: number; overdue: number; done: number; total: number }>(
    `select count(*) filter (where status not in ('DONE','CANCELLED'))::int open,
            count(*) filter (where status not in ('DONE','CANCELLED') and due_at is not null and due_at < now())::int overdue,
            count(*) filter (where status = 'DONE')::int done,
            count(*)::int total from task`))[0] ?? { open: 0, overdue: 0, done: 0, total: 0 };
  const tasksByStatus = await q<{ label: string; value: number }>(
    `select status label, count(*)::int value from task group by status order by value desc`);
  const tasksByKind = await q<{ label: string; value: number }>(
    `select kind label, count(*)::int value from task group by kind order by value desc limit 8`);
  const gl = (await q<{ statements: number; journals: number; postings: string }>(
    `select (select count(*) from statement_of_account)::int statements,
            (select count(*) from journal)::int journals,
            (select coalesce(sum(debit_minor),0) from ledger_posting)::bigint postings`))[0] ?? { statements: 0, journals: 0, postings: '0' };
  const finByType = await q<{ label: string; value: string }>(
    `select event_type label, coalesce(sum(amount_minor),0)::bigint value from financial_event group by 1 order by 2 desc limit 8`);
  const claimsByStatus = await q<{ label: string; value: number }>(
    `select status label, count(*)::int value from claim where not is_deleted group by status order by value desc`);
  const claimsByLob = await q<{ label: string; value: string }>(
    `select coalesce(c.line_of_business,'Other') label, coalesce(sum(cl.gross_loss_minor),0)::bigint value
       from claim cl left join contract c on c.id = cl.contract_id where not cl.is_deleted group by 1 order by 2 desc limit 8`);
  const expByCountry = await q<{ code: string; name: string; tiv: string; pml: string; items: number; grade: string | null }>(
    `select ei.country code, coalesce(t.name, ei.country) name,
            coalesce(sum(ei.tiv_minor),0)::bigint tiv, coalesce(sum(ei.pml_minor),0)::bigint pml,
            count(*)::int items, max(t.risk_grade) grade
       from exposure_item ei left join territory t on t.kind='COUNTRY' and t.code = ei.country
      where ei.country is not null group by ei.country, t.name order by tiv desc`);
  const expByPeril = await q<{ label: string; value: string }>(
    `select coalesce(peril,'Other') label, coalesce(sum(tiv_minor),0)::bigint value from exposure_item group by 1 order by 2 desc`);

  return { fin, cl, ct, treatiesByStatus, premiumByLob, subs, cap, capByDim, tk, tasksByStatus, tasksByKind, gl, finByType, claimsByStatus, claimsByLob, expByCountry, expByPeril };
}

const STATUS_COLOR: Record<string, string> = { BOUND: 'green', ACTIVE: 'green', DRAFT: 'slate', SUBMISSION: 'blue', SETTLED: 'green', NOTIFIED: 'amber', RESERVED: 'orange', OPEN: 'blue', IN_PROGRESS: 'violet', DONE: 'green' };
const moneyChart = (title: string, rows: { label: string; value: string }[]): Chart => ({ title, kind: 'bar', money: true, data: rows.map((r) => ({ label: r.label, value: n(r.value) })) });

export async function executiveModule(app: FastifyInstance): Promise<void> {
  app.get('/api/executive', { preHandler: requirePermission('reporting:read') }, async (req) => {
    const ctx = authContext(req);
    return runAs(ctx, async (db) => {
      const g = await gather(db);

      const gwp = n(g.fin.gwp), commission = n(g.fin.commission), incurred = n(g.cl.incurred);
      const ta = technicalAccount({ premiumMinor: gwp, commissionMinor: commission, claimsMinor: incurred });
      const available = n(g.cap.available), consumed = n(g.cap.consumed);
      const capUtil = available > 0 ? Math.round((consumed / available) * 1000) / 10 : 0;

      const book = territoryBook(g.expByCountry.map((r) => ({
        code: r.code, name: r.name, tivMinor: n(r.tiv), pmlMinor: n(r.pml), itemCount: r.items,
        riskGrade: (r.grade as RiskGrade | null) ?? null,
      })));

      const combinedIntent = ta.combinedRatioPct <= 100 ? 'good' : ta.combinedRatioPct <= 110 ? 'warn' : 'bad';
      const statusChart = (title: string, rows: { label: string; value: number }[]): Chart =>
        ({ title, kind: 'donut', data: rows.map((r) => ({ label: r.label, value: r.value, status: STATUS_COLOR[r.label] ? r.label : undefined })) });
      const statusMeta = STATUS_COLOR;

      const packs: Record<string, Pack> = {
        CEO: {
          kpis: [
            { label: 'Gross written premium', value: gwp, format: 'MONEY' },
            { label: 'Combined ratio', value: ta.combinedRatioPct, format: 'PCT', intent: combinedIntent, hint: 'Loss + commission + expense' },
            { label: 'Technical result', value: ta.technicalResultMinor, format: 'MONEY', intent: ta.technicalResultMinor >= 0 ? 'good' : 'bad' },
            { label: 'Active treaties', value: g.ct.bound, format: 'INT', hint: `${g.ct.total} on the book` },
            { label: 'Open claims', value: g.cl.open, format: 'INT' },
          ],
          charts: [statusChart('Treaties by status', g.treatiesByStatus), moneyChart('Premium by line of business', g.premiumByLob)],
        },
        CFO: {
          kpis: [
            { label: 'Gross written premium', value: gwp, format: 'MONEY' },
            { label: 'Commission paid', value: commission, format: 'MONEY' },
            { label: 'Outstanding claims', value: n(g.cl.outstanding), format: 'MONEY', intent: 'warn' },
            { label: 'Expense ratio', value: ta.expenseRatioPct, format: 'PCT' },
            { label: 'Technical result', value: ta.technicalResultMinor, format: 'MONEY', intent: ta.technicalResultMinor >= 0 ? 'good' : 'bad' },
          ],
          charts: [moneyChart('Financial events by type', g.finByType), moneyChart('Premium by line of business', g.premiumByLob)],
        },
        CHIEF_UW: {
          kpis: [
            { label: 'Treaties bound', value: g.ct.bound, format: 'INT' },
            { label: 'Submissions in pipeline', value: n(g.subs.find((s) => s.label === 'SUBMISSION')?.value ?? 0), format: 'INT' },
            { label: 'Loss ratio', value: ta.lossRatioPct, format: 'PCT', intent: ta.lossRatioPct <= 70 ? 'good' : ta.lossRatioPct <= 100 ? 'warn' : 'bad' },
            { label: 'Capacity utilisation', value: capUtil, format: 'PCT', intent: capUtil < 80 ? 'good' : capUtil < 100 ? 'warn' : 'bad' },
            { label: 'Capacity breaches', value: g.cap.breaches, format: 'INT', intent: g.cap.breaches ? 'bad' : 'good' },
          ],
          charts: [statusChart('Submission pipeline', g.subs), moneyChart('Consumed capacity by dimension', g.capByDim)],
        },
        OPERATIONS: {
          kpis: [
            { label: 'Open tasks', value: g.tk.open, format: 'INT' },
            { label: 'Overdue tasks', value: g.tk.overdue, format: 'INT', intent: g.tk.overdue ? 'bad' : 'good' },
            { label: 'Completed tasks', value: g.tk.done, format: 'INT', intent: 'good' },
            { label: 'SLA compliance', value: g.tk.total ? Math.round(((g.tk.total - g.tk.overdue) / g.tk.total) * 1000) / 10 : 100, format: 'PCT', intent: g.tk.overdue ? 'warn' : 'good' },
          ],
          charts: [statusChart('Tasks by status', g.tasksByStatus), { title: 'Tasks by kind', kind: 'bar', data: g.tasksByKind.map((r) => ({ label: r.label, value: r.value })) }],
        },
        FINANCE: {
          kpis: [
            { label: 'Statements of account', value: g.gl.statements, format: 'INT' },
            { label: 'Journals posted', value: g.gl.journals, format: 'INT' },
            { label: 'Ledger debits', value: n(g.gl.postings), format: 'MONEY' },
            { label: 'Instalment premium', value: n(g.fin.instalment), format: 'MONEY' },
          ],
          charts: [moneyChart('Financial events by type', g.finByType)],
        },
        CLAIMS: {
          kpis: [
            { label: 'Open claims', value: g.cl.open, format: 'INT' },
            { label: 'Outstanding reserve', value: n(g.cl.outstanding), format: 'MONEY', intent: 'warn' },
            { label: 'Incurred (gross)', value: incurred, format: 'MONEY' },
            { label: 'Paid / settled', value: n(g.cl.paid), format: 'MONEY' },
            { label: 'Loss ratio', value: ta.lossRatioPct, format: 'PCT', intent: ta.lossRatioPct <= 70 ? 'good' : ta.lossRatioPct <= 100 ? 'warn' : 'bad' },
          ],
          charts: [statusChart('Claims by status', g.claimsByStatus), moneyChart('Incurred by line of business', g.claimsByLob)],
        },
        PORTFOLIO: {
          kpis: [
            { label: 'Total insured value', value: book.totalTivMinor, format: 'MONEY' },
            { label: 'Modelled PML', value: book.totalPmlMinor, format: 'MONEY' },
            { label: 'Peak concentration', value: book.peakTivSharePct, format: 'PCT', hint: book.peakTivCode ?? undefined, intent: book.peakTivSharePct > 50 ? 'warn' : 'good' },
            { label: 'PML ratio', value: book.bookPmlRatioPct, format: 'PCT' },
            { label: 'Countries', value: book.territoryCount, format: 'INT' },
          ],
          charts: [moneyChart('Exposure by country', g.expByCountry.map((r) => ({ label: r.code, value: r.tiv }))), moneyChart('Exposure by peril', g.expByPeril)],
        },
        RISK: {
          kpis: [
            { label: 'High-risk territories', value: book.highRiskCount, format: 'INT', intent: book.highRiskCount ? 'warn' : 'good' },
            { label: 'Capacity breaches', value: g.cap.breaches, format: 'INT', intent: g.cap.breaches ? 'bad' : 'good' },
            { label: 'Modelled PML', value: book.totalPmlMinor, format: 'MONEY' },
            { label: 'Peak concentration', value: book.peakTivSharePct, format: 'PCT', intent: book.peakTivSharePct > 50 ? 'warn' : 'good' },
            { label: 'Combined ratio', value: ta.combinedRatioPct, format: 'PCT', intent: combinedIntent },
          ],
          charts: [
            { title: 'Country risk score', kind: 'bar', data: book.rows.map((r) => ({ label: r.code, value: r.riskScore, status: r.band })) },
            moneyChart('Exposure by peril', g.expByPeril),
          ],
        },
      };

      return {
        personas: [
          { key: 'CEO', label: 'CEO', tagline: 'Group performance & result' },
          { key: 'CFO', label: 'CFO', tagline: 'Premium, cost & technical result' },
          { key: 'CHIEF_UW', label: 'Chief Underwriter', tagline: 'Pipeline, loss ratio & capacity' },
          { key: 'OPERATIONS', label: 'Operations', tagline: 'Tasks, SLA & throughput' },
          { key: 'FINANCE', label: 'Finance', tagline: 'Ledger, statements & cash' },
          { key: 'CLAIMS', label: 'Claims', tagline: 'Reserves, incurred & loss ratio' },
          { key: 'PORTFOLIO', label: 'Portfolio', tagline: 'TIV, PML & diversification' },
          { key: 'RISK', label: 'Risk', tagline: 'Accumulation, breaches & PML' },
        ],
        statusMeta,
        packs,
      };
    });
  });
}
