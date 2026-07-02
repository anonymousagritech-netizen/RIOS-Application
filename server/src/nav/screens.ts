/**
 * Canonical screen registry for the embedded assistant's navigation intent.
 *
 * The assistant runs in the server and cannot import the web client's
 * `web/src/app/nav.ts`, yet the two must not drift. This module is the
 * server-side mirror of the sidebar information architecture (NAV_GROUPS) plus
 * every additional route wired in `web/src/app/App.tsx`. Every user-reachable
 * screen appears exactly once with a stable `path`, a human `label`, and a rich
 * set of `aliases` / synonyms so natural phrasings ("open the underwriting
 * workbench please", "uw", "accounts") resolve to the right route.
 *
 * When a route is added to the web client, add it here too so "open X" keeps
 * covering the whole platform.
 */

export interface Screen {
  /** Client router path the navigate action targets. */
  path: string;
  /** Human-facing name shown in the reply and used as an exact match target. */
  label: string;
  /** Synonyms / natural phrasings that should resolve to this screen. */
  aliases: string[];
  /** Optional permission the underlying page enforces; used to rank suggestions. */
  permission?: string;
}

/**
 * The registry. Aliases are lower-cased at resolution time, so list them in a
 * readable form here. Keep exact alias phrases unique across screens so an
 * exact match is never ambiguous (contains/fuzzy handle the rest).
 */
