/**
 * Underwriting advisor - deterministic decision support, framework-free.
 *
 * The RIOS assistant is deliberately *not* a black-box LLM (ADR 0005): it grounds
 * every suggestion in explicit, auditable rules. This module is the underwriting
 * brain behind that promise. Given a submission's facts it produces:
 *
 *   - recommendedClauses  standard market wordings for the structure × line
 *   - missingInformation  completeness gaps (required terms + business basics)
 *   - attentionFlags      consistency / data-quality anomalies to review
 *   - executiveSummary    a plain-language précis for a referral note or slip
 *
 * Similar-risk benchmarking needs the book (a DB query) and lives in the server;
 * everything here is pure and unit-tested so the advice is reproducible.
 */

import { validateTerms } from './underwritingModels.js';

export interface AdvisorInput {
  title?: string | null;
  kind?: string | null;
  structure?: string | null;
  lineOfBusiness?: string | null;
  currency?: string | null;
  cedentName?: string | null;
  territory?: string | null;
  inception?: string | null;
  expiry?: string | null;
  sumInsuredMinor?: number | null;
  limitMinor?: number | null;
  attachmentMinor?: number | null;
  estPremiumMinor?: number | null;
  targetPremiumMinor?: number | null;
  lossRatioPct?: number | null;
  catExposed?: boolean | null;
  priorClaims?: number | null;
  yearsWithCedent?: number | null;
  riskScore?: number | null;
  riskBand?: string | null;
  terms?: Record<string, unknown> | null;
}

export interface Clause { code: string; title: string; rationale: string; }
export interface InfoGap { field: string; label: string; severity: 'required' | 'recommended'; }
export interface AttentionFlag { code: string; severity: 'high' | 'medium' | 'low'; message: string; }

// --- Clause library --------------------------------------------------------
// Standard reinsurance clauses, recommended by structure and/or line. Codes are
// stable; a fuller build would hang full wordings + versions off them.
const BASE_CLAUSES: Clause[] = [
  { code: 'SANCTION', title: 'Sanctions & Embargo', rationale: 'Mandatory on all placements — no cover where prohibited by sanctions.' },
  { code: 'CANCEL', title: 'Cancellation', rationale: 'Sets notice and run-off terms.' },
  { code: 'ERRORS', title: 'Errors & Omissions', rationale: 'Inadvertent errors do not prejudice cover.' },
  { code: 'CURRENCY', title: 'Currency Conversion', rationale: 'Fixes FX basis for multi-currency settlement.' },
  { code: 'ARBITRATION', title: 'Arbitration & Jurisdiction', rationale: 'Dispute-resolution forum and law.' },
];

const STRUCTURE_CLAUSES: Record<string, Clause[]> = {
  CAT_XL: [
    { code: 'HOURS', title: 'Hours Clause', rationale: 'Defines the loss-aggregation window per peril (e.g. 72h wind, 168h quake).' },
    { code: 'REINST', title: 'Reinstatement', rationale: 'Restores cover after a loss for the agreed additional premium.' },
    { code: 'UNL', title: 'Ultimate Net Loss', rationale: 'Defines the loss basis net of other recoveries.' },
    { code: 'LOSSOCC', title: 'Loss Occurrence', rationale: 'Aggregates individual losses into a single catastrophe event.' },
  ],
  PER_RISK_XL: [
    { code: 'REINST', title: 'Reinstatement', rationale: 'Restores per-risk cover after a loss.' },
    { code: 'UNL', title: 'Ultimate Net Loss', rationale: 'Defines the loss basis net of recoveries.' },
    { code: 'NETRET', title: 'Net Retained Lines', rationale: 'Cover applies only to the cedent’s net retained line.' },
  ],
  AGG_XL: [{ code: 'AAD', title: 'Annual Aggregate Deductible', rationale: 'Cedent retains losses up to the aggregate deductible.' }],
  STOP_LOSS: [{ code: 'LRDEF', title: 'Loss Ratio Definition', rationale: 'Pins down the loss-ratio calculation the cover attaches on.' }],
  QUOTA_SHARE: [
    { code: 'COMM', title: 'Ceding Commission', rationale: 'Sets the commission (and any sliding scale) on ceded premium.' },
    { code: 'PC', title: 'Profit Commission', rationale: 'Shares favourable experience back to the cedent.' },
    { code: 'CLAIMSCO', title: 'Claims Cooperation', rationale: 'Reinsurer participates in material claims handling.' },
  ],
  SURPLUS: [
    { code: 'COMM', title: 'Ceding Commission', rationale: 'Commission on ceded premium.' },
    { code: 'TOL', title: 'Table of Limits', rationale: 'Sets retention lines and treaty capacity by risk class.' },
  ],
};

