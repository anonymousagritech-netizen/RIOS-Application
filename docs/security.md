# RIOS — Security & Trust

**Phase:** cross-cutting (designed from Phase 4) · **Version:** 1.0
**Roles consulted:** Security Architect, Database Architect, CTO, Compliance Specialist
**Status:** Core controls delivered (JWT, RBAC, RLS, hash-chained audit, append-only grants). SSO/MFA, FLS, KMS designed-for.

## Purpose & scope

Security and trust (brief §14): identity/JWT, the RBAC (+ABAC-ready) model, RLS row-level isolation and how
`runAs` enforces it, the append-only hash-chained audit, the append-only grant model, tenant-isolation
verification, secrets/env, and an honest list of what is designed-for-but-not-yet.

Security is foundational (§4.2) and was designed in from Phase 4, not retrofitted. RIOS is a foundation: the
controls below are real, but the full enterprise security posture (SSO/SAML/MFA, FLS, KMS rotation, SIEM,
pen-testing) is designed-for and named, not silently absent (§3.3).

---

## 1. Identity & authentication

- **Login** (`POST /api/auth/login`): the password is verified **in SQL via pgcrypto** —
  `password_hash = crypt($password, password_hash)` — against a bcrypt hash (`gen_salt('bf')`). The user must
  be `status = 'active'`; an optional `tenantCode` is matched. No match → `401 Invalid credentials`. The
  lookup runs on the **owner** connection (pre-tenant-context), so it can resolve the tenant before RLS is set.
- **Token**: on success a **JWT signed with `JWT_SECRET`** is issued, expiring in **12h**
  (`config.jwtExpiresIn`). The payload is the entire `AuthUser`: `id, email, displayName, tenantId, roles[],
  permissions[]`.
- **Per-request validation**: `authenticate` requires `Authorization: Bearer <token>`, verifies it, and
  attaches `req.auth`. There is **no server-side session/revocation store** — the token is self-contained
  until expiry.

> **Designed-for:** SSO via OAuth2/OIDC and SAML, Azure AD / Entra ID, LDAP, and policy-enforced **MFA**
> (§14.1). The schema is ready: `app_user.password_hash` is nullable for SSO-federated users.

## 2. Authorization — RBAC (and ABAC-ready)

- **RBAC** is delivered. At login, roles and permissions are resolved by joining `user_role` →
  `role_permission`. The resolved **permission strings are baked into the JWT**.
- **Enforcement**: `requirePermission(perm)` is a Fastify preHandler that requires `perm` in the token's
  `permissions[]`. The wildcard **`admin:manage` overrides every check**. Denial → `403 { error: "Missing
  permission: <perm>" }`.
- **Permissions in use**: `config:read/write`, `party:read/write`, `treaty:read/write/bind`,
  `accounting:read/post`, `claims:read/write`, `admin:manage`.
- **Seeded roles**: ADMIN (all 12), TREATY_UW, ACCOUNTANT, CLAIMS — least-privilege by design (e.g. an
  accountant has no `treaty:write`, proven by the assistant 403 test).

> **ABAC-ready:** `user_role.scope (jsonb)` and the `org_unit` hierarchy are modelled as the attribute slot
> (tenant / org unit / LOB / classification) per §14.1, but **attribute policies are not yet enforced** in
> queries. Four-eyes / maker-checker is designed-for.
>
> **Note on token caching:** because permissions live in the JWT for up to 12h, role changes take effect on
> next login. Immediate revocation (short TTL + refresh, or a deny-list) is designed-for.

## 3. Tenant isolation — Row-Level Security

The strongest control in the system, enforced by the database itself ([ADR 0002](./adr/0002-multitenancy-rls.md)).

- **App role**: the application connects as the low-privilege **`rios_app`** role (not owner/superuser), so
  RLS is *enforced* and cannot be bypassed. A separate owner connection is used only for migrations/seeding.
- **Per-request context — `runAs`**: opens a transaction and sets, as **`LOCAL`** (transaction-scoped)
  settings:
  - `app.tenant_id` = the caller's tenant
  - `app.user_id` = the caller's user id
  On commit/rollback the settings vanish, so a pooled connection can never carry one tenant's context into
  another request.
- **The policy** (applied to every tenant table via a loop in `0008`):
  ```sql
  alter table <t> enable row level security;
  alter table <t> force row level security;
  create policy tenant_isolation on <t>
    using      (tenant_id = app_current_tenant())
    with check (tenant_id = app_current_tenant());
  ```
  where
  ```sql
  create function app_current_tenant() returns uuid language sql stable as $$
    select nullif(current_setting('app.tenant_id', true), '')::uuid
  $$;
  ```
  `force row level security` makes the policy apply even to the table owner; `nullif(…, '')` means an **unset
  tenant yields NULL → no rows** (fail-closed). `using` filters reads/updates/deletes; `with check` blocks
  writing rows into another tenant. The `tenant` table itself has a `tenant_self` policy keyed on `id`.
- **Coverage**: every tenant-scoped table (identity, reference, parties, core, accounting, claims, audit,
  outbox) is RLS-protected. The only exceptions are the global, read-only `permission` catalog (no
  `tenant_id`) and the FK-detached `audit_log`/`outbox` (still RLS-protected).

