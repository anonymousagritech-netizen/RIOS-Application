/**
 * Underwriting report generation - printable slip / quote / UW summary.
 *
 * Rather than pull in a heavy PDF toolchain, reports are rendered as a styled,
 * self-contained HTML document and handed to the browser's print pipeline
 * (window.print → "Save as PDF"). This keeps the client dependency-free while
 * producing a clean, paginated document an underwriter can file or send to
 * market. CSV export (Excel) is served by the server.
 *
 * The report is assembled from data the workbench already holds: the submission
 * detail, the model catalog (for term labels/types) and, when present, a pricing
 * scenario. Nothing here fetches or mutates.
 */

export type ReportKind = 'slip' | 'quote' | 'summary';

interface ModelField { key: string; label: string; type: string; unit?: string; }
interface ModelStructure { key: string; label: string; fields: ModelField[] }
interface ModelLine { key: string; label: string; fields: ModelField[] }
interface Catalog { structures: ModelStructure[]; lines: ModelLine[] }

interface Contribution { factor: string; points: number; detail: string }
interface Submission {
  reference: string; title: string; kind: string; basis: string | null; structure: string | null;
  lineOfBusiness: string | null; currency: string; stage: string;
  cedentName: string | null; brokerName: string | null;
  inception: string | null; expiry: string | null; territory: string | null;
  sumInsuredMinor: number | null; attachmentMinor: number | null; limitMinor: number | null;
  estPremiumMinor: number | null; targetPremiumMinor: number | null;
  lossRatioPct: number | null; catExposed: boolean;
  riskScore: number | null; riskBand: string | null; scoreBreakdown: Contribution[];
  terms: Record<string, unknown> | null;
}
interface ScenarioBase { lossRatioPct: number; expenseRatioPct: number; combinedRatioPct: number; marginPct: number }
interface Scenario { base: ScenarioBase }

const TITLES: Record<ReportKind, string> = {
  slip: 'Reinsurance Slip',
  quote: 'Quotation',
  summary: 'Underwriting Summary',
};

const money = (minor: number | null | undefined, ccy = 'USD') =>
  minor == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(Number(minor) / 100);

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const title = (s: string) => s.replace(/_/g, ' ').replace(/\w\S*/g, (w) => (w[0] ?? '').toUpperCase() + w.slice(1).toLowerCase());

function fmtTerm(field: ModelField, value: unknown, ccy: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'money') return money(Number(value), ccy);
  if (field.type === 'percent') return `${value}%`;
  if (field.type === 'number') return `${value}${field.unit ? ' ' + field.unit : ''}`;
  return esc(value);
}

