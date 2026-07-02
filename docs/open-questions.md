# RIOS - Open Questions, Assumptions & Gaps Register

**Version:** 1.0 · **Status:** Living register (brief §3.3 - "no silent gaps")
**Roles consulted:** all standing roles (consolidated)

## Purpose & scope

The consolidated, honest register of what a real commercial delivery would still need beyond the current
**foundation / vertical slice**. Per the brief's precedence (§0, §3.3), nothing material is silently omitted:
anything deferred is named here. "Delivered", "designed-for", and "deferred" are used precisely.

- **Delivered:** built, working, tested.
- **Designed-for:** the architecture/schema permits it; not built.
- **Deferred:** explicitly out of the v1 slice.

---

## 1. Reinsurance domain depth

- **Cat modelling / exposure & aggregate management** - `risk.peril_zone` exists and the assistant can
  aggregate by zone; zonal aggregates, PML/MFL and RDS are delivered. **Third-party cat-model integration is
  now delivered as an ELT import**: the `catmodel` module imports an Event Loss Table (working CSV and JSON
  adapters, with a licensed RMS/AIR/CoreLogic vendor API as the labelled seam behind the same `CatEltImporter`
  interface), persists it (`cat_elt`/`cat_elt_event`), and computes + caches the standard cat metrics - AAL,
  the OEP exceedance curve and the PML profile at return periods - via the pure `@rios/domain/catastrophe`
  engine. Surfaced at `/cat-model`. (§7.8, §9.9, §13)
- **Pricing & rating** - burning-cost/experience rating, exposure rating (exposure curves + ILFs),
  capacity/authority checks and now **swing (retrospectively) rating** (`swingRatedPremium`: provisional vs
  loss-driven adjusted premium collared to [min, max]) are delivered in `@rios/domain/rating` and
  `@rios/domain/pricing`. Stochastic/credibility pricing blends remain designed-for. (§7.8, §29.5)
- **Bordereaux ingestion** - **delivered** as a pure engine (`@rios/domain/bordereaux`) wired into
  `POST /api/bordereaux`: a stored column-mapping projects arbitrary source headers onto canonical fields,
  each line is validated (amount present/positive, loss-date shape), amounts quantise to integer minor units,
  and the line sum is reconciled against an optional declared control total (out-of-balance files are
  REJECTED, not just error-free ones). Valid premium lines draft `INSTALMENT_PREMIUM` financial events; loss
  lines feed claims. **CSV file parsing is now delivered too** (`POST /api/bordereaux/parse`: RFC-4180 with
  quoted fields/escapes/CRLF, line-numbered errors, ragged-row detection, 50k-row cap). Excel (.xlsx)
  parsing and streaming/connector ingestion remain designed-for. (§7.10, §29.6)
- **Facultative & retrocession depth** - modelled in the schema (`contract_kind`, `direction`, party roles)
  but single-risk fast cession and fac-obligatory remain designed-for; **gross/ceded/net position across
  inwards+outwards is now delivered** (`GET /api/portfolio/net-position`: premium and losses per currency
  and line of business from the same `financial_event` source as the accounting chain, net === gross - ceded
  exact). (§7.4, §7.5)
- **Placement & slip (MRC)** management, signing-down workflow, written-vs-signed reconciliation UI - schema
  supports participations; flows are designed-for. (§7.3, §29.4)
- **Commutation & portfolio transfer** valuation is now delivered (`@rios/domain/commutation`): `commute`
  prices a commutation as the present value of outstanding plus a risk load and returns the economic
  gain/loss to cedent and reinsurer; `lossPortfolioTransfer` builds the LPT premium (PV + risk margin +
  expense load) and the ceding insurer's capital-relief benefit - unit-tested. **Indexation/stability
  clauses and the hours clause** are now delivered too (`@rios/domain/clauses`): `indexLayer` /
  `indexedRecovery` re-express an XL layer in settlement-date money (full index, franchise and
  severe-inflation variants) and `hoursClauseOccurrences` groups dated cat losses into occurrences bounded
  by a time window. Optimal hours-window placement and richer occurrence definitions remain designed-for.
