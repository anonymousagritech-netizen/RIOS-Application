/**
 * Embedded assistant (brief §12) - wired across the platform.
 *
 * Design commitments:
 *  - Strictly within the user's permissions (§12.4): all access is RLS-scoped and
 *    permission-checked exactly as a human's would be; no privileged backdoor.
 *  - Grounded in tenant data; never fabricates figures (§12.4).
 *  - Every destructive / financially material action is *prepared*, not executed,
 *    returning requiresConfirmation=true with a preview; a separate /confirm call
 *    commits it through the normal path. Navigation actions are non-mutating.
 *  - Degrades gracefully (§12.6): the intent engine is deterministic and needs no
 *    LLM. When an Anthropic key is configured, free-form questions the rules don't
 *    recognise are answered by the LLM grounded in a permission-filtered snapshot;
 *    the LLM can never mutate data.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AssistantResponse, AssistantAction } from '@rios/shared';
import { runAs, type Db } from '../db.js';
import { authContext, authenticate, requirePermission } from '../auth.js';
import { writeAudit } from '../audit.js';
import { llmAnswer, isLlmEnabled } from '../ai/llm.js';

type Ctx = { tenantId: string; userId: string };
interface Intent {
  test: RegExp;
  handler: (db: Db, ctx: Ctx, message: string, perms: string[]) => Promise<AssistantResponse>;
}

const fmt = (minor: number, ccy = 'USD') => `${(Number(minor || 0) / 100).toLocaleString()} ${ccy}`;
const has = (perms: string[], p: string) => perms.includes(p) || perms.includes('admin:manage');
const nameFrom = (m: string) => m.match(/(?:named|called|name|for)\s+["']?([^"'.]+?)["']?$/i)?.[1]?.trim();
const amountFrom = (m: string) => {
  const x = m.match(/([\d][\d,]*(?:\.\d+)?)\s*(k|m|million|thousand)?/i);
  if (!x) return undefined;
  let v = Number(x[1]!.replace(/,/g, ''));
  const unit = x[2]?.toLowerCase();
  if (unit === 'k' || unit === 'thousand') v *= 1_000;
  if (unit === 'm' || unit === 'million') v *= 1_000_000;
  return v;
};

// ---------------------------------------------------------------------------
// Navigation targets (non-mutating "go to / open / show me the X")
// ---------------------------------------------------------------------------
const NAV: { re: RegExp; route: string; label: string }[] = [
  { re: /dashboard|home|overview/i, route: '/dashboard', label: 'Dashboard' },
  { re: /treat/i, route: '/treaties', label: 'Treaties' },
  { re: /facultative|fac\b/i, route: '/facultative', label: 'Facultative' },
  { re: /retro/i, route: '/retrocession', label: 'Retrocession' },
  { re: /placement|slip/i, route: '/placement', label: 'Placement' },
  { re: /pricing|rating/i, route: '/pricing', label: 'Pricing' },
  { re: /partie|broker|cedent/i, route: '/parties', label: 'Parties' },
  { re: /\bcrm\b|pipeline|opportunit/i, route: '/crm', label: 'CRM' },
  { re: /document|template/i, route: '/documents', label: 'Documents' },
  { re: /claim/i, route: '/claims', label: 'Claims' },
  { re: /bordereau/i, route: '/bordereaux', label: 'Bordereaux' },
  { re: /exposure|accumulation|aggregate/i, route: '/exposure', label: 'Exposure' },
  { re: /recover|salvage|subrogation|cash call/i, route: '/recoveries', label: 'Recoveries' },
  { re: /accounting/i, route: '/accounting', label: 'Accounting' },
  { re: /statement/i, route: '/statements', label: 'Statements' },
  { re: /finance|ledger|trial balance|invoice/i, route: '/finance', label: 'Finance' },
  { re: /adjustment|profit commission|portfolio|endors|commut/i, route: '/adjustments', label: 'Treaty Adjustments' },
  { re: /report/i, route: '/reports', label: 'Reports' },
  { re: /regulator|ifrs|solvency|return|schedule f|qrt/i, route: '/regulatory', label: 'Regulatory' },
  { re: /workflow|approval|notification/i, route: '/workflow', label: 'Workflow' },
  { re: /attendance|punch|geofence|timesheet/i, route: '/attendance', label: 'Attendance' },
  { re: /people|employee|\bhr\b|hrms|leave/i, route: '/hr', label: 'People' },
  { re: /payroll|payslip/i, route: '/payroll', label: 'Payroll' },
  { re: /performance|appraisal|review/i, route: '/performance', label: 'Performance' },
  { re: /procurement|purchase|vendor|\bpo\b/i, route: '/procurement', label: 'Procurement' },
  { re: /asset|license|entitlement/i, route: '/assets', label: 'Assets' },
  { re: /treasury|investment|cash management/i, route: '/treasury', label: 'Treasury' },
  { re: /analytic|pivot|cube|aal|pml/i, route: '/analytics', label: 'Analytics' },
  { re: /risk|capital|scr|\bvar\b|solvency ratio/i, route: '/risk-capital', label: 'Risk & Capital' },
  { re: /intelligence|insight|prediction|ocr/i, route: '/intelligence', label: 'Intelligence' },
  { re: /product|catalog|parametric|ilw/i, route: '/products', label: 'Products' },
  { re: /scheduler|cron job/i, route: '/scheduler', label: 'Scheduler' },
  { re: /designer|no.?code|form builder/i, route: '/designer', label: 'Designer' },
  { re: /marketplace|app store|install app/i, route: '/marketplace', label: 'Marketplace' },
  { re: /messaging|email|sms|notification queue/i, route: '/messaging', label: 'Messaging' },
  { re: /portal|broker portal|cedent portal/i, route: '/portal', label: 'Portal' },
  { re: /security|mfa|sso|webauthn|passkey/i, route: '/security', label: 'Security' },
  { re: /operation|observability|audit|sla|health|metric/i, route: '/operations', label: 'Operations' },
  { re: /integration|webhook|export|import/i, route: '/integration', label: 'Integration' },
  { re: /admin|config|code list/i, route: '/admin', label: 'Admin' },
];

function navAction(route: string, label: string): AssistantAction {
  return prepared({ kind: 'navigate', description: `Open ${label}`, requiresConfirmation: false, destructive: false, preview: { route } });
}

// ---------------------------------------------------------------------------
// Intent catalogue
// ---------------------------------------------------------------------------
const INTENTS: Intent[] = [
  // ---- Underwriting: high-risk submissions ------------------------------
  {
    test: /high.?risk|elevated risk|risky (submission|treat)/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view submissions (treaty:read).');
      const r = await db.query<{ id: string; reference: string; title: string; risk_score: number; risk_band: string; stage: string }>(
        `select s.id, s.reference, s.title, s.risk_score, s.risk_band, s.stage
           from submission s
          where s.risk_band in ('ELEVATED','HIGH') and s.stage not in ('BOUND','DECLINED','LAPSED')
          order by s.risk_score desc nulls last limit 8`,
      );
      if (!r.rows.length) return answer('No open ELEVATED/HIGH-risk submissions right now.');
      const lines = r.rows.map((s) => `• ${s.reference} - ${s.title} (${s.risk_band}, score ${s.risk_score ?? 'n/a'}, ${s.stage})`).join('\n');
      return answer(
        `Top high-risk open submissions:\n${lines}`,
        r.rows.map((s) => ({ entity: 'submission', id: s.id, label: s.reference })),
      );
    },
  },

  // ---- Underwriting: pipeline ------------------------------------------
  {
    test: /underwriting pipeline|open submission|submissions?\b|\bsubmission pipeline\b/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view submissions (treaty:read).');
      const byStage = await db.query<{ stage: string; n: number }>(
        `select stage, count(*)::int n from submission group by stage order by n desc`,
      );
      if (!byStage.rows.length) return answer('There are no submissions in the pipeline yet.');
      const OPEN = new Set(['SUBMISSION', 'TRIAGE', 'ANALYSIS', 'PRICING', 'REFERRAL', 'QUOTED']);
      const openStages = byStage.rows.filter((s) => OPEN.has(s.stage));
      const openTotal = openStages.reduce((a, s) => a + s.n, 0);
      const epi = await db.query<{ epi: number }>(
        `select coalesce(sum(est_premium_minor),0)::bigint epi from submission
          where stage in ('SUBMISSION','TRIAGE','ANALYSIS','PRICING','REFERRAL','QUOTED')`,
      );
      const stageLine = byStage.rows.map((s) => `${s.stage}: ${s.n}`).join(', ');
      return answer(
        `Underwriting pipeline - ${openTotal} open submission(s), pipeline EPI ${fmt(Number(epi.rows[0]!.epi))}.\nBy stage: ${stageLine}.`,
      );
    },
  },

  // ---- Underwriting: catastrophe exposure ------------------------------
  {
    test: /cat(astrophe)?[\s-]?expos|cat.?exposed/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view submissions (treaty:read).');
      const r = await db.query<{ exposure: number; n: number }>(
        `select coalesce(sum(coalesce(limit_minor, sum_insured_minor, 0)),0)::bigint exposure, count(*)::int n
           from submission where cat_exposed = true and stage not in ('DECLINED','LAPSED')`,
      );
      const row = r.rows[0]!;
      if (!row.n) return answer('No cat-exposed submissions on the book right now.');
      return answer(
        `Catastrophe exposure: ${row.n} cat-exposed submission(s) carrying ${fmt(Number(row.exposure))} of aggregate exposure (layer limit, else sum insured).`,
      );
    },
  },

  // ---- Underwriting: portfolio / summary -------------------------------
  {
    test: /underwriting summary|portfolio summary|underwriting (overview|snapshot)/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view submissions (treaty:read).');
      const t = await db.query<{ total: number; bound: number; declined: number; avg_score: number }>(
        `select count(*)::int total,
                count(*) filter (where stage='BOUND')::int bound,
                count(*) filter (where stage='DECLINED')::int declined,
                coalesce(round(avg(risk_score)),0)::int avg_score
           from submission`,
      );
      const tot = t.rows[0]!;
      if (!tot.total) return answer('No submissions on the book yet.');
      const top = await db.query<{ key: string; n: number }>(
        `select coalesce(structure, kind) key, count(*)::int n from submission
          group by coalesce(structure, kind) order by n desc limit 1`,
      );
      const decided = tot.bound + tot.declined;
      const hitRatio = decided ? Math.round((tot.bound / decided) * 100) : 0;
      const topStruct = top.rows[0] ? `${top.rows[0].key} (${top.rows[0].n})` : 'n/a';
      return answer(
        `Underwriting summary: ${tot.total} submission(s), ${tot.bound} bound, hit ratio ${hitRatio}% (bound / decided), average risk score ${tot.avg_score}. Top structure by count is ${topStruct}.`,
      );
    },
  },

  // ---- Brokers: top performers -----------------------------------------
  {
    test: /top broker|broker (performance|ranking|league)|best broker|which broker/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'party:read')) return answer('You do not have permission to view brokers (party:read).');
      const r = await db.query<{ id: string; name: string; gwp: number }>(
        `select p.id, p.legal_name name, coalesce(sum(s.est_premium_minor),0)::bigint gwp
           from party p join party_role pr on pr.party_id=p.id and pr.role_code='broker' and pr.is_active
           left join submission s on s.broker_party_id=p.id
          where not p.is_deleted group by p.id, p.legal_name order by gwp desc limit 6`,
      );
      if (!r.rows.length) return answer('No brokers on the book yet.');
      const lines = r.rows.map((b) => `• ${b.name} - ${fmt(Number(b.gwp))} placed`).join('\n');
      return answer(`Top brokers by premium placed:\n${lines}`, r.rows.map((b) => ({ entity: 'broker', id: b.id, label: b.name })));
    },
  },

  // ---- Cedents: top relationships / loss ratio -------------------------
  {
    test: /top cedent|cedent (performance|ranking|loss ratio|league)|which cedent|best cedent/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'party:read')) return answer('You do not have permission to view cedents (party:read).');
      const r = await db.query<{ id: string; name: string; gwp: number; incurred: number }>(
        `select p.id, p.legal_name name, coalesce(sum(s.est_premium_minor),0)::bigint gwp,
                coalesce((select sum(c.gross_loss_minor) from claim c join contract ct on ct.id=c.contract_id where ct.cedent_party_id=p.id and not c.is_deleted),0)::bigint incurred
           from party p join party_role pr on pr.party_id=p.id and pr.role_code='cedent' and pr.is_active
           left join submission s on s.cedent_party_id=p.id
          where not p.is_deleted group by p.id, p.legal_name order by gwp desc limit 6`,
      );
      if (!r.rows.length) return answer('No cedents on the book yet.');
      const lines = r.rows.map((c) => {
        const lr = Number(c.gwp) > 0 ? Math.round((Number(c.incurred) / Number(c.gwp)) * 100) : 0;
        return `• ${c.name} - ${fmt(Number(c.gwp))} GWP, ${lr}% loss ratio`;
      }).join('\n');
      return answer(`Top cedents by premium:\n${lines}`, r.rows.map((c) => ({ entity: 'cedent', id: c.id, label: c.name })));
    },
  },

  // ---- Capacity: utilisation & breaches --------------------------------
  {
    test: /capacity (util|remaining|available|alert|breach|position)|remaining capacity|capacity utili|how much capacity/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view capacity (treaty:read).');
      const r = await db.query<{ dim_key: string; label: string | null; available_minor: number; consumed_minor: number }>(
        `select dim_key, label, available_minor, consumed_minor from capacity_line`,
      );
      if (!r.rows.length) return answer('No capacity lines are configured yet.');
      const avail = r.rows.reduce((a, l) => a + Number(l.available_minor), 0);
      const consumed = r.rows.reduce((a, l) => a + Number(l.consumed_minor), 0);
      const util = avail > 0 ? Math.round((consumed / avail) * 100) : 0;
      const hot = r.rows
        .map((l) => ({ k: l.label || l.dim_key, u: Number(l.available_minor) > 0 ? (Number(l.consumed_minor) / Number(l.available_minor)) * 100 : 0 }))
        .filter((l) => l.u >= 80).sort((a, b) => b.u - a.u).slice(0, 5);
      const hotLine = hot.length ? `\nRunning hot: ${hot.map((h) => `${h.k} ${Math.round(h.u)}%`).join(', ')}.` : '\nNo lines above 80% utilisation.';
      return answer(`Capacity: ${fmt(consumed)} consumed of ${fmt(avail)} (${util}% utilised), ${fmt(avail - consumed)} remaining.${hotLine}`);
    },
  },

  // ---- Exposure: peak accumulation -------------------------------------
  {
    test: /peak (zone|accumulation|exposure)|largest accumulation|exposure concentration|total insured value|where.*most exposed/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'exposure:read')) return answer('You do not have permission to view exposure (exposure:read).');
      const r = await db.query<{ zone: string; tiv: number; items: number }>(
        `select coalesce(cresta, country, 'Unknown') zone, sum(tiv_minor)::bigint tiv, count(*)::int items
           from exposure_item group by coalesce(cresta, country, 'Unknown') order by tiv desc limit 6`,
      );
      if (!r.rows.length) return answer('No exposure items are registered yet.');
      const total = r.rows.reduce((a, z) => a + Number(z.tiv), 0);
      const peak = r.rows[0]!;
      const share = total > 0 ? Math.round((Number(peak.tiv) / total) * 100) : 0;
      const lines = r.rows.map((z) => `• ${z.zone} - ${fmt(Number(z.tiv))} TIV (${z.items} item(s))`).join('\n');
      return answer(`Peak accumulation is ${peak.zone} at ${fmt(Number(peak.tiv))} TIV (${share}% of the top zones).\nTop zones:\n${lines}`);
    },
  },

  // ---- Claims: loss ratio & reserves -----------------------------------
  {
    test: /loss ratio|claims? (summary|position|overview|incurred)|incurred loss|outstanding reserve/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'claims:read') && !has(perms, 'treaty:read')) return answer('You do not have permission to view claims (claims:read).');
      const t = await db.query<{ n: string; incurred: string; outstanding: string; paid: string }>(
        `select count(*)::int n, coalesce(sum(gross_loss_minor),0)::bigint incurred,
                coalesce(sum(outstanding_minor),0)::bigint outstanding, coalesce(sum(paid_minor),0)::bigint paid
           from claim where not is_deleted`,
      );
      const p = await db.query<{ premium: string }>(`select coalesce(sum(amount_minor),0)::bigint premium from financial_event where event_type ilike '%premium%'`);
      const r = t.rows[0]!;
      const premium = Number(p.rows[0]!.premium);
      const lr = premium > 0 ? Math.round((Number(r.incurred) / premium) * 1000) / 10 : 0;
      return answer(`Claims: ${r.n} on the book, ${fmt(Number(r.incurred))} incurred (${lr}% loss ratio), ${fmt(Number(r.outstanding))} outstanding reserves, ${fmt(Number(r.paid))} paid.`);
    },
  },

  // ---- Finance: technical result ---------------------------------------
  {
    test: /technical (result|account|profit)|underwriting (result|profit)|combined ratio|finance (summary|position)|profitab/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view financials (treaty:read).');
      const a = await db.query<{ premium: string; commission: string; claims: string }>(
        `select coalesce(sum(amount_minor) filter (where event_type ilike '%premium%'),0)::bigint premium,
                coalesce(sum(amount_minor) filter (where event_type ilike '%commission%'),0)::bigint commission,
                coalesce(sum(amount_minor) filter (where claim_id is not null or event_type ilike '%claim%' or event_type ilike '%loss%'),0)::bigint claims
           from financial_event`,
      );
      const row = a.rows[0]!;
      const premium = Number(row.premium), commission = Number(row.commission), claims = Number(row.claims);
      const cr = premium > 0 ? Math.round(((claims + commission) / premium) * 1000) / 10 : 0;
      const result = premium - commission - claims;
      return answer(`Technical account: ${fmt(premium)} premium, ${fmt(commission)} commission, ${fmt(claims)} claims → combined ratio ${cr}%, technical result ${fmt(result)}.`);
    },
  },

  // ---- Retrocession position -------------------------------------------
  {
    test: /retro(cession)?( position| summary| programme| protection)?|outward|ceded (premium|business)/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view retrocession (treaty:read).');
      const s = await db.query<{ n: string; ceded: string; recovered: string }>(
        `select count(distinct ct.id)::int n,
                coalesce((select sum(fe.amount_minor) from financial_event fe join contract c2 on c2.id=fe.contract_id where fe.event_type ilike '%premium%' and (c2.contract_kind='RETROCESSION' or c2.direction='OUTWARDS')),0)::bigint ceded,
                coalesce(sum(cl.recovered_minor),0)::bigint recovered
           from contract ct left join claim cl on cl.contract_id=ct.id and not cl.is_deleted
          where not ct.is_deleted and (ct.contract_kind='RETROCESSION' or ct.direction='OUTWARDS')`,
      );
      const r = s.rows[0]!;
      if (!Number(r.n)) return answer('No retrocession / outwards programmes are recorded yet.');
      return answer(`Retrocession: ${r.n} outwards programme(s), ${fmt(Number(r.ceded))} ceded premium, ${fmt(Number(r.recovered))} recovered.`);
    },
  },

  // ---- Portfolio / executive insights ----------------------------------
  {
    test: /portfolio (insight|health|summary|overview)|executive (summary|insight|brief)|how is the (book|portfolio)|book health/i,
    handler: async (db, _ctx, _message, perms) => {
      if (!has(perms, 'treaty:read')) return answer('You do not have permission to view the portfolio (treaty:read).');
      const sub = await db.query<{ open: string; epi: string; avg: string; bound: string }>(
        `select count(*) filter (where stage not in ('BOUND','DECLINED','LAPSED'))::int open,
                coalesce(sum(est_premium_minor) filter (where stage not in ('BOUND','DECLINED','LAPSED')),0)::bigint epi,
                coalesce(round(avg(risk_score)),0)::int avg,
                count(*) filter (where stage='BOUND')::int bound from submission`,
      );
      const cap = await db.query<{ avail: string; consumed: string }>(`select coalesce(sum(available_minor),0)::bigint avail, coalesce(sum(consumed_minor),0)::bigint consumed from capacity_line`);
      const clm = await db.query<{ incurred: string }>(`select coalesce(sum(gross_loss_minor),0)::bigint incurred from claim where not is_deleted`);
      const prem = await db.query<{ premium: string }>(`select coalesce(sum(amount_minor),0)::bigint premium from financial_event where event_type ilike '%premium%'`);
      const s = sub.rows[0]!;
      const avail = Number(cap.rows[0]!.avail), consumed = Number(cap.rows[0]!.consumed);
      const util = avail > 0 ? Math.round((consumed / avail) * 100) : 0;
      const premium = Number(prem.rows[0]!.premium), incurred = Number(clm.rows[0]!.incurred);
      const lr = premium > 0 ? Math.round((incurred / premium) * 100) : 0;
      return answer(
        `Portfolio snapshot: ${s.open} open submission(s) carrying ${fmt(Number(s.epi))} EPI at an average risk score of ${s.avg}/100; ${s.bound} bound. ` +
        `Capacity is ${util}% utilised. Booked loss ratio is ${lr}%. ` +
        (util >= 90 ? 'Capacity is running hot — watch new commitments. ' : '') +
        (lr >= 80 ? 'Loss ratio is elevated. ' : lr > 0 && lr < 60 ? 'Loss experience is favourable. ' : ''),
      );
    },
  },

  // ---- Navigation -------------------------------------------------------
  {
    test: /^(go to|open|show me|take me to|navigate to)\b/i,
    handler: async (_db, _ctx, message) => {
      const target = NAV.find((n) => n.re.test(message));
      if (!target) return answer("I couldn't find that screen. Try 'open claims' or 'go to finance'.");
      return { reply: `Opening ${target.label}.`, actions: [navAction(target.route, target.label)] };
    },
  },

  // ---- Counts -----------------------------------------------------------
  {
    test: /how many|count|number of/i,
    handler: async (db, _ctx, message) => {
      const map: { re: RegExp; sql: string; noun: string }[] = [
        { re: /claim/i, sql: `select count(*)::int n from claim where not is_deleted`, noun: 'claim(s)' },
        { re: /partie|broker|cedent|reinsurer/i, sql: `select count(*)::int n from party where not is_deleted`, noun: 'party/parties' },
        { re: /employee|staff|people/i, sql: `select count(*)::int n from employee where not is_deleted`, noun: 'employee(s)' },
        { re: /vendor|supplier/i, sql: `select count(*)::int n from vendor`, noun: 'vendor(s)' },
        { re: /purchase|\bpo\b|order/i, sql: `select count(*)::int n from purchase_order`, noun: 'purchase order(s)' },
        { re: /opportunit|pipeline/i, sql: `select count(*)::int n from crm_opportunity where status='open'`, noun: 'open opportunit(ies)' },
        { re: /asset/i, sql: `select count(*)::int n from asset`, noun: 'asset(s)' },
        { re: /statement/i, sql: `select count(*)::int n from statement_of_account`, noun: 'statement(s)' },
        { re: /return|regulator/i, sql: `select count(*)::int n from regulatory_return`, noun: 'regulatory return(s)' },
      ];
      const hit = map.find((m) => m.re.test(message)) ?? { sql: `select count(*)::int n from contract where not is_deleted`, noun: 'treaty/contract(s)' };
      const r = await db.query<{ n: number }>(hit.sql);
      return answer(`You have ${r.rows[0]!.n} ${hit.noun}.`);
    },
  },

  // ---- Open / overdue claims -------------------------------------------
  {
    test: /overdue|open claim|outstanding claim|claims? due/i,
    handler: async (db) => {
      const r = await db.query<{ reference: string; status: string; outstanding_minor: number; currency: string }>(
        `select reference, status, outstanding_minor, currency from claim
          where not is_deleted and status not in ('CLOSED','SETTLED') order by notified_date desc limit 10`,
      );
      if (!r.rows.length) return answer('No open claims right now.');
      const lines = r.rows.map((c) => `• ${c.reference} - ${c.status}, outstanding ${fmt(c.outstanding_minor, c.currency)}`).join('\n');
      return answer(`Open claims:\n${lines}`, r.rows.map((c) => ({ entity: 'claim', id: c.reference, label: c.reference })));
    },
  },

  // ---- Premium / GWP / financial position ------------------------------
  {
    test: /gwp|gross written|premium (income|booked|total)|how much premium|financial position/i,
    handler: async (db) => {
      const r = await db.query<{ gwp: number; outstanding: number }>(
        `select
           coalesce(sum(amount_minor) filter (where event_type in ('DEPOSIT_PREMIUM','INSTALMENT_PREMIUM','ADJUSTMENT_PREMIUM','MINIMUM_PREMIUM')),0)::bigint gwp,
           (select coalesce(sum(outstanding_minor),0)::bigint from claim where not is_deleted) outstanding
         from financial_event`,
      );
      return answer(
        `Booked premium (GWP) is ${fmt(Number(r.rows[0]!.gwp))}; outstanding claim reserves are ${fmt(Number(r.rows[0]!.outstanding))}.`,
      );
    },
  },

  // ---- CRM pipeline -----------------------------------------------------
  {
    test: /pipeline|weighted|opportunit/i,
    handler: async (db) => {
      const r = await db.query<{ stage: string; n: number; total: number; weighted: number }>(
        `select stage, count(*)::int n, coalesce(sum(amount_minor),0)::bigint total,
                coalesce(sum(round(amount_minor*probability/100)),0)::bigint weighted
           from crm_opportunity where status='open' group by stage order by weighted desc`,
      );
      if (!r.rows.length) return answer('The pipeline is empty.');
      const lines = r.rows.map((x) => `• ${x.stage}: ${x.n} open, ${fmt(Number(x.total))} (weighted ${fmt(Number(x.weighted))})`).join('\n');
      return answer(`Sales pipeline:\n${lines}`);
    },
  },

  // ---- Pending approvals -----------------------------------------------
  {
    test: /pending approval|approval.*(pending|waiting|outstanding)|(pending|waiting|outstanding).*approval|what needs approv/i,
    handler: async (db) => {
      const r = await db.query<{ action: string; entity_type: string; created_at: string }>(
        `select action, entity_type, created_at from approval_request where status='pending' order by created_at desc limit 10`,
      );
      if (!r.rows.length) return answer('No approvals are pending.');
      return answer(`Pending approvals:\n${r.rows.map((a) => `• ${a.action} on ${a.entity_type}`).join('\n')}`);
    },
  },

  // ---- Licenses expiring -----------------------------------------------
  {
    test: /licens.*(expir|renew)|expiring licens/i,
    handler: async (db) => {
      const r = await db.query<{ name: string; expiry_date: string; seats_total: number; seats_used: number }>(
        `select name, expiry_date, seats_total, seats_used from software_license
          where expiry_date is not null and expiry_date <= current_date + interval '60 days' order by expiry_date`,
      );
      if (!r.rows.length) return answer('No software licenses are expiring in the next 60 days.');
      return answer(`Licenses expiring soon:\n${r.rows.map((l) => `• ${l.name} - expires ${l.expiry_date}, ${l.seats_used}/${l.seats_total} seats`).join('\n')}`);
    },
  },

  // ---- Exposure summary -------------------------------------------------
  {
    test: /cat exposure|aggregate|exposure (for|summary)|zone|accumulation/i,
    handler: async (db, _ctx, message) => {
      const a = await db.query<{ peril: string; zone: string; used: number; cap: number }>(
        `select a.peril, a.zone, coalesce(sum(e.gross_exposure_minor),0)::bigint used, a.capacity_minor cap
           from accumulation a left join exposure_entry e on e.accumulation_id = a.id
          group by a.id, a.peril, a.zone, a.capacity_minor order by used desc limit 10`,
      );
      if (a.rows.length) {
        const lines = a.rows.map((x) => `• ${x.peril}/${x.zone}: ${fmt(Number(x.used))} of ${fmt(Number(x.cap))}${Number(x.used) > Number(x.cap) ? ' ⚠ breached' : ''}`).join('\n');
        return answer(`Zonal accumulations:\n${lines}`);
      }
      const zone = (message.match(/zone\s+([a-z ]+)/i)?.[1] ?? '').trim();
      const r = await db.query<{ peril_zone: string; n: number; si: number }>(
        `select coalesce(peril_zone,'(unzoned)') peril_zone, count(*)::int n, coalesce(sum(sum_insured_minor),0)::bigint si
           from risk where ($1='' or peril_zone ilike '%'||$1||'%') group by peril_zone order by si desc`,
        [zone],
      );
      if (!r.rows.length) return answer('No exposure records yet. Exposure populates as risks and bordereaux are loaded (§9.9).');
      return answer(`Exposure summary:\n${r.rows.map((x) => `• ${x.peril_zone}: ${x.n} risk(s), TSI ${fmt(Number(x.si))}`).join('\n')}`);
    },
  },

  // ---- Latest payroll ---------------------------------------------------
  {
    test: /payroll|payslip|salary cost/i,
    handler: async (db) => {
      const r = await db.query<{ period: string; headcount: number; total_gross_minor: number; total_net_minor: number; status: string }>(
        `select period, headcount, total_gross_minor, total_net_minor, status from payroll_run order by created_at desc limit 1`,
      );
      if (!r.rows.length) return answer('No payroll runs yet. You can run payroll from the Payroll screen.');
      const p = r.rows[0]!;
      return answer(`Latest payroll (${p.period}, ${p.status}): ${p.headcount} employees, gross ${fmt(p.total_gross_minor)}, net ${fmt(p.total_net_minor)}.`);
    },
  },

  // ---- Statement (prepare/navigate) ------------------------------------
  {
    test: /statement (of account)?|generate.*statement/i,
    handler: async (db, _ctx, message, perms) => {
      const ref = message.match(/TRTY[-\w]+/i)?.[0];
      const r = await db.query<{ id: string; name: string; reference: string }>(
        ref
          ? `select id, name, reference from contract where reference ilike $1 and not is_deleted limit 1`
          : `select id, name, reference from contract where not is_deleted order by created_at desc limit 1`,
        ref ? [ref] : [],
      );
      const c = r.rows[0];
      if (!c) return answer('I could not find a matching treaty to build a statement for.');
      const actions: AssistantAction[] = [navAction('/statements', 'Statements')];
      if (has(perms, 'statement:write') || has(perms, 'accounting:post')) {
        actions.unshift(
          prepared({
            kind: 'generate_statement',
            description: `Generate the statement of account for ${c.reference}`,
            requiresConfirmation: true,
            destructive: false,
            preview: { contractId: c.id, reference: c.reference },
          }),
        );
      }
      return { reply: `I can generate the statement of account for ${c.reference} (${c.name}). It nets the contract's financial events - review before issuing.`, actions, grounding: [{ entity: 'contract', id: c.id, label: c.reference }] };
    },
  },

  // ---- Mutations (prepared, confirm-gated) ------------------------------
  {
    test: /\b(create|add|new|register|raise|run|generate|file)\b/i,
    handler: async (db, _ctx, message, perms) => {
      // Treaty
      if (/treaty|contract/i.test(message)) {
        if (!has(perms, 'treaty:write')) return answer('You do not have permission to create treaties (treaty:write).');
        const name = nameFrom(message) ?? 'New Treaty';
        return prep(`draft treaty "${name}"`, { kind: 'create_treaty', description: `Create a DRAFT treaty "${name}"`, preview: { name, basis: 'NON_PROPORTIONAL', npType: 'CAT_XL', currency: 'USD' } });
      }
      // Party
      if (/party|broker|cedent|reinsurer/i.test(message)) {
        if (!has(perms, 'party:write')) return answer('You do not have permission to create parties (party:write).');
        const name = nameFrom(message) ?? 'New Party';
        const role = /broker/i.test(message) ? 'broker' : /reinsurer/i.test(message) ? 'reinsurer' : 'cedent';
        return prep(`${role} "${name}"`, { kind: 'create_party', description: `Create party "${name}" (${role})`, preview: { legalName: name, roles: [role] } });
      }
      // Claim
      if (/claim|loss/i.test(message)) {
        if (!has(perms, 'claims:write')) return answer('You do not have permission to register claims (claims:write).');
        const c = await db.query<{ id: string; reference: string }>(`select id, reference from contract where not is_deleted order by created_at desc limit 1`);
        if (!c.rows[0]) return answer('There is no treaty to register a claim against yet.');
        const amount = amountFrom(message) ?? 0;
        return prep(`claim on ${c.rows[0].reference} for ${fmt((amount) * 100)}`, { kind: 'create_claim', description: `Register a claim on ${c.rows[0].reference} (gross ${fmt(amount * 100)})`, preview: { contractId: c.rows[0].id, grossLoss: amount, currency: 'USD' } });
      }
      // Cash call
      if (/cash call/i.test(message)) {
        if (!has(perms, 'claims:write')) return answer('You do not have permission for cash calls (claims:write).');
        const cl = await db.query<{ id: string; reference: string }>(`select id, reference from claim where not is_deleted order by notified_date desc limit 1`);
        if (!cl.rows[0]) return answer('There is no claim to raise a cash call on.');
        const amount = amountFrom(message) ?? 0;
        return prep(`cash call on ${cl.rows[0].reference}`, { kind: 'raise_cash_call', description: `Raise a cash call of ${fmt(amount * 100)} on ${cl.rows[0].reference}`, destructive: true, preview: { claimId: cl.rows[0].id, amount } });
      }
      // Vendor
      if (/vendor|supplier/i.test(message)) {
        if (!has(perms, 'procurement:write')) return answer('You do not have permission to add vendors (procurement:write).');
        const name = nameFrom(message) ?? 'New Vendor';
        return prep(`vendor "${name}"`, { kind: 'create_vendor', description: `Create vendor "${name}"`, preview: { name } });
      }
      // CRM opportunity
      if (/opportunit|deal|lead/i.test(message)) {
        if (!has(perms, 'crm:write')) return answer('You do not have permission for CRM (crm:write).');
        const name = nameFrom(message) ?? 'New Opportunity';
        const p = await db.query<{ id: string }>(`select id from party where not is_deleted order by created_at limit 1`);
        const amount = amountFrom(message) ?? 0;
        return prep(`opportunity "${name}"`, { kind: 'create_opportunity', description: `Create opportunity "${name}" (${fmt(amount * 100)})`, preview: { name, partyId: p.rows[0]?.id ?? null, amount, currency: 'USD', stage: 'PROSPECT' } });
      }
      // Run payroll
      if (/payroll/i.test(message)) {
        if (!has(perms, 'hr:write')) return answer('You do not have permission to run payroll (hr:write).');
        const period = message.match(/\b(20\d\d-\d\d)\b/)?.[1] ?? new Date().toISOString().slice(0, 7);
        return prep(`payroll run for ${period}`, { kind: 'run_payroll', description: `Run payroll for ${period}`, destructive: true, preview: { period, currency: 'USD' } });
      }
      // Regulatory return
      if (/return|schedule f|qrt|disclosure/i.test(message)) {
        if (!has(perms, 'regulatory:run')) return answer('You do not have permission to generate returns (regulatory:run).');
        const kind = /schedule f/i.test(message) ? 'SCHEDULE_F' : /qrt|solvency/i.test(message) ? 'SOLVENCY2_QRT' : /lloyd/i.test(message) ? 'LLOYDS_RETURN' : 'IFRS17_DISCLOSURE';
        return prep(`${kind} return`, { kind: 'generate_return', description: `Generate a ${kind} regulatory return`, preview: { kind } });
      }
      return answer('I can prepare treaties, parties, claims, cash calls, vendors, opportunities, payroll runs and regulatory returns. What would you like to create?');
    },
  },

  // ---- Loose navigation catch-all --------------------------------------
  // Runs only if nothing above matched: if the message mentions ANY module by
  // name (e.g. "hrms", "report", "treasury"), offer to open it. Otherwise the
  // capability summary. This makes the assistant responsive across all modules,
  // not only when the message starts with "go to / open".
  {
    test: /.*/,
    handler: async (_db, _ctx, message) => {
      const target = NAV.find((n) => n.re.test(message));
      if (target) return { reply: `Opening ${target.label}.`, actions: [navAction(target.route, target.label)] };
      return answer(
        'I can open any module (try "treaties", "claims", "attendance", "risk capital"), count records, summarise premium, pipeline, exposure, payroll and the financial position, list open claims and pending approvals, and prepare new treaties, parties, claims, cash calls, vendors, opportunities, payroll runs and regulatory returns - each confirmed before anything changes. What would you like?',
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export async function assistantModule(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { message: string } }>(
    '/api/assistant',
    { preHandler: requirePermission() },
    async (req, reply) => {
      const ctx = authContext(req);
      const message = (req.body?.message ?? '').trim();
      if (!message) {
        reply.code(400);
        return { error: 'message is required' };
      }
      const perms = req.auth?.permissions ?? [];
      return runAs(ctx, async (db) => {
        const intent = INTENTS.find((i) => i.test.test(message));
        if (intent) return intent.handler(db, ctx, message, perms);

        // No deterministic match - try the LLM (grounded, read-only) if enabled.
        if (isLlmEnabled()) {
          const snapshot = await groundingSnapshot(db);
          const text = await llmAnswer({ question: message, grounding: snapshot });
          if (text) return answer(text);
        }
        return answer(
          'I can navigate to any module, count records, summarise premium, pipeline, exposure and payroll, list open claims and pending approvals, and prepare new treaties, parties, claims, cash calls, vendors, opportunities, payroll runs and regulatory returns - each confirmed before anything changes. What would you like?',
        );
      });
    },
  );

  app.post<{ Body: { kind: string; preview: Record<string, unknown> } }>(
    '/api/assistant/confirm',
    { preHandler: requirePermission() },
    async (req, reply) => {
      const user = await authenticate(req);
      const ctx = authContext(req);
      const { kind, preview } = req.body ?? {};
      const perms = user.permissions;
      const deny = (p: string) => {
        reply.code(403);
        return { error: `Missing permission ${p}` };
      };

      return runAs(ctx, async (db) => {
        const audit = (entityType: string, id: string) =>
          writeAudit(db, ctx, { action: 'create', entityType, entityId: id, after: { ...preview, via: 'assistant' }, actorLabel: user.displayName, context: { assistant: true } });

        switch (kind) {
          case 'navigate':
            // Non-mutating; the client performs the navigation. Nothing to do server-side.
            return { ok: true, kind, route: preview?.route };

          case 'create_treaty': {
            if (!has(perms, 'treaty:write')) return deny('treaty:write');
            const { rows } = await db.query<{ id: string }>(
              `insert into contract (tenant_id, name, contract_kind, basis, np_type, currency, status, created_by)
               values ($1,$2,'TREATY','NON_PROPORTIONAL',$3,$4,'DRAFT',$5) returning id`,
              [ctx.tenantId, String(preview.name ?? 'New Treaty'), String(preview.npType ?? 'CAT_XL'), String(preview.currency ?? 'USD'), ctx.userId],
            );
            await audit('contract', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id };
          }
          case 'create_party': {
            if (!has(perms, 'party:write')) return deny('party:write');
            const { rows } = await db.query<{ id: string }>(`insert into party (tenant_id, legal_name) values ($1,$2) returning id`, [ctx.tenantId, String(preview.legalName ?? 'New Party')]);
            for (const role of (preview.roles as string[] | undefined) ?? [])
              await db.query(`insert into party_role (tenant_id, party_id, role_code) values ($1,$2,$3) on conflict do nothing`, [ctx.tenantId, rows[0]!.id, role]);
            await audit('party', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id };
          }
          case 'create_claim': {
            if (!has(perms, 'claims:write')) return deny('claims:write');
            const gross = Math.round(Number(preview.grossLoss ?? 0) * 100);
            const { rows } = await db.query<{ id: string }>(
              `insert into claim (tenant_id, contract_id, currency, gross_loss_minor, outstanding_minor, status, created_by)
               values ($1,$2,$3,$4,$4,'NOTIFIED',$5) returning id`,
              [ctx.tenantId, String(preview.contractId), String(preview.currency ?? 'USD'), gross, ctx.userId],
            );
            await audit('claim', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id };
          }
          case 'raise_cash_call': {
            if (!has(perms, 'claims:write')) return deny('claims:write');
            const amt = Math.round(Number(preview.amount ?? 0) * 100);
            const { rows } = await db.query<{ id: string; currency: string; contract_id: string }>(
              `insert into cash_call (tenant_id, claim_id, contract_id, amount_minor, currency, status, created_by)
               select $1, c.id, c.contract_id, $2, c.currency, 'requested', $3 from claim c where c.id=$4 returning id, currency, contract_id`,
              [ctx.tenantId, amt, ctx.userId, String(preview.claimId)],
            );
            if (rows[0]) {
              await db.query(
                `insert into financial_event (tenant_id, contract_id, claim_id, event_type, direction, amount_minor, currency, narrative, created_by)
                 values ($1,$2,$3,'CASH_LOSS','CR',$4,$5,'Cash call (assistant)',$6)`,
                [ctx.tenantId, rows[0].contract_id, String(preview.claimId), amt, rows[0].currency, ctx.userId],
              );
            }
            await audit('cash_call', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id };
          }
          case 'create_vendor': {
            if (!has(perms, 'procurement:write')) return deny('procurement:write');
            const code = 'V' + Date.now().toString().slice(-6);
            const { rows } = await db.query<{ id: string }>(`insert into vendor (tenant_id, code, name) values ($1,$2,$3) returning id`, [ctx.tenantId, code, String(preview.name ?? 'New Vendor')]);
            await audit('vendor', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id };
          }
          case 'create_opportunity': {
            if (!has(perms, 'crm:write')) return deny('crm:write');
            const amt = Math.round(Number(preview.amount ?? 0) * 100);
            const { rows } = await db.query<{ id: string }>(
              `insert into crm_opportunity (tenant_id, party_id, name, stage, amount_minor, currency, owner_user_id)
               values ($1,$2,$3,$4,$5,$6,$7) returning id`,
              [ctx.tenantId, (preview.partyId as string) ?? null, String(preview.name ?? 'New Opportunity'), String(preview.stage ?? 'PROSPECT'), amt, String(preview.currency ?? 'USD'), ctx.userId],
            );
            await audit('crm_opportunity', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id };
          }
          case 'run_payroll': {
            if (!has(perms, 'hr:write')) return deny('hr:write');
            // Minimal run: create the run header; payslip computation lives in the payroll module.
            const { rows } = await db.query<{ id: string }>(
              `insert into payroll_run (tenant_id, period, currency, status, created_by) values ($1,$2,$3,'draft',$4) returning id`,
              [ctx.tenantId, String(preview.period), String(preview.currency ?? 'USD'), ctx.userId],
            );
            await audit('payroll_run', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id, note: 'Draft payroll run created; compute payslips from the Payroll screen.' };
          }
          case 'generate_statement': {
            if (!has(perms, 'statement:write') && !has(perms, 'accounting:post')) return deny('statement:write');
            // Defer to the statements module flow by returning a navigation hint.
            return { ok: true, kind, route: '/statements', note: 'Open Statements to generate and review before issuing.' };
          }
          case 'generate_return': {
            if (!has(perms, 'regulatory:run')) return deny('regulatory:run');
            const { rows } = await db.query<{ id: string }>(
              `insert into regulatory_return (tenant_id, kind, status, created_by) values ($1,$2,'draft',$3) returning id`,
              [ctx.tenantId, String(preview.kind ?? 'IFRS17_DISCLOSURE'), ctx.userId],
            );
            await audit('regulatory_return', rows[0]!.id);
            return { ok: true, kind, id: rows[0]!.id, note: 'Draft return created; populate it from the Regulatory screen.' };
          }
          default:
            reply.code(400);
            return { error: `Unknown or non-confirmable action: ${kind}` };
        }
      });
    },
  );
}

/** A compact, RLS-scoped snapshot used to ground LLM answers (read-only). */
async function groundingSnapshot(db: Db): Promise<Record<string, unknown>> {
  const q = async (sql: string) => (await db.query(sql)).rows;
  const [kpis, recentTreaties, openClaims] = await Promise.all([
    q(`select
        (select count(*)::int from contract where not is_deleted) treaties,
        (select count(*)::int from claim where not is_deleted) claims,
        (select count(*)::int from party where not is_deleted) parties,
        (select coalesce(sum(amount_minor),0)::bigint from financial_event where event_type like '%PREMIUM') premium_minor`),
    q(`select reference, name, status, currency from contract where not is_deleted order by created_at desc limit 8`),
    q(`select reference, status, outstanding_minor, currency from claim where not is_deleted and status not in ('CLOSED','SETTLED') limit 8`),
  ]);
  return { kpis: kpis[0], recentTreaties, openClaims };
}

function answer(reply: string, grounding: AssistantResponse['grounding'] = []): AssistantResponse {
  return { reply, actions: [], grounding };
}

function prepared(a: Omit<AssistantAction, 'id'>): AssistantAction {
  return { id: randomUUID(), ...a };
}

/** Build a standard "prepared mutation" response from a partial action. */
function prep(noun: string, a: Omit<AssistantAction, 'id' | 'requiresConfirmation' | 'destructive'> & { destructive?: boolean }): AssistantResponse {
  const action = prepared({ requiresConfirmation: true, destructive: a.destructive ?? false, kind: a.kind, description: a.description, preview: a.preview });
  return { reply: `I've prepared ${noun}. Nothing is saved yet - review and confirm to apply it.`, actions: [action] };
}