export const SCREENS: Screen[] = [
  // ---- Overview --------------------------------------------------------
  { path: '/dashboard', label: 'Dashboard', aliases: ['dashboard', 'home', 'overview', 'main', 'start'] },
  { path: '/executive', label: 'Executive', aliases: ['executive', 'executive dashboard', 'exec', 'c-suite', 'leadership'], permission: 'reporting:read' },
  { path: '/intelligence', label: 'Intelligence', aliases: ['intelligence', 'insights', 'ocr', 'prediction', 'predictions', 'smart insights'] },
  { path: '/ai-insights', label: 'AI Insights', aliases: ['ai insights', 'ai', 'artificial intelligence', 'machine learning', 'ml insights'] },
  { path: '/search', label: 'Search', aliases: ['search', 'global search', 'find', 'lookup'] },
  { path: '/mobile', label: 'Mobile', aliases: ['mobile', 'mobile app', 'phone', 'handheld'] },

  // ---- Underwriting ----------------------------------------------------
  { path: '/w/underwriting', label: 'Underwriting Workspace', aliases: ['underwriting', 'underwriting workspace', 'underwriting workbench', 'workbench', 'uw', 'uw workspace', 'uw workbench', 'submissions', 'submission pipeline'], permission: 'treaty:read' },
  { path: '/underwriting', label: 'Underwriting Home', aliases: ['underwriting home', 'underwriting board', 'underwriting page', 'underwriting list'], permission: 'treaty:read' },
  { path: '/underwriting/analytics', label: 'Underwriting Analytics', aliases: ['underwriting analytics', 'uw analytics', 'underwriting metrics', 'underwriting stats'], permission: 'treaty:read' },
  { path: '/underwriting/approvals', label: 'Underwriting Approvals', aliases: ['underwriting approvals', 'uw approvals', 'referrals', 'referral queue'], permission: 'treaty:read' },
  { path: '/w/treaty', label: 'Treaty Workspace', aliases: ['treaty workspace', 'treaty workbench'], permission: 'treaty:read' },
  { path: '/treaties', label: 'Treaties', aliases: ['treaty', 'treaties', 'contracts', 'contract', 'treaty list', 'reinsurance treaties'], permission: 'treaty:read' },
  { path: '/treaty-admin', label: 'Treaty Admin', aliases: ['treaty admin', 'treaty administration', 'treaty setup', 'treaty config'], permission: 'treaty:read' },
  { path: '/w/facultative', label: 'Facultative Workspace', aliases: ['facultative', 'facultative workspace', 'fac', 'fac workspace', 'facultative workbench'], permission: 'facultative:read' },
  { path: '/facultative', label: 'Facultative', aliases: ['facultative page', 'facultative business', 'facultative risks'], permission: 'facultative:read' },
  { path: '/facultative-admin', label: 'Facultative Admin', aliases: ['facultative admin', 'facultative administration', 'fac admin'], permission: 'facultative:read' },
  { path: '/placement', label: 'Placement', aliases: ['placement', 'slip', 'slips', 'placing', 'placements'], permission: 'placement:read' },
  { path: '/pricing', label: 'Pricing', aliases: ['pricing', 'rating', 'rater', 'price', 'rate'], permission: 'pricing:read' },
  { path: '/w/capacity-exposure', label: 'Capacity & Exposure', aliases: ['capacity', 'capacity and exposure', 'capacity & exposure', 'capacity exposure', 'capacity management', 'utilisation', 'utilization'], permission: 'exposure:read' },
  { path: '/capacity', label: 'Capacity Lines', aliases: ['capacity lines', 'capacity line', 'capacity board'], permission: 'exposure:read' },
  { path: '/exposure', label: 'Exposure', aliases: ['exposure', 'accumulation', 'accumulations', 'aggregate', 'aggregates', 'peak zone', 'tiv'], permission: 'exposure:read' },
  { path: '/exposure-management', label: 'Exposure Management', aliases: ['exposure management', 'manage exposure', 'exposure admin'], permission: 'exposure:read' },
  { path: '/w/territory', label: 'Territory Workspace', aliases: ['territory', 'territories', 'territory workspace', 'geography', 'regions'], permission: 'exposure:read' },
  { path: '/territories', label: 'Territories', aliases: ['territories list', 'territory list'], permission: 'exposure:read' },
  { path: '/territory-management', label: 'Territory Management', aliases: ['territory management', 'manage territories'], permission: 'exposure:read' },
  { path: '/retrocession', label: 'Retrocession', aliases: ['retrocession', 'retro', 'outward', 'outwards', 'ceded business', 'outward reinsurance'], permission: 'retro:read' },
  { path: '/adjustments', label: 'Adjustments', aliases: ['adjustments', 'treaty adjustments', 'profit commission', 'portfolio transfer', 'endorsements', 'commutation'], permission: 'treaty:read' },

  // ---- Distribution ----------------------------------------------------
  { path: '/parties', label: 'Parties', aliases: ['parties', 'party', 'counterparties', 'counterparty', 'companies'], permission: 'party:read' },
  { path: '/clients', label: 'Clients', aliases: ['clients', 'client', 'customers', 'insureds'], permission: 'party:read' },
  { path: '/brokers', label: 'Brokers', aliases: ['brokers', 'broker', 'intermediaries', 'broker directory'], permission: 'party:read' },
  { path: '/cedents', label: 'Cedents', aliases: ['cedents', 'cedent', 'ceding companies', 'ceding company', 'reinsureds'], permission: 'party:read' },
  { path: '/crm', label: 'CRM', aliases: ['crm', 'pipeline', 'opportunities', 'opportunity', 'deals', 'leads', 'sales'], permission: 'crm:read' },

  // ---- Operations ------------------------------------------------------
  { path: '/claims', label: 'Claims', aliases: ['claims', 'claim', 'losses', 'loss register', 'claims register'], permission: 'claims:read' },
  { path: '/bordereaux', label: 'Bordereaux', aliases: ['bordereaux', 'bordereau', 'bdx', 'risk bordereau', 'premium bordereau'], permission: 'bordereaux:read' },
  { path: '/recoveries', label: 'Recoveries', aliases: ['recoveries', 'recovery', 'salvage', 'subrogation', 'cash call', 'cash calls'], permission: 'claims:read' },
  { path: '/w/operations', label: 'Operations Center', aliases: ['operations', 'operations center', 'operations centre', 'ops', 'ops center', 'sla', 'tasks'], permission: 'ops:read' },
  { path: '/operations', label: 'Ops Console', aliases: ['ops console', 'operations console', 'observability', 'system health', 'health', 'metrics'], permission: 'ops:read' },
  { path: '/w/workflow', label: 'Workflow Center', aliases: ['workflow', 'workflow center', 'workflow centre', 'approvals', 'approval queue'], permission: 'workflow:read' },
  { path: '/workflow', label: 'Workflow', aliases: ['workflow board', 'workflow queue', 'workflow tasks'], permission: 'workflow:read' },
  { path: '/workflow-engine', label: 'Workflow Engine', aliases: ['workflow engine', 'process engine', 'bpm', 'workflow designer'] },
  { path: '/audit', label: 'Audit Log', aliases: ['audit', 'audit log', 'audit trail', 'activity log'], permission: 'ops:read' },
  { path: '/tasks', label: 'Tasks', aliases: ['tasks', 'task board', 'my tasks', 'to do', 'todo'] },
  { path: '/notifications', label: 'Notifications', aliases: ['notifications', 'alerts', 'notification queue', 'bell'] },

  // ---- Finance ---------------------------------------------------------
  { path: '/accounting', label: 'Accounting', aliases: ['accounting', 'accounts', 'bookings', 'postings', 'journal'], permission: 'accounting:read' },
  { path: '/statements', label: 'Statements', aliases: ['statements', 'statement', 'statement of account', 'soa', 'account current'], permission: 'statement:read' },
  { path: '/finance', label: 'Finance', aliases: ['finance', 'financials', 'ledger', 'general ledger', 'gl', 'trial balance', 'invoices', 'invoice'], permission: 'finance:read' },
  { path: '/treasury', label: 'Treasury', aliases: ['treasury', 'investment', 'investments', 'cash management', 'liquidity'], permission: 'treasury:read' },
  { path: '/bureau', label: 'Bureau / ACORD', aliases: ['bureau', 'acord', 'ebot', 'ecot', 'dxc', 'lloyds', 'market messaging', 'technical accounting message'], permission: 'accounting:read' },
  { path: '/period-close', label: 'Period Close', aliases: ['period close', 'close', 'month end', 'closing', 'financial close'], permission: 'finance:read' },
  { path: '/procurement', label: 'Procurement', aliases: ['procurement', 'purchase', 'purchasing', 'purchase orders', 'po', 'vendors', 'vendor', 'suppliers'], permission: 'procurement:read' },

  // ---- Analytics & Compliance -----------------------------------------
  { path: '/reports', label: 'Reports', aliases: ['reports', 'report', 'reporting'], permission: 'reporting:read' },
  { path: '/scheduled-reports', label: 'Scheduled Reports', aliases: ['scheduled reports', 'report schedule', 'report subscriptions'], permission: 'reporting:read' },
  { path: '/analytics', label: 'Analytics', aliases: ['analytics', 'pivot', 'cube', 'aal', 'pml', 'data analytics'], permission: 'reporting:read' },
  { path: '/risk-capital', label: 'Risk & Capital', aliases: ['risk capital', 'risk & capital', 'risk and capital', 'capital', 'scr', 'var', 'solvency ratio', 'risk'], permission: 'risk:read' },
  { path: '/regulatory', label: 'Regulatory', aliases: ['regulatory', 'regulation', 'ifrs', 'solvency', 'schedule f', 'qrt', 'regulator'], permission: 'regulatory:read' },
  { path: '/compliance', label: 'Compliance', aliases: ['compliance', 'controls', 'compliant', 'kyc', 'aml'], permission: 'regulatory:read' },
  { path: '/returns', label: 'Returns', aliases: ['returns', 'regulatory returns', 'filings', 'disclosures'], permission: 'regulatory:read' },

  // ---- HRMS ------------------------------------------------------------
  { path: '/attendance', label: 'Attendance', aliases: ['attendance', 'punch', 'geofence', 'timesheet', 'timesheets', 'clock in'], permission: 'hr:read' },
  { path: '/hr', label: 'People', aliases: ['people', 'hr', 'hrms', 'human resources', 'employees', 'employee', 'staff'], permission: 'hr:read' },
  { path: '/payroll', label: 'Payroll', aliases: ['payroll', 'payslip', 'payslips', 'salary', 'wages', 'pay run'], permission: 'hr:read' },
  { path: '/performance', label: 'Performance', aliases: ['performance', 'appraisal', 'appraisals', 'review', 'reviews', 'kpi'], permission: 'hr:read' },
  { path: '/assets', label: 'Assets', aliases: ['assets', 'asset', 'licenses', 'license', 'entitlements', 'equipment'], permission: 'asset:read' },
  { path: '/organization', label: 'Org Structure', aliases: ['org structure', 'organization', 'org chart', 'organisation chart', 'departments'], permission: 'platform:read' },

  // ---- Master Data -----------------------------------------------------
  { path: '/products', label: 'Products', aliases: ['products', 'product', 'catalog', 'catalogue', 'parametric', 'ilw', 'product catalog'], permission: 'product:read' },

  // ---- Documents & Knowledge ------------------------------------------
  { path: '/documents', label: 'Documents', aliases: ['documents', 'document', 'templates', 'template', 'files', 'library'], permission: 'documents:read' },

  // ---- Integration & Automation ---------------------------------------
  { path: '/w/integration', label: 'Integration Hub', aliases: ['integration', 'integrations', 'integration hub', 'webhooks', 'webhook', 'connectors', 'api', 'export', 'import'], permission: 'integration:read' },
  { path: '/integration', label: 'Integration Center', aliases: ['integration center', 'integration centre', 'data integration'], permission: 'integration:read' },
  { path: '/integration-hub', label: 'Integration Hub Console', aliases: ['integration hub console', 'integration console'], permission: 'integration:read' },
  { path: '/messaging', label: 'Messaging', aliases: ['messaging', 'messages', 'email', 'sms', 'notification queue', 'inbox'], permission: 'integration:read' },
  { path: '/w/automation', label: 'Automation Studio', aliases: ['automation', 'automation studio', 'no code', 'no-code', 'rules', 'triggers'], permission: 'config:read' },
  { path: '/automation-studio', label: 'Automation Studio Console', aliases: ['automation studio console', 'automation console'], permission: 'config:read' },
  { path: '/scheduler', label: 'Scheduler', aliases: ['scheduler', 'cron', 'cron job', 'cron jobs', 'scheduled jobs', 'jobs'] },
  { path: '/designer', label: 'Designer', aliases: ['designer', 'form builder', 'no code designer', 'page builder', 'ui builder'] },
  { path: '/marketplace', label: 'Marketplace', aliases: ['marketplace', 'app store', 'apps', 'install app', 'extensions', 'plugins'] },
  { path: '/portal', label: 'Portal', aliases: ['portal', 'broker portal', 'cedent portal', 'client portal', 'external portal'], permission: 'portal:read' },

  // ---- Administration --------------------------------------------------
  { path: '/admin', label: 'Admin', aliases: ['admin', 'administration', 'settings', 'configuration', 'config', 'code lists', 'code list', 'setup'], permission: 'admin:manage' },
  { path: '/formulas', label: 'Formula Engine', aliases: ['formulas', 'formula', 'formula engine', 'formula management', 'calculations engine'] },
  { path: '/organisation', label: 'Legal Entities', aliases: ['legal entities', 'legal entity', 'entities', 'group companies'], permission: 'platform:read' },
  { path: '/delegation', label: 'Delegation', aliases: ['delegation', 'delegate authority', 'binding authority', 'delegated authority'] },
  { path: '/security', label: 'Security', aliases: ['security', 'mfa', 'sso', 'webauthn', 'passkey', 'passkeys', 'two factor'] },
  { path: '/security-ops', label: 'Security Ops', aliases: ['security ops', 'secops', 'security operations', 'threats', 'security monitoring'], permission: 'ops:read' },
  { path: '/field-security', label: 'Field Security', aliases: ['field security', 'field level security', 'data masking', 'field masking'] },
  { path: '/retention', label: 'Retention', aliases: ['retention', 'data retention', 'archival', 'archive', 'purge'], permission: 'retention:read' },
  { path: '/cost', label: 'Cost Management', aliases: ['cost', 'cost management', 'costs', 'spend', 'usage cost'], permission: 'cost:read' },
  { path: '/features', label: 'Features', aliases: ['features', 'feature flags', 'flags', 'toggles', 'feature toggles'], permission: 'platform:read' },
];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** How confidently the query matched a screen. */
export type MatchConfidence = 'exact' | 'contains' | 'fuzzy' | 'none';