- **Sliding scale** now offers both stepped (`slidingScaleCommission`) and **interpolated**
  (`slidingScaleInterpolated`) variants. **Reinstatement schedules** beyond the simple cumulative-fraction
  model remain a config-driven extension.

## 2. Accounting & finance breadth

- **FX & revaluation** - cross-currency arithmetic is deliberately rejected by the domain core (all crossing
  goes through explicit rates). A period-end **revaluation engine is now delivered** in `@rios/domain/fx`:
  single-item and portfolio revaluation to a closing rate, realized (on settlement) vs unrealized FX
  gain/loss with asset/liability sign correction, per-currency net open exposure, and balanced GL postings
  that reconcile to zero (unit-tested). What remains designed-for is the **live rate feed** into
  `exchange_rate` and wiring revaluation output into the period-close posting run. (§7.6, §16.1)
- **AR/AP** - invoices spin off on statement issue (`ar_invoice`/`ap_invoice`), and **aging + cash
  application are now delivered** (`@rios/domain/aging`: `agingReport` buckets outstanding by days past due
  with an outstanding-weighted average; `applyReceipt` allocates a receipt oldest/largest/as-is with
  integer-exact minor units; `invoiceStatus` resolves settled/part-paid/overdue). Surfaced at
  `GET /api/statements/aging?kind=AR|AP`. **Tax & levy** is now delivered too (`@rios/domain/tax`): a
  cascading levy stack (`computeLevies` with compounding lines), withholding tax, US **Federal Excise Tax**
  with income-tax-treaty exemption (`federalExciseTax`) and a tax gross-up (`grossUp`). **Bank reconciliation**
  is now delivered too (`@rios/domain/bankRec.reconcileBank`): reference-then-amount/date matching of book vs
  bank lines, surfacing deposits-in-transit / outstanding items and bank-only charges, and proving the
  reconciliation identity to zero. **Fixed assets** is now delivered too (`@rios/domain/fixedAssets`):
  straight-line and reducing-balance `depreciationSchedule` (never below residual, ties to cost - residual),
  `netBookValue` and disposal gain/loss. **Investments** now have an amortised-cost / effective-interest
  engine (`@rios/domain/treasury`): `effectivePeriodRate` (yield to maturity by bisection) and
  `amortisedCostSchedule` (IFRS 9 premium/discount amortisation converging to par at maturity, semi-annual
  supported), on top of the existing accrued-interest and portfolio valuation. **Cash-flow forecasting and a
  full treasury dealing/settlement sub-ledger are now delivered too** (migration `0067_treasury_dealing`):
  a dealing sub-ledger (`investment_trade`) captures BUY/SELL, confirms, then **settles by posting a balanced
  GL journal** through the accounting posting idiom (cash `1000` ↔ investments `1200`, illegal transitions
  409, all audited); cash-flow forecasting gathers scheduled premium/claim/trade-settlement cash items and
  buckets them via the pure `@rios/domain/cashflowForecast.bucketCashFlows` engine, persisting the forecast +
  lines. Market data is served by a **deterministic in-repo MOCK provider** (`market_price`, `source='MOCK'`)
  — a real vendor feed (Bloomberg/Refinitiv/ICE) is the labelled integration seam at
  `POST /api/treasury/market-data/refresh`. (§9.8, §16)
- **Statement-of-account lifecycle** (Open → Prepared → … → Settled) - **delivered**: guarded status
  transitions (`STATEMENT_TRANSITIONS`) with the AR/AP invoice spin-off on issue. (§28.5)
- **Profit-commission jurisdictional variants** - one common basis delivered; others would be configuration.

## 3. Claims & recoveries