> **Verification (§14.5):** the server integration suite exercises tenant-scoped flows through `runAs`. A
> dedicated negative cross-tenant test (assert tenant A cannot read tenant B) is a recommended addition —
> see [open-questions.md](./open-questions.md).

## 4. Audit — append-only, hash-chained, tamper-evident

Every material mutation writes one `audit_log` row inside the caller's tenant transaction (so audit and the
change commit or roll back together).

- **Fields**: `tenant_id`, `actor_user_id`, `actor_label`, `action`, `entity_type`, `entity_id`,
  `before`/`after` (jsonb), `context` (jsonb), `prev_hash`, `row_hash`, `occurred_at`, and a monotonic
  `id bigint generated always as identity`.
- **Hash chain** (per tenant): the writer fetches the previous row's `row_hash` as `prev_hash`, builds a
  **canonical JSON** over `{ tenantId, actor, action, entityType, entityId, before, after }`, and computes
  `row_hash = sha256(prev_hash || canonical)`. Any retroactive edit to a row breaks every subsequent hash, so
  tampering is detectable.
  > **Accuracy note:** `actor_label` and `context` are **not** part of the hashed canonical payload — only the
  > seven core fields are. Ordering relies on the identity `id` (there is no separate sequence column), and
  > the hash is computed **in application code**, not by a DB trigger.
- **Append-only enforcement**: `0008` runs `revoke update, delete on audit_log from rios_app;` — the app role
  can only `INSERT`/`SELECT`. Combined with the hash chain this makes the log append-only **and**
  tamper-evident.
- **What is audited**: party create; contract create / transition / bind; deposit-premium financial event; GL
  `post`/journal; claim create and reserve movement; and assistant-confirmed creates (tagged
  `context:{ assistant:true }`).

## 5. Append-only grant model

Authorization grants are additive: a user's effective permissions are the union over their roles'
`role_permission` rows. There is no per-row "deny" that must be reconciled — least privilege is achieved by
*not* granting, and the wildcard `admin:manage` is the single, explicit, audited escalation. Grant changes are
ordinary tenant data subject to RLS and (where wired) audit.

## 6. Data protection

- **In transit**: TLS terminates at the deployment edge (designed-for in IaC); the app speaks plain HTTP
  behind it in dev.
- **At rest**: PostgreSQL storage encryption is a deployment/infra concern (designed-for). Passwords are
  bcrypt-hashed via pgcrypto.
- **Money integrity**: integer minor units only, no floats — a data-integrity control as much as a
  correctness one ([ADR 0003](./adr/0003-money-as-minor-units.md)).

> **Designed-for (§14.2):** tenant-scoped encryption keys with **KMS-managed rotation**, **Field-Level
> Security / column masking** for sensitive data, data classification, retention schedules, legal hold,
> right-to-erasure, and data-residency options.

## 7. Assistant trust boundary

The embedded assistant has **no privileged backdoor** (§9.15): it runs through the same RLS-scoped `runAs`
transaction and the same RBAC checks as a human. Every mutating action is **prepared, then confirmed** in a
second call that re-checks permissions server-side; an under-permissioned confirm returns `403`. It grounds
answers in tenant data and never fabricates figures, and it works with AI disabled. See
[ADR 0005](./adr/0005-assistant-guardrails.md).

## 8. Secrets & environment

Configuration is environment-driven (`.env`, see `.env.example`):

- `DATABASE_URL` — owner connection (migrations/seed; bypasses RLS).
- `DATABASE_APP_URL` — the `rios_app` connection (RLS enforced) used for all tenant queries.
- `JWT_SECRET` — token signing secret (the dev value **must** be replaced in every real environment).
- `ANTHROPIC_API_KEY` — optional; the platform is fully usable without it (§12.6).

> **Designed-for:** a real secrets manager (Vault/KMS/SSM) rather than env files; secret rotation;
> SAST/DAST, dependency and secrets scanning in CI; a Security Center / SOC dashboard and SIEM integration
> (§14.4).

## Traceability

Brief §14 (all subsections), §4.2/§4.3 (secure, auditable, reversible), §9.2 (Identity, Access & Security
domain), §16.3 (data-layer isolation). ADRs [0002](./adr/0002-multitenancy-rls.md),
[0003](./adr/0003-money-as-minor-units.md), [0005](./adr/0005-assistant-guardrails.md).

## Cross-cutting compliance note

Authentication, RBAC, RLS isolation, and append-only hash-chained audit are delivered and enforced at the
database layer, not merely in application code. Tenant isolation is structural and fail-closed.

## Open Questions / Assumptions / Gaps

- **SSO/SAML/OIDC/Azure AD/LDAP and MFA** — designed-for; schema-ready (nullable `password_hash`).
- **ABAC policy enforcement** — modelled (`user_role.scope`, `org_unit`) but not applied in queries; **FLS /
  column masking** — not implemented.
- **KMS / per-tenant keys / rotation**, **encryption-at-rest config**, **TLS termination** — deployment-layer,
  designed-for.
- **Immediate token revocation** — currently bounded by the 12h JWT lifetime; refresh-token + deny-list
  designed-for.
- **Negative cross-tenant isolation test**, **secrets manager**, **SAST/DAST/pen-test in CI**, **SOC/SIEM**,
  **retention / legal hold / right-to-erasure** — designed-for. See [open-questions.md](./open-questions.md).
