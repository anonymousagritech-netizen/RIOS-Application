# ADR 0003 - Money as integer minor units

**Status:** Accepted · **Date:** 2026 · **Deciders:** Reinsurance Domain Expert, Database Architect, CTO
**Brief refs:** §16.1, §20 (data integrity), §4.4

## Context

The platform carries real money and real risk (§1.2). Floating-point representation of monetary values
introduces representational error (0.1 + 0.2 ≠ 0.3) that accumulates across premiums, commissions, losses,
and FX, and makes reconciliation (§7.6) impossible to guarantee. The brief is explicit: **never
floating-point for monetary values** (§16.1, §20).

## Decision

Represent every monetary value as a **signed integer count of minor units** (e.g. cents) plus an upper-cased
ISO-4217 currency code:

```ts
interface Money { readonly amount: number; readonly currency: string; }
```

- All arithmetic is integer arithmetic. Same-currency only - cross-currency operations throw and must pass
  through FX explicitly.
- The number of minor units per currency is data (2 for USD/EUR/GBP, 0 for JPY, 3 for BHD…), configurable
  per tenant in the platform.
- Rates and percentages are applied through **one** explicitly-rounded helper (`multiply`/`percentOf`) with
  a selectable rounding mode (`half-up`, `half-even`, `down`, `up`), so every result is reproducible.
- A **penny-perfect `allocate`** guarantees split amounts sum back exactly to the original - essential for
  reconciliation.
- On the wire and in the DB, money is stored as `*_minor` integer columns + a currency column.

## Consequences

**Positive:** exact, reproducible, reconcilable arithmetic; no rounding drift; reconciliation can assert
zero difference; correctness is unit-testable in isolation (38 passing tests).

**Negative / accepted:** developers must construct money via `money`/`fromMajor` and never do ad-hoc float
maths; display formatting and i18n happen at the edges; FX revaluation is a deliberate separate concern
(designed-for).

**Note:** JavaScript's `number` is a 53-bit-safe integer, ample for realistic reinsurance amounts in minor
units; very large aggregates would move to `bigint` if ever needed.