function row(label: string, value: string): string {
  return `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
}

function section(heading: string, inner: string): string {
  return `<section><h2>${esc(heading)}</h2>${inner}</section>`;
}

export function buildReportHtml(kind: ReportKind, s: Submission, catalog: Catalog | undefined, scenario: Scenario | null): string {
  const ccy = s.currency || 'USD';
  const structure = catalog?.structures.find((x) => x.key === s.structure);
  const line = catalog?.lines.find((x) => x.key === s.lineOfBusiness);
  const modelFields: ModelField[] = [...(structure?.fields ?? []), ...(line?.fields ?? [])];
  const terms = s.terms ?? {};

  // --- Risk identification ---
  const ident = `<table class="kv">
    ${row('Reference', esc(s.reference))}
    ${row('Reinsured / cedent', esc(s.cedentName ?? 'TBC'))}
    ${row('Broker', esc(s.brokerName ?? 'Direct / none'))}
    ${row('Type', `${esc(title(s.kind))}${s.structure ? ' · ' + esc(structure?.label ?? title(s.structure)) : ''}`)}
    ${row('Line of business', esc(line?.label ?? (s.lineOfBusiness ? title(s.lineOfBusiness) : '—')))}
    ${row('Basis', esc(s.basis ? title(s.basis) : '—'))}
    ${row('Period', s.inception ? `${esc(s.inception)} to ${esc(s.expiry ?? '?')}` : '—')}
    ${row('Territory', esc(s.territory ?? '—'))}
  </table>`;

  // --- Headline terms ---
  const headline = `<table class="kv">
    ${row('Sum insured / limit', money(s.sumInsuredMinor, ccy))}
    ${row('Attachment', money(s.attachmentMinor, ccy))}
    ${row('Layer limit', money(s.limitMinor, ccy))}
    ${row('Estimated premium income', money(s.estPremiumMinor, ccy))}
  </table>`;

  // --- Model-specific terms ---
  const modelRows = modelFields
    .filter((f) => terms[f.key] !== undefined && terms[f.key] !== null && terms[f.key] !== '')
    .map((f) => row(f.label, fmtTerm(f, terms[f.key], ccy)))
    .join('');
  const modelSection = modelRows ? section(`${structure?.label ?? line?.label ?? 'Model'} terms`, `<table class="kv">${modelRows}</table>`) : '';

  // --- Risk assessment (slip + summary) ---
  const riskRows = (s.scoreBreakdown ?? [])
    .map((c) => `<tr><td>${esc(c.factor)}</td><td>${esc(c.detail)}</td><td class="num">${c.points > 0 ? '+' : ''}${c.points}</td></tr>`)
    .join('');
  const riskSection = section('Risk assessment',
    `<p class="score">Risk score <strong>${s.riskScore ?? '—'}</strong> / 100 · <span class="band band-${esc(s.riskBand ?? '')}">${esc(s.riskBand ? title(s.riskBand) : '—')}</span></p>
     <table class="grid"><thead><tr><th>Factor</th><th>Basis</th><th>Points</th></tr></thead><tbody>${riskRows}</tbody></table>`);

  // --- Pricing (quote + summary) ---
  const pricingRows = `<table class="kv">
    ${row('Estimated premium income', money(s.estPremiumMinor, ccy))}
    ${row('Technical premium', s.targetPremiumMinor ? money(s.targetPremiumMinor, ccy) : 'Not yet priced')}
    ${row('Historical loss ratio', s.lossRatioPct != null ? `${s.lossRatioPct}%` : '—')}
    ${scenario ? row('Modelled combined ratio', `${scenario.base.combinedRatioPct}%`) : ''}
    ${scenario ? row('Underwriting margin', `${scenario.base.marginPct}%`) : ''}
  </table>`;

  // Assemble the body per report kind.
  const parts: string[] = [section('Risk identification', ident)];
  if (kind === 'slip' || kind === 'summary') { parts.push(section('Headline terms', headline)); if (modelSection) parts.push(modelSection); }
  if (kind === 'quote' || kind === 'summary') parts.push(section('Pricing', pricingRows));
  if (kind === 'slip' || kind === 'summary') parts.push(riskSection);
  if (kind === 'quote') { parts.push(section('Terms', headline)); if (modelSection) parts.push(modelSection); }

  const stamp = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.reference)} · ${TITLES[kind]}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, Segoe UI, Roboto, sans-serif; color: #1e293b; margin: 0; padding: 40px; font-size: 12px; line-height: 1.5; }
    header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2563EB; padding-bottom: 16px; margin-bottom: 24px; }
    .brand { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; color: #2563EB; }
    .brand span { color: #94a3b8; font-weight: 600; }
    .doctype { text-align: right; }
    .doctype h1 { font-size: 16px; margin: 0; text-transform: uppercase; letter-spacing: 0.04em; }
    .doctype p { margin: 2px 0 0; color: #64748b; font-size: 11px; }
    h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #2563EB; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin: 22px 0 10px; }
    .title { font-size: 15px; font-weight: 700; margin: 0 0 4px; }
    .subtitle { color: #64748b; margin: 0 0 8px; }
    table { width: 100%; border-collapse: collapse; }
    table.kv th { text-align: left; width: 40%; color: #64748b; font-weight: 500; padding: 4px 8px 4px 0; vertical-align: top; }
    table.kv td { padding: 4px 0; font-weight: 600; }
    table.grid th, table.grid td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eef2f7; }
    table.grid thead th { color: #64748b; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
    .score { font-size: 13px; }
    .band { padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 11px; }
    .band-LOW { background: #dcfce7; color: #16a34a; } .band-MODERATE { background: #fef9c3; color: #ca8a04; }
    .band-ELEVATED { background: #ffedd5; color: #ea580c; } .band-HIGH { background: #fee2e2; color: #dc2626; }
    footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 10px; display: flex; justify-content: space-between; }
    section { break-inside: avoid; }
    @media print { body { padding: 24px; } @page { margin: 16mm; } }
  </style></head><body>
    <header>
      <div><div class="brand">RIOS <span>· Reinsurance Intelligent Operating System</span></div></div>
      <div class="doctype"><h1>${TITLES[kind]}</h1><p>${esc(s.reference)}</p><p>${esc(stamp)}</p></div>
    </header>
    <p class="title">${esc(s.title)}</p>
    <p class="subtitle">${esc(title(s.stage))} · ${esc(ccy)}</p>
    ${parts.join('')}
    <footer><span>Generated by RIOS Underwriting Workbench</span><span>Confidential · for market use</span></footer>
  </body></html>`;
}