const LINE_CLAUSES: Record<string, Clause[]> = {
  PROPERTY: [{ code: 'NATCAT', title: 'Natural Catastrophe Definition', rationale: 'Defines covered nat-cat perils and accumulation.' }],
  CYBER: [
    { code: 'CYBEREXC', title: 'War & Infrastructure Cyber Exclusion', rationale: 'Excludes state-backed / systemic cyber per market wording.' },
    { code: 'BREACHCO', title: 'Breach Response Cooperation', rationale: 'Governs incident-response and notification duties.' },
  ],
  MARINE_CARGO: [{ code: 'INSTITUTE', title: 'Institute Cargo Clauses', rationale: 'Standard cargo cover basis (A/B/C).' }],
  AVIATION: [{ code: 'WARAV', title: 'Aviation War Risk', rationale: 'Separates war/terror perils per AVN wordings.' }],
  ENERGY: [{ code: 'OED', title: 'Operators Extra Expense', rationale: 'Control-of-well / re-drill cover for energy risks.' }],
  CASUALTY: [{ code: 'CLAIMSMADE', title: 'Claims-Made Trigger', rationale: 'Fixes the reporting trigger and any retroactive date.' }],
  FINANCIAL_LINES: [{ code: 'RETRO', title: 'Retroactive Date', rationale: 'Limits cover to claims from acts after the retro date.' }],
};

/** Recommended clauses for a submission, de-duplicated by code, base first. */
export function recommendedClauses(structure?: string | null, line?: string | null): Clause[] {
  const out: Clause[] = [...BASE_CLAUSES];
  const seen = new Set(out.map((c) => c.code));
  for (const c of [...(structure ? STRUCTURE_CLAUSES[structure] ?? [] : []), ...(line ? LINE_CLAUSES[line] ?? [] : [])]) {
    if (!seen.has(c.code)) { out.push(c); seen.add(c.code); }
  }
  return out;
}

/** Completeness gaps: required model terms plus business basics an underwriter
 *  needs before quoting. Deterministic; drives the "missing information" panel. */
export function missingInformation(input: AdvisorInput): InfoGap[] {
  const gaps: InfoGap[] = [];
  const termsCheck = validateTerms(input.structure, input.lineOfBusiness, input.terms);
  for (const key of termsCheck.missing) gaps.push({ field: key, label: key, severity: 'required' });

  const rec = (cond: boolean, field: string, label: string) => { if (cond) gaps.push({ field, label, severity: 'recommended' }); };
  rec(!input.cedentName, 'cedent', 'Cedent / reinsured not set');
  rec(!input.inception || !input.expiry, 'period', 'Period of cover incomplete');
  rec(input.estPremiumMinor == null || input.estPremiumMinor === 0, 'estPremium', 'No estimated premium income');
  rec(input.lossRatioPct == null, 'lossRatio', 'No historical loss ratio for burn-cost');
  rec(!input.territory, 'territory', 'Territory / scope not stated');
  return gaps;
}

/**
 * Consistency & data-quality checks - "attention flags" an underwriter should
 * review. These are transparent heuristics, NOT a fraud verdict: they surface
 * inputs that look internally inconsistent or off-market so a human can judge.
 */
