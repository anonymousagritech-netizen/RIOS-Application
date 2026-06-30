<div align="center">

# RIOS - Reinsurance Intelligent Operating System

**A metadata-driven, multi-tenant, AI-assisted reinsurance ERP platform.**

Treaty · Facultative · Retrocession - placement → technical & financial accounting → claims & recoveries → reporting.

</div>

---

## What this is

RIOS is the foundation and a **working vertical slice** of a commercial-grade reinsurance platform, built to the standard set out in [`Reinsurance-ERP-Build-Brief.md`](./Reinsurance-ERP-Build-Brief.md). It is engineered around the brief's non-negotiables (§4): metadata-driven by default, multi-tenant and secure-by-design, auditable and reversible, *correct before clever*.

This repository delivers a **genuinely runnable** system - not slideware:

- A pure, unit-tested **reinsurance calculation core** (the "correct before clever" heart) - proportional & non-proportional math, commissions, reinstatements, and a reconcilable accounting chain. **38 passing tests.**
- A **multi-tenant PostgreSQL data layer** with row-level-security isolation, an immutable hash-chained audit log, and a party/role-centric model - **verified** (no tenant sees another's rows).
- A **Fastify API** implementing the core lifecycle: parties, treaties (with a validated state machine), the bind→financial-event→statement→GL-posting→**reconciliation** chain, claims & reserve movements, and a permission-bound, confirmation-gated AI assistant.
- A **premium React frontend** (tokenised design system, light/dark, command palette, dashboards, assistant drawer).

> **Honesty about scope (brief §3.3).** This is a foundation and a thin-but-complete slice through the core domain - not a finished competitor to Sapiens/Guidewire. What is built is real and tested; what is designed-for-but-not-yet-built is named explicitly in [`docs/open-questions.md`](./docs/open-questions.md) and [`docs/phases.md`](./docs/phases.md). Nothing important is silently omitted.

## Repository layout

```
RIOS-Application/
├── packages/
│   ├── domain/     Pure reinsurance calculations (no I/O) + unit tests
│   └── shared/     API DTO contracts shared by server & web
├── server/         Fastify API - auth, RLS tenant context, domain modules
├── web/            React + Vite frontend (premium design system)
├── db/
│   ├── migrations/ PostgreSQL schema (tenancy, reference data, core, accounting, claims, audit, RLS)
│   └── seed/       Demo tenant: parties, a CAT-XL treaty, reference data
├── docs/           Architecture, data model, API, domain math, ADRs, phases, glossary
└── docker-compose.yml
```

## Quick start

**Prerequisites:** Node ≥ 20, and PostgreSQL 16 (via Docker, or a local cluster).

```bash
# 1. Install
npm install

# 2. Database - either docker compose, or point DATABASE_URL at your own PG
docker compose up -d db          # starts postgres:16 on :5432
cp .env.example .env             # defaults match docker compose

# 3. Schema + demo data
npm run db:migrate
npm run db:seed

# 4. Run
npm run dev:server               # API on http://localhost:4000
npm run dev:web                  # UI  on http://localhost:5173
```

> No Docker? Any reachable PostgreSQL 16 works - set `DATABASE_URL` (owner, for migrations) and `DATABASE_APP_URL` (the low-privilege `rios_app` role used at runtime, for RLS) in `.env`.

### Demo logins

All use password **`demo1234`**, tenant code **`demo`**:

| Email | Role | Can |
|---|---|---|
| `admin@demo.rios` | Administrator | everything |
| `uw@demo.rios` | Treaty Underwriter | treaties, bind |
| `acct@demo.rios` | Technical Accountant | accounting, post to GL |
| `claims@demo.rios` | Claims Handler | claims & reserves |

## Tests

```bash
npm test                         # domain unit tests + server integration tests
npm run test --workspace packages/domain   # 38 calculation tests (no DB needed)
npm run test --workspace server            # vertical-slice integration (needs a seeded DB)
```

The server integration test proves the Phase 10 exit gate: **place → bind → account → post → reconcile** with correct numbers, the illegal-transition guard, the RBAC permission gate, and the assistant's confirmation gate.

## The vertical slice, end to end

1. **Place & bind** a treaty - the lifecycle state machine (`DRAFT → QUOTED → BOUND …`) rejects illegal jumps; binding books the **deposit premium** as an immutable Financial Event using the domain calculator.
2. **Statement of account** nets the contract's Financial Events into a balance.
3. **Post to the GL** - balanced double-entry journals are generated, and the platform **proves the technical→financial chain reconciles** (control-account movement = statement balance, brief §7.6).
4. **Claims** register, reserve, and pay - payments book `PAID_LOSS` events that flow back into the statement.
5. **Assistant** answers grounded questions and **prepares** (never silently executes) mutations; every material action requires explicit confirmation and is audited as assistant-originated (brief §12.4).

## Key engineering decisions

- **Money is never a float.** All amounts are integer **minor units** with explicit, single-step rounding and penny-perfect allocation (brief §16.1). See [`ADR-0003`](./docs/adr/0003-money-as-minor-units.md).
- **Tenant isolation is enforced by the database**, not just WHERE clauses: the app connects as a low-privilege role and every request runs under `SET LOCAL app.tenant_id`, gated by RLS policies. See [`ADR-0002`](./docs/adr/0002-multitenancy-rls.md).
- **Configuration over code.** Statuses, code lists, currencies, numbering, and form/workflow/rule definitions are served from the database; new values are added without a deployment. See [`ADR-0004`](./docs/adr/0004-metadata-driven-config.md).
- **Modular monolith now, microservice-ready.** Bounded contexts are clean and event-publishing (outbox), so services can be split when scale warrants - applied where it earns its keep (brief §15.1). See [`ADR-0001`](./docs/adr/0001-architecture-style.md).

## Documentation

Start with [`docs/README.md`](./docs/README.md). Highlights: [architecture](./docs/architecture.md) · [data model](./docs/data-model.md) · [API reference](./docs/api-reference.md) · [domain calculations](./docs/domain-calculations.md) · [configuration guide](./docs/configuration-guide.md) · [security](./docs/security.md) · [phase status](./docs/phases.md) · [open questions & gaps](./docs/open-questions.md).

## License

UNLICENSED - proprietary. © RIOS. All rights reserved.
