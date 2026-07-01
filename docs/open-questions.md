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
  aggregate by zone, but zonal aggregates, PML/MFL, RDS, and third-party cat-model integration (Verisk/Moody's
  RMS) are designed-for. (§7.8, §9.9)
- **Pricing & rating** - burning-cost/experience rating, exposure rating, swing rating, capacity/authority
  checks are not in the domain library. (§7.8, §29.5)
- **Bordereaux ingestion** - mapped/validated premium & loss bordereaux (Excel/CSV/feeds) → financial events
  / losses is designed-for. (§7.10, §29.6)
- **Facultative & retrocession depth** - modelled in the schema (`contract_kind`, `direction`, party roles)
  but single-risk fast cession, fac-obligatory, inuring order, and gross/ceded/net position computation across
  inwards+outwards are designed-for. (§7.4, §7.5)
- **Placement & slip (MRC)** management, signing-down workflow, written-vs-signed reconciliation UI - schema
  supports participations; flows are designed-for. (§7.3, §29.4)
- **Commutation, portfolio transfer, indexation/stability clauses, hours clauses, occurrence definitions** -
  terminal states and event types are modelled; the calculation logic is designed-for.
- **Reinstatement schedules** beyond the simple cumulative-fraction model; **sliding scale** stepped (vs
  interpolated) variants - config-driven extensions.

## 2. Accounting & finance breadth

- **FX & revaluation** - cross-currency arithmetic is deliberately rejected by the domain core (all crossing
  goes through explicit rates). A period-end **revaluation engine is now delivered** in `@rios/domain/fx`:
  single-item and portfolio revaluation to a closing rate, realized (on settlement) vs unrealized FX
  gain/loss with asset/liability sign correction, per-currency net open exposure, and balanced GL postings
  that reconcile to zero (unit-tested). What remains designed-for is the **live rate feed** into
  `exchange_rate` and wiring revaluation output into the period-close posting run. (§7.6, §16.1)
- **AR/AP, cash management, bank reconciliation, treasury, investments, fixed assets, tax & levy** - the GL
  core (journal/posting/reconcile) is delivered; these sub-ledgers are designed-for. (§9.8)
- **Statement-of-account lifecycle** (Open → Prepared → … → Settled) - `statement_status` list seeded;
  workflow is designed-for. (§28.5)
- **Profit-commission jurisdictional variants** - one common basis delivered; others would be configuration.

## 3. Claims & recoveries

- **Reinstatement processing**, **recoveries collection**, **salvage & subrogation**, **inuring application
  order**, **event aggregation** to programme/portfolio - schema present (`recovery`, `cat_event`); flows
  designed-for. (§7.7)
- The implemented claim flow covers notify → reserve movement → paid-loss event; the full state machine is
  reference-data-driven but only partially wired.

## 4. Regulatory & compliance

- **IFRS 17** (GMM/BBA, PAA, VFA, CSM roll-forward, risk adjustment, onerous contracts) - **deferred**; no
  measurement tables/engines. (§18.1)
- **Solvency II** (SCR/MCR, technical provisions, ORSA, QRTs) - **deferred**. (§18.2)
- **Statutory/market returns** (US Schedule F, Lloyd's returns), tax/levy regimes - designed-for as governed
  report packs. (§18.3)
- **Data lineage to regulatory output** - the technical→financial chain is reconcilable and lineage-tracked
  (`source_event_id`); regulatory read models are designed-for. (§18.4)

## 5. Security & trust

- **SSO/SAML/OIDC, Azure AD, LDAP, MFA** - designed-for; schema-ready (nullable `password_hash`). (§14.1)
- **ABAC policy enforcement** - modelled (`user_role.scope`, `org_unit`), not applied in queries. **FLS /
  column masking** - designed-for. (§14.2)
- **KMS / per-tenant keys / rotation, encryption-at-rest config, TLS termination** - deployment-layer,
  designed-for. (§14.2)
- **Immediate token revocation** - bounded by the 12h JWT today; refresh + deny-list designed-for.
- **Negative cross-tenant isolation test**, **secrets manager**, **SAST/DAST/pen-test**, **SOC/SIEM**,
  **retention / legal hold / right-to-erasure** - designed-for. (§14.4, §14.5)
- **Audit coverage** - material business mutations are audited; extending to *all* config writes is a small
  hardening item.

## 6. Platform, configuration & UX

- **No-code designers** for forms, workflows, rules, approval stages, templates, reports, dashboards - the
  `config_document` store exists; **interpreters and designer UIs are designed-for**. (§9.3, §10.3, §13)
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

- **Webhooks/event subscriptions, Integration Hub, Data Import/Export with mapping/validation, connector
  framework (ACORD/EBOT/ECOT/bordereaux), Developer Portal, API Marketplace** - designed-for. (§17)
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
