# ADR 0004 — Metadata-driven configuration

**Status:** Accepted · **Date:** 2026 · **Deciders:** CTO, Enterprise Solution Architect, Product Owner
**Brief refs:** §4.1, §10 (the configurability mandate), §10.5 (anti-patterns)

## Context

The single most load-bearing constraint in the brief (§4.1, §10) is that **anything a customer could
reasonably want to change is configuration, stored in the database and served at runtime — never a literal
in source, never a value that requires a deployment to alter.** Hard-coded enums, status-string literals
in logic, and per-customer `if` branches are explicitly forbidden (§10.5).

## Decision

Drive business vocabulary and behaviour from a **governed reference-data layer** rather than source code:

- **Code lists / code values** (`code_list`, `code_value`) hold statuses, dropdowns, types, and classes —
  effective-dated so a value introduced today does not corrupt last year's records.
- **Currencies, exchange rates, numbering schemes** are tables, not constants.
- **`config_document`** stores versioned, effective-dated JSON for forms, workflows, rules, and templates,
  so screens/processes are described by metadata and interpreted at runtime.
- New statuses / code values are added via the **reference API** (`add-value`) and the Admin screen — **no
  deployment** (the §20 configurability NFR, verifiable).
- The domain core's closed TypeScript unions (e.g. `FinancialEventType`) are the *internal* vocabulary the
  engine understands; the *customer-facing* lists that map onto them are reference data.

## Consequences

**Positive:** administrators change behaviour without a release; configuration is versioned, effective-dated,
and auditable; the §10.5 anti-patterns are structurally avoided.

**Negative / accepted:** more indirection than literals; config must be validated and fail safe (block with
a clear message rather than silently produce a wrong number, §10.4); the full form/workflow/rules
**interpreters** are designed-for — the storage (`config_document`) and reference-data surfaces are
delivered, the no-code designer UIs are in progress / later phase.

**Boundary:** truly structural invariants (double-entry must balance; money is integer minor units) are
*not* configuration — they are correctness guarantees and stay in code.
