# ADR 0002 - Multi-tenancy via shared schema + PostgreSQL Row-Level Security

**Status:** Accepted · **Date:** 2026 · **Deciders:** Database Architect, Security Architect, CTO
**Brief refs:** §4.2, §14.2, §14.5, §15.4, §16.3

## Context

The platform is multi-tenant from the first schema (§4.2) and must guarantee **no cross-tenant data path**,
verified by automated tests (§14.5). The brief offers three isolation models (§15.4): shared-schema +
RLS (default), schema-per-tenant, and database-per-tenant (premium). We need isolation that is enforced by
the database itself - not merely by application `WHERE tenant_id = …` clauses, which a single missed filter
would defeat.

## Decision

Use **shared-schema multi-tenancy with PostgreSQL Row-Level Security** as the default model:

- Every tenant-scoped table carries a `tenant_id` column and has an RLS policy keyed off
  `current_setting('app.tenant_id')`.
- The application connects as a **non-superuser app role (`rios_app`)** for all tenant-scoped queries, so
  RLS is *enforced* (superusers and table owners bypass RLS). A separate privileged connection
  (`DATABASE_URL`) is used only for migrations/seeding.
- A per-request helper (`runAs`) opens a transaction and sets `app.tenant_id` and `app.user_id` as
  **`LOCAL`** settings, so the tenant context lives and dies with the transaction and cannot leak across
  pooled connections.
- Tenant isolation is part of the integration test suite.

Schema-per-tenant and database-per-tenant remain **designed-for** premium options; the RLS model is the
v1 default.

## Consequences

**Positive:** isolation is enforced in the database, defence-in-depth below the application; one schema to
migrate; cheap onboarding; `LOCAL` settings make the context request-scoped and pool-safe.

**Negative / accepted:** every tenant-scoped table must remember its policy (a migration discipline,
covered by `0008_rls.sql`); the app must always connect as `rios_app` for tenant work; noisy-neighbour
isolation (compute, not data) is weaker than physical separation - addressed later by the premium options.

**Risks & mitigations:** a table without RLS would be a leak - mitigated by making RLS a review-gate item
and by isolation tests. Forgetting `runAs` would query with no tenant context - mitigated by routing all
tenant-scoped access through it.