export interface ScreenResolution {
  screen: Screen | null;
  confidence: MatchConfidence;
  /** Real screens to suggest when nothing (or only a weak) match is found. */
  suggestions: Screen[];
}

/** Command verbs / filler stripped from the head of a "go to X" phrase. */
const COMMAND_PREFIX =
  /^(?:please\s+)?(?:can you\s+|could you\s+|i(?:'d| would) like to\s+|i want to\s+)?(?:go to|goto|open( up)?|show( me)?|take me to|navigate to|nav to|bring up|pull up|launch|jump to|switch to|display|view|see|visit|give me)\s+/i;

/** Filler words that carry no screen meaning; dropped as whole tokens. */
const FILLER = new Set(['the', 'a', 'an', 'me', 'to', 'my', 'our', 'please', 'screen', 'page', 'module', 'section', 'tab', 'view', 'for', 'of', 'on', 'in', 'up']);

/** Normalise a phrase: lower-case, strip punctuation, collapse whitespace. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9&\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip the command verb and filler words, leaving the screen target text. */
function extractQuery(message: string): string {
  let q = normalise(message).replace(COMMAND_PREFIX, '');
  q = normalise(q);
  const kept = q.split(' ').filter((t) => t && !FILLER.has(t));
  // Keep filler-stripped form, but fall back to the raw query if we stripped
  // everything (e.g. the phrase was only filler words).
  return kept.length ? kept.join(' ') : q;
}

function tokens(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

/** Classic Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** 0..1 string similarity from normalised edit distance. */
function editSim(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * 0..1 similarity between the query and a candidate alias, combining a
 * whole-string edit similarity with a token-overlap (Jaccard-style) measure so
 * that both minor typos ("underwritng") and extra words ("underwriting
 * workbench please") still score highly.
 */
function similarity(query: string, candidate: string): number {
  if (query === candidate) return 1;
  const qt = tokens(query);
  const ct = tokens(candidate);
  // Token overlap: how many candidate tokens are (fuzzily) present in the query.
  let matched = 0;
  for (const c of ct) {
    if (qt.some((q) => q === c || (c.length >= 4 && editSim(q, c) >= 0.8))) matched++;
  }
  const overlap = ct.length ? matched / ct.length : 0;
  // Penalise when the candidate covers only a small part of a long query so a
  // single shared token in a rambling phrase doesn't count as a strong match.
  const coverage = qt.length ? matched / qt.length : 0;
  const tokenScore = overlap * (0.6 + 0.4 * coverage);
  return Math.max(editSim(query, candidate), tokenScore);
}

const FUZZY_THRESHOLD = 0.62;

/** Screens featured in fallback suggestions (must exist in SCREENS). */
const FEATURED_PATHS = ['/dashboard', '/w/underwriting', '/treaties', '/claims', '/finance', '/portal'];

function permitted(screen: Screen, perms: string[] | undefined): boolean {
  if (!perms) return true;
  if (perms.includes('admin:manage')) return true;
  return !screen.permission || perms.includes(screen.permission);
}

/**
 * Resolve a navigation phrase to a screen.
 *
 * Strategy (most to least confident):
 *  1. exact    - the target text equals a label or alias exactly
 *  2. contains - a label/alias appears as a whole phrase inside the target
 *                (or vice-versa); the longest such match wins
 *  3. fuzzy    - best combined edit/token similarity above a threshold
 *
 * Suggestions are always real screens (fuzzy-ranked, else a featured set),
 * filtered by the caller's permissions when provided. Navigation itself is not
 * permission-gated (the target page enforces its own access), matching the
 * platform's existing open-navigation behaviour.
 */
export function resolveScreen(message: string, perms?: string[]): ScreenResolution {
  const query = extractQuery(message);
  const suggestionsFor = () => buildSuggestions(query, perms);

  if (!query) return { screen: null, confidence: 'none', suggestions: suggestionsFor() };

  // 1. Exact match on label or any alias.
  for (const s of SCREENS) {
    const cands = [s.label, ...s.aliases].map(normalise);
    if (cands.includes(query)) return { screen: s, confidence: 'exact', suggestions: [] };
  }

  // 2. Whole-phrase containment (either direction), longest candidate wins.
  const paddedQ = ` ${query} `;
  let best: { s: Screen; len: number } | null = null;
  for (const s of SCREENS) {
    for (const cand of [s.label, ...s.aliases]) {
      const c = normalise(cand);
      if (c.length < 3) continue; // avoid spurious 2-char hits inside words
      const contained = paddedQ.includes(` ${c} `) || ` ${c} `.includes(paddedQ);
      if (contained && (!best || c.length > best.len)) best = { s, len: c.length };
    }
  }
  if (best) return { screen: best.s, confidence: 'contains', suggestions: [] };

  // 3. Fuzzy: best similarity across all aliases.
  let top: { s: Screen; score: number } | null = null;
  for (const s of SCREENS) {
    for (const cand of [s.label, ...s.aliases]) {
      const score = similarity(query, normalise(cand));
      if (!top || score > top.score) top = { s, score };
    }
  }
  if (top && top.score >= FUZZY_THRESHOLD) {
    return { screen: top.s, confidence: 'fuzzy', suggestions: [] };
  }

  return { screen: null, confidence: 'none', suggestions: suggestionsFor() };
}

/** Rank a few real screens to suggest, best-effort by relevance to the query. */
function buildSuggestions(query: string, perms?: string[]): Screen[] {
  const pool = SCREENS.filter((s) => permitted(s, perms));
  if (query) {
    const ranked = pool
      .map((s) => ({ s, score: Math.max(...[s.label, ...s.aliases].map((c) => similarity(query, normalise(c)))) }))
      .sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score >= 0.35) return ranked.slice(0, 4).map((r) => r.s);
  }
  const featured = FEATURED_PATHS.map((p) => pool.find((s) => s.path === p)).filter((s): s is Screen => !!s);
  return (featured.length ? featured : pool).slice(0, 5);
}
