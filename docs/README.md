# RIOS Documentation

**RIOS — Reinsurance Intelligent Operating System** is a metadata-driven, multi-tenant reinsurance ERP built
in this monorepo. This is the documentation set for the platform's **foundation / vertical slice**: a
correct, secure, audited end-to-end path through the reinsurance core (place → bind → account → reconcile →
claims), with a deterministic, guardrailed assistant. It is a foundation, not a finished commercial product —
designed-for capability is named, never silently omitted (brief §3.3).

The build follows the `Reinsurance-ERP-Build-Brief.md` at the repo root (15 phases §21, glossary §25, module
catalog §26, acceptance checklist §27). Section references like §7.6 point into that brief.

## Index

| Document | What it covers |
|---|---|
| [architecture.md](./architecture.md) | Solution & technical architecture (§15): clean-architecture / DDD bounded contexts, the modular-monolith-now / microservices-ready stance, tech stack, multi-tenancy & RLS, the reconcilable technical→financial chain, request/auth flow, observability & outbox. Context + request-with-RLS diagrams. |
| [data-model.md](./data-model.md) | Phase 4 data design (§16): per-context entities, core ER diagram, money/FX & effective-dating, audit/soft-delete, indexing/partitioning, tenant isolation, contract & claim state machines. |
| [api-reference.md](./api-reference.md) | Every endpoint (method, path, permission, request, response, errors), the bearer/auth scheme, and the error model. |
| [domain-calculations.md](./domain-calculations.md) | The reinsurance math reference: every `@rios/domain` function with formula, inputs/outputs, and a worked example using the unit-test numbers. Profit commission, sliding scale, XL recovery/reinstatements, reconciliation. |
| [configuration-guide.md](./configuration-guide.md) | Admin/config guide (§10): what is metadata-driven, effective-dating/versioning, adding a status without a deployment, guardrails, forbidden anti-patterns. |
| [security.md](./security.md) | Security & trust (§14): JWT, RBAC (+ABAC-ready), RLS isolation via `runAs`, append-only hash-chained audit, secrets, and what is designed-for (SSO/MFA, FLS, KMS). |
| [phases.md](./phases.md) | The build mapped to the 15 phases (§21): DELIVERED vs DESIGNED-FOR vs DEFERRED, honestly. |
| [glossary.md](./glossary.md) | Domain + technical glossary, with where each term is implemented. |
| [open-questions.md](./open-questions.md) | The consolidated Open Questions / Assumptions / Gaps register (§3.3). |
| [adr/](./adr/) | Architecture Decision Records (§15.7). |

### ADRs

- [0001 — Architecture style: modular monolith, microservices-ready](./adr/0001-architecture-style.md)
- [0002 — Multi-tenancy via shared schema + RLS](./adr/0002-multitenancy-rls.md)
- [0003 — Money as integer minor units](./adr/0003-money-as-minor-units.md)
- [0004 — Metadata-driven configuration](./adr/0004-metadata-driven-config.md)
- [0005 — Assistant guardrails: deterministic, permission-bound, confirmation-gated](./adr/0005-assistant-guardrails.md)

## Quick start

See the top-level [`CLAUDE.md`](../CLAUDE.md) for repo layout, how to run it (docker compose, db reset, dev
servers), demo logins, how to run the tests, and the key conventions (money in minor units, metadata-driven
config, RLS tenant context, audit on mutations).

## Document conventions

Each document follows the brief's deliverable structure (§23): purpose/scope, body, traceability to the brief
sections, a cross-cutting compliance note, and an Open Questions / Gaps note. Diagrams are Mermaid. Status is
stated honestly: **delivered**, **designed-for**, or **deferred**.
