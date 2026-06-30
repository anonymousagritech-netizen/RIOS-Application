# RIOS — Configuration & Administration Guide

**Phase:** cross-cutting (§10 mandate) / 15 (admin docs) · **Version:** 1.0
**Roles consulted:** Enterprise Solution Architect, Product Owner, System Administrator persona, Technical Writer
**Status:** Reference-data configurability delivered (code lists, currencies, numbering). Form/workflow/rules/template interpreters designed-for.

## Purpose & scope

The admin/configuration guide (brief §10): what is metadata-driven, how effective-dating and versioning work,
how to add a status or code value **without a deployment**, the guardrails, and the anti-patterns that are
forbidden (§10.5).

This is the §4.1 / §10 non-negotiable: *anything a customer could reasonably want to change is configuration,
stored in the database and served at runtime — never a literal in source.* RIOS delivers the reference-data
core of this; the no-code designer surfaces (forms, workflows, rules, templates) are designed-for and noted.

---

## 1. What is metadata-driven today

| Configurable thing | Where it lives | Status |
|---|---|---|
| Statuses & state vocabularies (contract, claim, statement, programme, participation) | `code_list` / `code_value` | **Delivered** — validated at the app layer, **not** DB enums, so editable |
| Dropdowns / classes (line of business, party roles, financial-event types) | `code_list` / `code_value` | **Delivered** |
| Currencies & minor units | `currency` | **Delivered** (API: `GET /api/config/currencies`) |
| Exchange rates (effective-dated) | `exchange_rate` | **Delivered** (schema; admin UI in progress) |
| Reference numbering schemes (e.g. `TRTY-{YYYY}-{SEQ:5}`) | `numbering_scheme` | **Delivered** (drives auto-references) |
| Forms / workflows / rules / templates | `config_document` (versioned jsonb) | **Storage delivered; interpreters designed-for** |
| Roles & permissions | `role`, `role_permission`, `user_role` | **Delivered** (data-driven; admin UI in progress) |

The domain core's internal closed unions (e.g. `FinancialEventType` in `@rios/domain`) are the engine's
*internal* vocabulary; the customer-facing lists that map onto them (`financial_event_type` code list, each
value carrying a `{"dir":"DR"|"CR"}` meta) are reference data. See
[ADR 0004](./adr/0004-metadata-driven-config.md).

## 2. Effective-dating & versioning (§10.4)

Configuration is time-aware so a value introduced today does not corrupt last year's records:

- **`code_value`** — `effective_from` / `effective_to` window + `is_active`. Only active, in-effect values are
  returned by the config API. The uniqueness key includes `effective_from`, so a code can be re-defined for a
  new period without overwriting history.
- **`exchange_rate`** — a point-in-time series keyed by `rate_date`; "latest as of" is a DESC-index lookup.
- **`config_document`** — immutable **`version`** accretion with a `status` lifecycle
  (`draft → published → archived`) and `effective_from`. The published version is the one served at runtime.
- **`term_set`** — contract/layer commercial terms are versioned (`version` + `effective_from`), so a
  binding's terms are pinned to the version in force.

## 3. How to add a status or code value without a deployment

This is the §20 configurability NFR in action. Two equivalent paths:

### Via the API
```http
POST /api/config/code-lists/claim_status/values
Authorization: Bearer <token with config:write>
Content-Type: application/json

{ "code": "IN_LITIGATION", "label": "In Litigation", "meta": { "color": "amber" } }
```
The server validates the list key exists (else `404`), requires `code` and `label` (else `400`), auto-assigns
`sort_order` (max+1), inserts the value into the tenant's `claim_status` list, and returns it. The new status
is immediately available to every screen and query that reads `claim_status` — **no build, no release**.

### Via the Admin screen
The Admin → Configuration area (web, in progress) wraps the same endpoint: pick a code list, add/edit a value,
set its effective dates and meta (e.g. UI colour), and save. Because it calls the same governed API, the same
guardrails and audit apply.

> Reading the lists: `GET /api/config/code-lists` returns every list; `GET /api/config/code-lists/:key`
> returns one. Both require `config:read` and return only active, in-effect values.

## 4. Guardrails (§10.4)

- **Permission-controlled** — reads need `config:read`, writes need `config:write` (or `admin:manage`).
- **Tenant-scoped** — all reference data is under RLS; one tenant's configuration is invisible to another.
- **Effective-dated & versioned** — changes never silently rewrite history (see §2).
- **Audited** — configuration changes are mutations under the same audit regime as business data (the
  add-value path is a `config:write` action; extending audit coverage to all config writes is a small,
  recommended hardening).
- **Fail safe** — misconfiguration should block with a clear message rather than silently produce a wrong
  number (§10.4). Today, unknown list keys and missing fields are rejected; richer validation/sandbox/approval
  workflows for config are designed-for.

## 5. Forbidden anti-patterns (§10.5)

RIOS is built to *structurally avoid* these — call them out in any review:

- Enums hard-coded in source for **business** values (statuses, LOBs, party roles, event types). → Use code
  lists.
- Status strings compared as **literals in logic** for customer-facing meaning. → Read from reference data.
- Per-customer `if` branches in core. → Express via configuration / sanctioned extension points.
- Report/dashboard layouts baked into components. → `config_document` (designed-for interpreters).
- Currency or tax rules embedded in calculations. → `currency`, exchange rates, and (designed-for) tax/levy
  config.
- Menus assembled in code. → Navigation is metadata (designed-for).

> **Boundary:** true correctness invariants are **not** configuration and stay in code — double-entry must
> balance, money is integer minor units, and the legal contract-transition map is enforced by the engine. The
> *labels and allowed values* are configurable; the *integrity guarantees* are not.

## Traceability

Brief §10 (configurability mandate), §10.4 (guardrails), §10.5 (anti-patterns), §4.1 (non-negotiable), §20
(configurability NFR). Schema in [data-model.md](./data-model.md) §2; API in
[api-reference.md](./api-reference.md); decision in [ADR 0004](./adr/0004-metadata-driven-config.md).

## Cross-cutting compliance note

Reference data is tenant-isolated (RLS), permission-gated, and effective-dated. The add-value flow changes
behaviour with no deployment, satisfying the §20 configurability target for the delivered lists.

## Open Questions / Assumptions / Gaps

- **No-code designer UIs** for forms, workflows, rules, approval stages, and templates — the `config_document`
  store exists; the **interpreters and designers are designed-for** (brief §9.3, §10.3, §13).
- **Config sandbox / simulate / promotion / approval workflows** (§10.4) — designed-for.
- **Entitlement engine** (per-tenant/plan feature flags & limits) — designed-for (§9.1).
- **Audit on every config write** — the add-value path should consistently emit an audit row; a small
  hardening item.
- **Tax/levy and rating-parameter** configuration — modelled as terms/reference data conceptually, not yet a
  governed surface.