- **Reinstatement processing** is delivered (`reinstatementPremium` in `@rios/domain/nonproportional`, wired
  at `POST /api/claims/:id/reinstatement`). **Recoveries collection, salvage & subrogation, inuring
  application order and event aggregation** are now delivered as a pure engine
  (`@rios/domain/claimsRecovery`): `recoveryPosition` nets a claim through its recovery ledger (received vs
  expected, by-type, floored net incurred/paid/outstanding) and backs `GET /api/claims/:id/net-position`;
  `applyInuring` nets inuring reinsurance before the protected layer; `aggregateByEvent` rolls claim losses
  to the occurrence level to feed `programmeRecovery`. What remains designed-for is the portfolio/programme
  rollup UI and the full reference-data-driven claim state machine. (§7.7)
- The implemented claim flow covers notify → reserve movement → paid-loss event; the full state machine is
  reference-data-driven but only partially wired.

## 4. Regulatory & compliance

- **IFRS 17** measurement is now delivered as a pure engine (`@rios/domain/ifrs17`): PAA (LRC roll-forward,
  LIC as discounted fulfilment cash flows + risk adjustment, onerous loss component), GMM/BBA initial
  measurement, the CSM roll-forward (interest accretion → new business → estimate changes → coverage-unit
  release), VFA, term-structure discounting (`presentValue`) and a multi-period CSM amortisation schedule
  (`csmProjection`) - all unit-tested. What remains designed-for is **persistence + disclosure reporting**
  (measurement tables, movement analysis and the IFRS 17 disclosure notes) and full yield-curve
  bootstrapping/illiquidity premia. (§18.1)
- **Solvency II** standard-formula Pillar 1 is now delivered as a pure engine (`@rios/domain/solvency2`):
  non-life premium/reserve risk, SCR module aggregation via a correlation matrix, BSCR + operational + LAC to
  the SCR, the MCR corridor (25-45% of SCR, AMCR floor), the **risk margin** (cost-of-capital method with
  discounting) and **own-funds tiering/eligibility** (Tier limits vs SCR and MCR) with the solvency ratio -
  all unit-tested. **ORSA** now has a delivered projection backbone (`@rios/domain/orsa`): `projectOrsa`
  rolls own funds forward against a projected SCR year by year (solvency ratio, surplus, SCR- and
  appetite-breach flags, first breach year) and `stressOrsa` re-projects under a shock scenario. What remains
  designed-for is the **full sub-module granularity** (every standard-formula sub-risk and the official
  correlation matrices); QRT **skeletons** (S.02.01, S.31.01) now ship as clearly-labelled templates - not
  certified content - via the report-pack engine (see statutory/market returns below). (§18.2)
