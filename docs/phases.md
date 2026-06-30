# RIOS - Delivery Phase Map

**Version:** 1.0 · **Status:** Honest status against the brief's 15 phases (§21)
**Roles consulted:** Product Owner, CTO, QA Lead, Technical Writer

## Purpose & scope

Maps the build to the brief's fifteen delivery phases (§21), stating for each what is **DELIVERED** vs
**DESIGNED-FOR** vs **DEFERRED** - honestly (§3.3, "no silent gaps"). RIOS today is a **foundation / vertical
slice**: a correct, secure, audited end-to-end path through the reinsurance core, not a finished commercial
product. The breadth targeted by the brief (40+ modules, IFRS 17/Solvency II, microservices, portals) is
designed-for and named, not pretended.

Legend: **D** delivered · **DF** designed-for (architecture allows, not built) · **DEF** deferred (out of v1 slice).

---

## Phases 1–6 - Analysis → APIs (summary)

| Phase | Objective | Status |
|---|---|---|
| 1 - Business Analysis | Domain understanding, personas, lifecycles | **D** (encoded in the domain model, glossary, and this docs set; standalone study artifacts **DF**) |
| 2 - Functional Specification | What each module does | **Partial** - implemented modules are specified by code + these docs; full per-module spec for all 40+ modules **DF** |
| 3 - Module Architecture | Bounded contexts, dependencies, ADRs | **D** for the built contexts ([architecture.md](./architecture.md), 5 ADRs); full context map across all domains **DF** |
| 4 - Database Design | Production data design | **D** - 8 migrations, party/role core, RLS, effective-dating, audit ([data-model.md](./data-model.md)); partitioning/bi-temporal **DF** |
| 5 - Service Design | Service topology, substrate | **DF** - modular monolith now, microservices-ready ([ADR 0001](./adr/0001-architecture-style.md)); gateway/Kafka/observability **DF** |
| 6 - REST APIs | Contracts before implementation | **D** for built modules ([api-reference.md](./api-reference.md) + `@rios/shared`); generated OpenAPI, pagination, versioning, webhooks **DF** |

**Cross-cutting standards (Part C):** metadata-driven config (reference-data core **D**, designers **DF**),
security (JWT/RBAC/RLS/audit **D**; SSO/MFA/FLS **DF**), audit (**D**), i18n/accessibility (design tokens
support it; verification **DF**), observability (logging **D**; metrics/traces/SLOs **DF**).

## Phases 7–11 - Design system → Frontend (in progress)

| Phase | Objective | Status |
|---|---|---|
| 7 - Design System | Tokenised design language, theming | **Partial/D** - `web/src/styles/tokens.css`: semantic colour, typography, spacing, radii tokens with `[data-theme="dark"]`. Components, RTL, full token coverage **in progress** |
| 8 - UI Wireframes | IA, key screens, states | **DF/in progress** - navigation, dashboard, treaties, parties, claims, accounting, admin, assistant drawer are the intended screens |
| 9 - Component Library | Accessible components + metadata form renderer | **DF/in progress** - the metadata-driven form renderer (§10.3) is a key designed-for item |
| 10 - Backend Development | Services to contract, vertical-slice first | **D** - the slice **place → bind → account → reconcile**, plus claims and the assistant, with RLS/RBAC/audit, is implemented and integration-tested |
| 11 - Frontend Development | Application UI on the components | **In progress** - React app being built in parallel; per-page baseline, saved views, export, report/dashboard designers **DF** |

> Phase 10 is the most mature: the vertical-slice **exit gate is met** - login → create → bind (books deposit
> premium) → statement → post → reconcile works end to end with correct, reconciled numbers, with the
> illegal-transition guard, permission gate, and assistant confirmation gate proven by tests.

## Phase 12 - AI Integration

**DELIVERED (guardrailed).** A **deterministic intent engine** assistant (`/api/assistant`,
`/api/assistant/confirm`): grounded in tenant data (counts, open claims, exposure-by-zone, statement
navigation, create proposals); **every mutating action requires explicit confirmation** in a second call that
re-checks permissions server-side; permission-bound with **no backdoor**; **fully usable with AI disabled**
(no `ANTHROPIC_API_KEY` required). Proven by integration tests (confirmation + permission gates). See
[ADR 0005](./adr/0005-assistant-guardrails.md).

**DESIGNED-FOR:** voice assistant; AI generation of reports/dashboards/documents/forms as editable artifacts;
Automation Studio; an assistant **evaluation / golden-task** suite (§12.4); LLM enrichment of phrasing/summaries.

## Phase 13 - Testing

**DELIVERED:** unit tests for the domain core (**38 passing** - money, proportional, non-proportional,
accounting/reconciliation) and **server integration tests (4)** proving the vertical slice, the
illegal-transition guard (409), the permission gate (403), and the assistant confirmation gate. Run with
`npm test`.

**NOT yet (DF/DEF):** end-to-end (browser) tests; contract tests; performance/load tests against §20 budgets;
security testing (SAST/DAST, dependency scan, penetration); accessibility (WCAG 2.2 AA) automation; a dedicated
**negative cross-tenant isolation** test; AI evaluation suite; coverage reporting/thresholds.

## Phase 14 - Deployment

**DELIVERED:** local `docker-compose` (PostgreSQL 16 + Redis 7); migration/seed scripts; `npm run db:reset`.

**DESIGNED-FOR:** IaC for all environments; CI/CD with quality gates (tests + security scans);
blue-green/canary; observability (metrics/traces/dashboards/alerts/SLOs); backup, DR (RTO/RPO), and restore
drills; runbooks/on-call; tenant onboarding/offboarding automation; Kubernetes; the **outbox relay** + event
bus.

## Phase 15 - Documentation

**DELIVERED:** this documentation set under `docs/` plus a top-level `CLAUDE.md` - architecture, data model,
API reference, domain calculations, configuration guide, security, this phase map, ADRs, glossary, and the
open-questions register.

**DESIGNED-FOR:** a developer portal / API sandbox; operator runbooks; end-user help and in-app guidance;
compliance/audit evidence packs; release notes; DR documentation.

---

## Traceability

Brief §21 (phase plan & exit gates), §22 (DoD), §27 (acceptance checklist). Each phase's detail lives in the
linked docs. The §27 acceptance checklist is **partially** satisfied: the technical→financial reconcilable
chain, RLS multi-tenancy, the confirmation-gated assistant, integer-money correctness, and original work are
demonstrably true for the slice; IFRS 17 / Solvency II, full reporting/BI, portals, microservices, and the
operability stack are designed-for.

## Open Questions / Assumptions / Gaps

See [open-questions.md](./open-questions.md) for the consolidated register of what a real commercial delivery
would still need.