/** Open the report in a new window and trigger the print dialog. */
export function printReport(kind: ReportKind, s: Submission, catalog: Catalog | undefined, scenario: Scenario | null): void {
  const html = buildReportHtml(kind, s, catalog, scenario);
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  // Give the new document a tick to lay out before printing.
  setTimeout(() => { try { w.print(); } catch { /* user can print manually */ } }, 300);
}

/* ============================================================================
 * Board / Executive report — a consolidated underwriting pack composed from the
 * analytics endpoints. Printable (→ PDF), no dependencies.
 * ========================================================================== */

export interface BoardReportData {
  generatedAt: string;
  kpis?: { open: number; bound: number; pipelineEpiMinor: number; avgRiskScore: number; hitRatioPct: number };
  portfolio?: { totalEpiMinor: number; byStructure: { key: string; n: number; epi: number }[]; byLineOfBusiness: { key: string; n: number; epi: number }[]; topCedents: { key: string; n: number; epi: number }[] };
  cat?: { totalAalMinor: number; bookPmlMinor: Record<number, number>; bookTvar99Minor: number };
  claims?: { lossRatioPct: number; totals: { claimCount: number; incurredMinor: number; outstandingMinor: number }; technicalAccount: { combinedRatioPct: number; technicalResultMinor: number } };
  finance?: { totals: { premiumMinor: number; commissionMinor: number; claimsMinor: number }; technicalAccount: { combinedRatioPct: number; technicalResultMinor: number } };
  renewal?: { book: { upForRenewal: number; retentionRatePct: number; avgRateChangePct: number | null } };
}

function kpiCards(cards: { label: string; value: string }[]): string {
  return `<div class="kpirow">${cards.map((c) => `<div class="kpi"><span class="kpiLabel">${esc(c.label)}</span><span class="kpiValue">${esc(c.value)}</span></div>`).join('')}</div>`;
}

