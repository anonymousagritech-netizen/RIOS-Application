# CLAUDE.md - RIOS orientation

**RIOS - Reinsurance Intelligent Operating System** is a metadata-driven, multi-tenant reinsurance ERP. This
file orients engineers and agents working in the repo. Full documentation is under [`docs/`](./docs/README.md);
the product/engineering brief is `Reinsurance-ERP-Build-Brief.md` (its §-references appear throughout the docs).

> **What this is:** a correct, secure, audited **foundation / vertical slice** - place → bind → account →
> reconcile → claims, plus a guardrailed assistant - not a finished commercial product. Designed-for capability
> is named in [docs/open-questions.md](./docs/open-questions.md), never silently faked. Document the reality.

## Repository layout (npm workspaces monorepo)

```
packages/domain   @rios/domain   Pure reinsurance math. No I/O/framework/DB. 38 unit tests.
                                 money.ts, proportional.ts, nonproportional.ts, accounting.ts
packages/shared   @rios/shared   API DTO contracts shared by server + web (stand-in for OpenAPI).
server            @rios/server   Fastify + PostgreSQL. Modules: reference, parties, treaties,
                                 accounting, claims, assistant. Plus auth, db (tenant context), audit.
web               @rios/web      React/Vite client. Design tokens delivered; app UI in progress.
db/migrations     0001..0008     tenancy/identity, reference, parties, core, accounting, claims, audit, RLS.
db/seed/seed.sql                 Demo tenant, users, roles, reference data, one BOUND CAT XL treaty.
docs/                            The documentation set (start at docs/README.md).
```

## How to run it

Prereqs: Node ≥ 20, Docker.

```bash
docker compose up -d db        # PostgreSQL 16 (and redis); or: npm run db:up
npm install                    # install all workspaces
cp .env.example .env           # then set a real JWT_SECRET for any non-dev use
npm run db:reset               # db:up + migrate + seed (drops and rebuilds the schema)
npm run dev:server             # Fastify API on :4000
npm run dev:web                # Vite web client (separate terminal)
```

Useful: `npm run db:migrate`, `npm run db:seed`, `npm run build`, `npm run typecheck`.

### Demo logins (tenant code `demo`, password `demo1234`)

| Email | Role | Can |
|---|---|---|
| `admin@demo.rios` | ADMIN | everything (`admin:manage`) |
| `uw@demo.rios` | TREATY_UW | read config/parties, write+bind treaties, read accounting/claims |
| `acct@demo.rios` | ACCOUNTANT | read; post accounting (no treaty write) |
| `claims@demo.rios` | CLAIMS | read; write claims |
| `broker@demo.rios` | PORTAL | broker portal - only its own party's contracts/statements/claims |
| `cedent@demo.rios` | PORTAL | cedent portal - only its own party's contracts/statements/claims |

```bash
curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@demo.rios","password":"demo1234","tenantCode":"demo"}'
```

## How to run the tests

```bash
npm test                                   # all workspaces
npm test --workspace packages/domain       # 38 domain unit tests (no DB needed)
npm test --workspace server                # integration: needs a migrated+seeded DB (run db:reset first)
```

The server integration test proves the vertical slice end to end: login → create treaty → bind (books the
deposit premium) → statement → post to GL → reconcile, plus the illegal-transition guard (409), the permission
gate (403), and the assistant confirmation gate. It skips cleanly if no Postgres is reachable.

## Key conventions (do not break these)

- **Money is integer minor units**, never floats. Construct via `money()`/`fromMajor()` from `@rios/domain`;
  same-currency arithmetic only (cross-currency throws - go through FX). DB columns are `*_minor bigint`; wire
  fields use a `…Minor` suffix. See [docs/domain-calculations.md](./docs/domain-calculations.md) §1 and
  [ADR 0003](./docs/adr/0003-money-as-minor-units.md).
- **Metadata-driven config**: business vocabularies (statuses, LOBs, party roles, event types) are **code
  lists**, not hard-coded enums. Add values via `POST /api/config/code-lists/:key/values` - **no deployment**.
  Never compare status string literals for customer-facing meaning. See
  [docs/configuration-guide.md](./docs/configuration-guide.md), [ADR 0004](./docs/adr/0004-metadata-driven-config.md).
- **RLS tenant context**: every tenant-scoped query runs inside `runAs({ tenantId, userId }, …)` on the
  `rios_app` connection (`DATABASE_APP_URL`), which sets `app.tenant_id`/`app.user_id` as `LOCAL` so Postgres
  RLS enforces isolation. The owner connection (`DATABASE_URL`) is migrations/seed/login only. Forgetting
  `runAs` ⇒ no rows (fail-closed). See [docs/security.md](./docs/security.md), [ADR 0002](./docs/adr/0002-multitenancy-rls.md).
- **Audit on mutations**: material changes call `writeAudit(...)` inside the same transaction, writing a
  hash-chained, append-only `audit_log` row (`rios_app` has no UPDATE/DELETE on it).
- **Auth/RBAC**: routes use `requirePermission('<perm>')`; permissions live in the 12h JWT; `admin:manage`
  overrides every check. See [docs/api-reference.md](./docs/api-reference.md).
- **The reinsurance math lives in `@rios/domain` only.** The server orchestrates and persists; it must not
  re-implement formulas. The domain core stays pure (no I/O/DB/framework/clock) so correctness is unit-testable.
- **Reconcilability**: the technical→financial chain (financial events → statement → balanced GL postings →
  reconcile) must reconcile to zero. Don't add money paths that bypass `financial_event`.
- **Assistant guardrails**: the assistant prepares actions and **confirms before mutating**, re-checking
  permissions; no backdoor; works with AI disabled. See [ADR 0005](./docs/adr/0005-assistant-guardrails.md).

## Where to read more

- Architecture & diagrams: [docs/architecture.md](./docs/architecture.md)
- Data model & ER diagram: [docs/data-model.md](./docs/data-model.md)
- API reference: [docs/api-reference.md](./docs/api-reference.md)
- Reinsurance calculations: [docs/domain-calculations.md](./docs/domain-calculations.md)
- Security: [docs/security.md](./docs/security.md)
- Configuration: [docs/configuration-guide.md](./docs/configuration-guide.md)
- Phase status (delivered vs designed-for vs deferred): [docs/phases.md](./docs/phases.md)
- Glossary: [docs/glossary.md](./docs/glossary.md)
- Gaps register: [docs/open-questions.md](./docs/open-questions.md)
- ADRs: [docs/adr/](./docs/adr/)

## Scope guardrails for changes

This repo prioritises **correctness, security, audit, and reconcilability over breadth** (brief §4.4). When
extending: keep money integer, keep config in reference data (no hard-coded business enums), route tenant
queries through `runAs`, audit mutations, keep the domain core pure, and keep the docs honest about what is
delivered vs designed-for.
