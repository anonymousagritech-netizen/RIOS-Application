# ADR 0001 — Architecture style: modular monolith now, microservices-ready

**Status:** Accepted · **Date:** 2026 · **Deciders:** CTO, Enterprise Solution Architect, DevOps
**Brief refs:** §15.1, §15.2, §3.1, §3.2

## Context

The brief (§15.2) mandates a microservices topology behind an API gateway with a Kafka event backbone as
the long-term target. The current deliverable is a **foundation / vertical slice** whose job (per the
Phase 10 exit gate, §21) is to prove a correct, secure, audited end-to-end chain — place → bind → account
→ reconcile — not to operate a fleet of services. Premature decomposition would multiply operational
surface (service discovery, distributed transactions, network failure modes) before any of it earns its
keep, and would slow down getting the domain semantics right (§4.4 "correct before clever").

## Decision

Build a **modular monolith** with **clean-architecture / DDD boundaries** that map 1:1 to the functional
domains (§9), so the seams along which services would later split are already present in code:

- A pure, dependency-free **domain core** (`packages/domain`) — no I/O, framework, or DB.
- A Fastify server organised into **module routers** (`reference`, `parties`, `treaties`, `accounting`,
  `claims`, `assistant`), each a candidate bounded context / future service.
- An **append-only financial-event log** and an **outbox** table — the substrate for event-driven
  integration when the split happens.

This is a **recorded, deliberate deviation** from §15.2's "build microservices now": the boundaries are
honoured, the split is deferred until scale or team topology justifies it (§3.2 — challenge, don't comply
blindly).

## Consequences

**Positive:** fast iteration; one deployable; in-process calls keep the vertical slice simple and correct;
clean module boundaries keep the future split cheap; the domain core is reusable by any future service
unchanged.

**Negative / accepted:** no independent scaling or deployment of modules yet; no real event bus (Kafka is
designed-for); the outbox is written but not relayed. These are named gaps, not silent ones
([open-questions.md](../open-questions.md)).

**Follow-ups:** when warranted — extract `accounting` and `claims` first (highest write volume), introduce
Kafka + an outbox relay, and front the modules with an API gateway. The contracts in `@rios/shared`
already approximate the inter-service DTOs.