- **Statutory/market returns** - a governed **report-pack assembler is now delivered**
  (`@rios/domain/reportPack`): template-driven sections and line items with computed sum/diff totals,
  completeness checks and control-total tie-outs, resolved iteratively regardless of declaration order.
  **Jurisdiction pack content is now delivered as templates** (`server/src/content/jurisdictionPacks.ts`,
  served/assembled by the `jurisdictionPacks` module): NAIC Schedule F with the security-driven provision
  for reinsurance (pure engine `@rios/domain/scheduleF`, **illustrative default factors, configurable**),
  Solvency II QRT skeletons (S.02.01 balance sheet with the GL equity tie, S.31.01 share of reinsurers) and
  the IRDAI inward/outward reinsurance summary - each bound to live tenant data and every pack labelled
  **template, not certified content**. The certified line taxonomies, official factor tables and filing
  validations (and other regimes: Lloyd's returns, tax/levy regimes) remain jurisdiction-specific
  configuration - these packs are not filings. (§18.3)
- **Data lineage to regulatory output** - the technical→financial chain is reconcilable and lineage-tracked
  (`source_event_id`); regulatory read models are designed-for. (§18.4)

## 5. Security & trust

- **TOTP MFA and OIDC SSO are delivered** (enrol/verify/disable endpoints and provider-configured OIDC,
  both tested). **SAML** serves SP metadata but the assertion-consumer signature validation is
  provider-wired per deployment; **Azure AD/LDAP** connectors and **WebAuthn** attestation verification
  remain designed-for. **Login rate limiting is delivered** (fixed-window per IP+email lockout); token
  refresh/revocation remains bounded by the 12h JWT. (§14.1)
- **ABAC policy enforcement** - modelled (`user_role.scope`, `org_unit`), not applied in queries. **FLS /
  column masking** - designed-for. (§14.2)
- **KMS / per-tenant keys / rotation, encryption-at-rest config, TLS termination** - deployment-layer,
  designed-for. (§14.2)
- **Immediate token revocation** - bounded by the 12h JWT today; refresh + deny-list designed-for.
- **The negative cross-tenant isolation test is delivered** (`server/test/tenant_isolation.test.ts`:
  a second live tenant is provisioned and cross-tenant reads are proven blocked). **Secrets manager**,
  **SAST/DAST/pen-test**, **SOC/SIEM**, **retention / legal hold / right-to-erasure** - designed-for.
  (§14.4, §14.5)
- **Audit coverage** - material business mutations are audited; extending to *all* config writes is a small
  hardening item.

## 6. Platform, configuration & UX

- **Formula Engine & Calculation Framework** is now **delivered** full-stack (`@rios/domain/formula`,
  `formulaLibrary`; server `formulas` module + migration 0050; web Formula Management page +
  `CalculatedValue`): a safe, injection-free expression evaluator; formulas as versioned, effective-dated
  **data** (variables, constants, functions, conditional logic) with named terms so every value carries a
  step-by-step breakdown; `validateFormula` + a live test sandbox; the **SYSTEM / OVERRIDE / IMPORTED /
  MANUAL** status model and **INPUT / CALCULATED / PROTECTED** governance (`canEditField`); an audited
  override + restore trail (`formula_override`); and a grounded, deterministic **explain** (AI Formula
  Assistant). A seed library covers underwriting/treaty/claims formulas. Designed-for: wiring
  `CalculatedValue` into *every* screen, a formula approval workflow, and drag-and-drop authoring.
- **No-code designers** for forms, workflows, rules, approval stages, templates, reports, dashboards - the
  `config_document` store exists; **interpreters and designer UIs are designed-for** (the Formula Engine
  above is the first fully-delivered no-code surface). (§9.3, §10.3, §13)
- **Entitlement engine** (per-tenant/plan flags & limits) - designed-for. (§9.1)
- **Config sandbox / simulate / promotion / approval** - designed-for. (§10.4)
- **Frontend** - design tokens delivered; the full component library (accessible, themed, RTL), the
  metadata-driven form renderer, command palette, global search, saved views, skeletons/empty states, and the
  module UIs are **in progress**. (§11)
- **i18n / multi-language / RTL / WCAG 2.2 AA** verification - supported by tokens; not yet verified. (§19, §11.6)

## 7. Architecture, scale & operability

- **Microservices split, API gateway, Kafka/event bus, outbox relay, CQRS read models** - designed-for; today
  one deployable with the boundaries in place. ([ADR 0001](./adr/0001-architecture-style.md), §15.2)
- **Observability** - structured logging delivered; metrics, distributed tracing, SLOs/error budgets,
  dashboards, alerting designed-for. (§15.6)
- **IaC, Kubernetes, CI/CD with quality gates, blue-green/canary** - designed-for. (§21 ph.14)
- **Redis, ElasticSearch/OpenSearch, object storage** - Redis provisioned, not wired; search/object-storage
  designed-for. (§15.3)
- **Partitioning** of high-volume tables (`financial_event`, `ledger_posting`, `audit_log`,
  `reserve_movement`), **read replicas**, **archival/retention** - designed-for. (§16.2, §16.4)
- **DR (RTO/RPO), backup/restore drills, failover, multi-region** - designed-for. (§15.5, §20)
- **Performance / load testing** to p95/p99 budgets - not done. (§20)

## 8. Integration & distribution

- **Data import with mapping/validation** is now delivered as a reusable engine (`@rios/domain/dataImport`
  `mapAndValidate`): column-to-field mapping, typed coercion (string/number/money-minor/date/boolean/currency/
  enum), per-field rules and a precise per-cell error report, exposed as a dry-run preview at
  `POST /api/import/validate` (and used by bordereaux ingestion). **Webhooks/event subscriptions, the
  Integration Hub, export with mapping, the Developer Portal and API Marketplace** remain designed-for. (§17)
- **ACORD bureau connector (EBOT/ECOT)** is now delivered: the pure `@rios/domain/acord` engine builds and
  validates EBOT (technical accounting, from a statement of account) and ECOT (claim movement, from a claim)
  messages with a deterministic canonical serialization, and the `bureau` module drives them through a
  `BureauConnector` seam. The default in-repo `LoopbackConnector` acknowledges outbound messages and echoes an
  inbound receipt so the round trip (BUILT → SENT → ACKNOWLEDGED) is demonstrable without a live credential; a
  real DXC / Lloyd's-Velonetic gateway is the labelled integration seam that swaps in behind the same
  interface. Surfaced at `/bureau`. (§7, §28)
- **Portals** (broker, cedent, retrocessionaire, client, coverholder, mobile) - designed-for as thin scoped
  projections. (§9.11)

## 9. Reporting & BI

- **Drag-drop report/dashboard designers, pivot/cube, drill-down/through, scheduling, export to
  Excel/Word/PPT/PDF/CSV, semantic layer / data warehouse** - designed-for; a `/api/dashboard/summary` KPI
  endpoint is the only delivered reporting surface. (§13)

## 10. Testing & quality (see [phases.md](./phases.md) §13)

- e2e, contract, performance, security, accessibility, AI-evaluation, and coverage-threshold suites are
  designed-for; unit + integration are delivered.

---

## 11. Messaging & integration: in-process mechanics, provider-wired sinks (§3, §12)

The messaging, event-bus and connector modules implement the **real, tested
orchestration mechanics** - a transactional message outbox with status tracking,
the transactional event-outbox + relay pattern, a typed connector registry with
config validation and secret redaction, and one-time API-key issuance (only a hash
and a short prefix are stored; the raw key is never retrievable). What is
deliberately **not** wired in this foundation, and must be configured per
deployment, is the external **sink**:

- **Email/SMS delivery** - the dev provider marks queued messages `sent` in-process
  and logs them; production points the deliver step at a real SMTP relay / SMS gateway.
- **Event bus sink** - the relay flips `event_outbox` rows to `published` in-process;
  production publishes to Kafka (or equivalent) before marking them published.
- **Connector "test connection"** validates config *shape* only; it does not attempt
  a live SFTP/REST/Kafka handshake from this environment.

These are integration points, not missing logic: the queue, relay, registry and key
lifecycle are exercised by the server test-suite.

## 12. KMS, SAML & backup: real mechanics, managed providers (§14, §15)

- **KMS** - envelope encryption is real (AES-256-GCM; a per-alias DEK is generated,
  wrapped by a master key and stored wrapped; encrypt/decrypt round-trip is tested).
  The **dev master key is derived from `JWT_SECRET`**; production injects a managed
  HSM/KMS master key and never derives it from app config.
- **SAML** - SP metadata is served and providers are configurable (reusing
  `identity_provider`). The **assertion-consumer handshake (XML-signature
  validation) is provider-wired** - a deployment plugs a SAML library into the ACS
  endpoint. (OIDC SSO is fully wired.) WebAuthn remains designed-for.
- **Backup/DR** - the run **catalog** (markers, status, restore points) is real and
  tested; the actual snapshot/restore is driven by the **DB/infra layer**, not the app.

## 13. AI & channels: real reasoning, external sensors (§5, §9.4, §9.11)

- **OCR / document intelligence** - deterministic **field extraction from text** is
  implemented and tested; the **image/PDF → text** step is an external OCR engine.
- **Voice assistant** - a transcript is normalised and routed through the existing
  deterministic assistant; **speech-to-text and text-to-speech** are captured
  on-device / by a managed speech service.
- **AI prediction & insights** - renewal-likelihood scoring is a **transparent,
  unit-tested heuristic** (no black box); an optional LLM may narrate it.
- **AI generation** - executive summaries are produced by **template-merge over live
  KPIs**; the optional LLM layer (already wired for the assistant) can elaborate.
- **Mobile portal** - a condensed projection + PWA manifest served to the responsive
  web client; a **native shell** is out of scope.
- Still genuinely deferred: **WebAuthn** (needs an authenticator), and the
  **API Marketplace** (brief §26 marks it ▷ later-phase).

## 14. WebAuthn, marketplace, automation, eval - mechanics built (§14.1, §26, §5)

- **WebAuthn / passkeys** - the registration & authentication **ceremonies**
  (challenge issuance, credential registry, sign-count, allow-lists) are
  implemented and tested, and the browser client runs `navigator.credentials`.
  Full **attestation/assertion signature verification** still needs a WebAuthn
  library + a real authenticator - wired at deployment.
- **API marketplace** - a working catalog + per-tenant install lifecycle (the
  brief §26 marks the marketplace ▷ later-phase; the install plumbing is real,
  the listed third-party apps are illustrative).
- **AI Automation Studio** - composes the existing rules engine + event bus
  (trigger → rule set → actions), evaluated live; not a second engine.
- **Assistant evaluation** - a real, reproducible prompt-suite regression check
  on the deterministic intent engine.

With this, every §26 catalog item is delivered as a working, tested slice or has
its external boundary documented above; nothing in the catalog is silently
omitted.

## 15. HR / Attendance depth (§9.14)

Delivered as a working, tested slice:

- **Employee depth** - employment type (full-time/contract/intern), an audited
  status lifecycle (active/on-leave/suspended/exited) with a hash-chained
  `employee_status_history`, and an org-chart rollup (direct + indirect reports
  via a recursive CTE). System role(s) from the Permission Engine are surfaced
  on the employee detail alongside the HR designation.
- **Attendance command center** - an enumerated, auditable day status
  (present/absent/on-leave/holiday/regularized/OD/WFH; see
  `attendanceStatus.ts`), a monthly grid, OD/WFH/regularization requests routed
  to the employee's **manager resolved from the org hierarchy** (not flat
  `hr:write`), manager approval that applies the effect (regularization keeps
  the original system-captured punches alongside the corrected value), and a
  who's-on-leave widget sourced from the existing leave table (not duplicated).
  Pure domain logic decides whether OD/WFH count as worked days for payroll.