export function buildBoardReportHtml(d: BoardReportData): string {
  const parts: string[] = [];

  if (d.kpis) {
    parts.push(section('Executive summary', kpiCards([
      { label: 'Open submissions', value: String(d.kpis.open) },
      { label: 'Pipeline EPI', value: money(d.kpis.pipelineEpiMinor) },
      { label: 'Bound', value: String(d.kpis.bound) },
      { label: 'Hit ratio', value: `${d.kpis.hitRatioPct}%` },
      { label: 'Avg risk score', value: `${d.kpis.avgRiskScore}/100` },
    ])));
  }
  if (d.portfolio) {
    const rows = d.portfolio.byStructure.slice(0, 8).map((r) => row(title(r.key), `${r.n} risk(s) · ${money(r.epi)}`)).join('');
    const ced = d.portfolio.topCedents.slice(0, 6).map((r) => row(r.key, `${r.n} · ${money(r.epi)}`)).join('');
    parts.push(section('Portfolio', `<table class="kv">${row('Total EPI', money(d.portfolio.totalEpiMinor))}${rows}</table>`
      + (ced ? `<h3>Top cedents</h3><table class="kv">${ced}</table>` : '')));
  }
  if (d.cat) {
    const pmls = Object.entries(d.cat.bookPmlMinor).map(([rp, v]) => row(`${rp}-yr PML`, money(Number(v)))).join('');
    parts.push(section('Catastrophe', `<table class="kv">${row('Book AAL', money(d.cat.totalAalMinor))}${row('99% TVaR', money(d.cat.bookTvar99Minor))}${pmls}</table>`));
  }
  if (d.claims) {
    parts.push(section('Claims & loss experience', `<table class="kv">
      ${row('Claim count', String(d.claims.totals.claimCount))}
      ${row('Incurred', money(d.claims.totals.incurredMinor))}
      ${row('Outstanding reserves', money(d.claims.totals.outstandingMinor))}
      ${row('Loss ratio', `${d.claims.lossRatioPct}%`)}
    </table>`));
  }
  if (d.finance) {
    parts.push(section('Technical account', `<table class="kv">
      ${row('Premium', money(d.finance.totals.premiumMinor))}
      ${row('Commission', money(d.finance.totals.commissionMinor))}
      ${row('Claims', money(d.finance.totals.claimsMinor))}
      ${row('Combined ratio', `${d.finance.technicalAccount.combinedRatioPct}%`)}
      ${row('Technical result', money(d.finance.technicalAccount.technicalResultMinor))}
    </table>`));
  }
  if (d.renewal) {
    parts.push(section('Renewals', `<table class="kv">
      ${row('Up for renewal', String(d.renewal.book.upForRenewal))}
      ${row('Retention', `${d.renewal.book.retentionRatePct}%`)}
      ${row('Average rate change', d.renewal.book.avgRateChangePct == null ? 'n/a' : `${d.renewal.book.avgRateChangePct}%`)}
    </table>`));
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>RIOS Board Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, Segoe UI, Roboto, sans-serif; color: #1e293b; margin: 0; padding: 40px; font-size: 12px; line-height: 1.5; }
    header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #2563EB; padding-bottom: 16px; margin-bottom: 24px; }
    .brand { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; color: #2563EB; }
    .brand span { color: #94a3b8; font-weight: 600; }
    .doctype { text-align: right; }
    .doctype h1 { font-size: 16px; margin: 0; text-transform: uppercase; letter-spacing: 0.04em; }
    .doctype p { margin: 2px 0 0; color: #64748b; font-size: 11px; }
    h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #2563EB; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin: 22px 0 10px; }
    h3 { font-size: 11px; margin: 14px 0 6px; color: #475569; }
    table { width: 100%; border-collapse: collapse; }
    table.kv th { text-align: left; width: 45%; color: #64748b; font-weight: 500; padding: 4px 8px 4px 0; vertical-align: top; }
    table.kv td { padding: 4px 0; font-weight: 600; }
    .kpirow { display: flex; flex-wrap: wrap; gap: 10px; }
    .kpi { flex: 1 1 120px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
    .kpiLabel { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; font-weight: 700; }
    .kpiValue { display: block; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; margin-top: 3px; }
    footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 10px; display: flex; justify-content: space-between; }
    section { break-inside: avoid; }
    @media print { body { padding: 24px; } @page { margin: 16mm; } }
  </style></head><body>
    <header>
      <div><div class="brand">RIOS <span>· Reinsurance Intelligent Operating System</span></div></div>
      <div class="doctype"><h1>Board Report</h1><p>Underwriting portfolio</p><p>${esc(d.generatedAt)}</p></div>
    </header>
    ${parts.join('')}
    <footer><span>Generated by RIOS Underwriting Analytics</span><span>Confidential · board use only</span></footer>
  </body></html>`;
}

/** Compose the board report and hand it to the browser print pipeline. */
export function printBoardReport(d: BoardReportData): void {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return;
  w.document.write(buildBoardReportHtml(d));
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* manual */ } }, 300);
}