export function attentionFlags(input: AdvisorInput): AttentionFlag[] {
  const flags: AttentionFlag[] = [];
  const epi = input.estPremiumMinor ?? 0;
  const limit = input.limitMinor ?? input.sumInsuredMinor ?? 0;
  const lr = input.lossRatioPct ?? null;

  if (lr != null && lr >= 100) flags.push({ code: 'LR_OVER_100', severity: 'high', message: `Historical loss ratio ${lr}% exceeds 100% — technically unprofitable as presented.` });
  if (lr != null && epi > 0 && lr < 20 && (input.priorClaims ?? 0) >= 3) flags.push({ code: 'LR_CLAIMS_INCONSISTENT', severity: 'medium', message: `Low loss ratio (${lr}%) with ${input.priorClaims} prior claims looks inconsistent — verify the experience data.` });
  if (limit > 0 && epi > 0) {
    const rol = (epi / limit) * 100;
    if (rol < 1) flags.push({ code: 'ROL_THIN', severity: 'high', message: `Rate on line ~${rol.toFixed(2)}% is very thin for the exposure — check the pricing basis.` });
  }
  if (input.catExposed && input.structure === 'CAT_XL' && (input.terms?.returnPeriodYears == null)) {
    flags.push({ code: 'NO_RETURN_PERIOD', severity: 'medium', message: 'Cat-exposed CAT XL with no modelled return period — attach a cat-model reference.' });
  }
  if ((input.yearsWithCedent ?? 0) === 0) flags.push({ code: 'NEW_CEDENT', severity: 'low', message: 'New cedent relationship — no prior experience with this counterparty.' });
  if (epi === 0 && (input.riskBand === 'HIGH' || input.riskBand === 'ELEVATED')) flags.push({ code: 'NO_PREMIUM_HIGH_RISK', severity: 'medium', message: 'Elevated/high risk with no premium captured — price before referral.' });
  return flags;
}

const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? 'n/a' : new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(Number(minor) / 100);

/** A plain-language executive summary for a referral note or slip cover page. */
export function executiveSummary(input: AdvisorInput): string {
  const ccy = input.currency ?? 'USD';
  const kind = (input.kind ?? 'treaty').toLowerCase();
  const structure = input.structure ? input.structure.replace(/_/g, ' ').toLowerCase() : 'risk';
  const line = input.lineOfBusiness ? input.lineOfBusiness.replace(/_/g, ' ').toLowerCase() : 'multi-line';
  const parts: string[] = [];
  parts.push(`${input.title ?? 'This submission'} is a ${kind} ${structure} covering ${line} business${input.territory ? ` in ${input.territory}` : ''}${input.cedentName ? `, ceded by ${input.cedentName}` : ''}.`);
  if (input.limitMinor || input.attachmentMinor) {
    parts.push(`It presents ${money(input.limitMinor, ccy)} of limit${input.attachmentMinor ? ` excess of ${money(input.attachmentMinor, ccy)}` : ''}, against ${money(input.estPremiumMinor, ccy)} estimated premium${input.lossRatioPct != null ? ` at a ${input.lossRatioPct}% historical loss ratio` : ''}.`);
  } else {
    parts.push(`Estimated premium income is ${money(input.estPremiumMinor, ccy)}${input.lossRatioPct != null ? ` at a ${input.lossRatioPct}% historical loss ratio` : ''}.`);
  }
  if (input.riskScore != null) {
    parts.push(`RIOS scores the risk ${input.riskScore}/100 (${(input.riskBand ?? '').toLowerCase() || 'unbanded'})${input.catExposed ? ', and it is catastrophe-exposed' : ''}.`);
  }
  const flags = attentionFlags(input);
  if (flags.length) parts.push(`${flags.length} item(s) flagged for review, including: ${flags[0]!.message}`);
  else parts.push('No consistency issues were flagged.');
  return parts.join(' ');
}