Documented gaps / designed-for:

- **Configurable escalation to skip-level** - approvals currently resolve a
  single approver (the direct manager; falling back to HR review when no manager
  is on file). **Time-based auto-escalation to the skip-level manager** (e.g. "if
  not actioned in N hours, escalate one level up") is **designed-for, not yet
  wired**: it should reuse the existing Scheduler (`scheduler.ts`) and
  Notification engine rather than introduce a parallel mechanism. The org
  hierarchy needed to find the skip-level (manager's manager) is already
  available via the recursive reports query.
- **Employee↔user account linking** - manager-as-approver resolves the manager's
  `app_user` via `employee.user_id`. Employees created through the HR API are not
  auto-provisioned a login, so their requests fall back to HR review until an
  account is linked. Self-service provisioning is designed-for.
- **Payslip self-service** - the attendance command center links to the Payroll
  page (gated by `hr:read`); a per-employee "my payslip" self-service endpoint is
  designed-for.

## Assumptions

- This is a **foundation/vertical-slice**, intended to prove correctness, security, audit, and the
  technical→financial chain - not a finished product. The brief's full scope is a multi-year roadmap (§24.1).
- Regulatory rule specifics are confirmed per jurisdiction in a real Phase 2 and delivered as configuration,
  not hard-coded (§24.1).
- Third-party services (cat models, IdPs, banking, bureaus) are integrated under their own licences; RIOS
  provides connectors, designed-for (§24.1).

## Traceability

Brief §3.3 (no silent gaps), §8.2 (designed-for/phased), §24 (assumptions/constraints/risks), §27 (acceptance
checklist). Cross-referenced throughout the docs set.
