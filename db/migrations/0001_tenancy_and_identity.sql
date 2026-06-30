-- =============================================================================
-- RIOS — Migration 0001: Tenancy, identity & the RLS foundation
-- Brief §4.2 (multi-tenant, secure-by-design), §14 (security), §16.3 (data-layer tenancy)
-- =============================================================================
-- Multi-tenancy model: shared schema with Row-Level Security. Every tenant-owned
-- row carries tenant_id. The application connects as a low-privilege role and sets
-- `app.tenant_id` / `app.user_id` per request; RLS policies (migration 0008)
-- restrict every query to the active tenant. This is the default isolation model
-- (§15.4); schema/database-per-tenant is a premium option layered on the same code.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive email/codes

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
create table tenant (
  id            uuid primary key default gen_random_uuid(),
  code          citext not null unique,
  name          text not null,
  -- Isolation tier: 'shared' (RLS), 'schema', 'database'. Only 'shared' is wired here.
  isolation     text not null default 'shared' check (isolation in ('shared','schema','database')),
  status        text not null default 'active' check (status in ('active','suspended','offboarding')),
  default_currency char(3) not null default 'USD',
  default_locale   text not null default 'en-US',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table tenant is 'A customer of the RIOS SaaS platform. Root of all tenant-scoped data.';

-- ---------------------------------------------------------------------------
-- Users (platform identity; SSO/MFA federate onto this in the real system, §14.1)
-- ---------------------------------------------------------------------------
create table app_user (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  email         citext not null,
  display_name  text not null,
  password_hash text,                       -- null when federated via SSO
  status        text not null default 'active' check (status in ('active','disabled','invited')),
  locale        text,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, email)
);

-- ---------------------------------------------------------------------------
-- Roles & permissions (RBAC core; ABAC attributes layer on top, §14.1)
-- ---------------------------------------------------------------------------
create table role (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  code        citext not null,
  name        text not null,
  description text,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

-- Permissions are catalog-wide (not tenant-scoped): a fixed vocabulary of
-- "module:action" strings the code checks against. Tenants grant them via roles.
create table permission (
  code        text primary key,            -- e.g. 'treaty:write', 'accounting:post'
  module      text not null,
  action      text not null,
  description text
);

create table role_permission (
  tenant_id     uuid not null references tenant(id) on delete cascade,
  role_id       uuid not null references role(id) on delete cascade,
  permission    text not null references permission(code) on delete cascade,
  primary key (role_id, permission)
);

create table user_role (
  tenant_id uuid not null references tenant(id) on delete cascade,
  user_id  uuid not null references app_user(id) on delete cascade,
  role_id  uuid not null references role(id) on delete cascade,
  -- ABAC scope refinement: optionally constrain a grant to an org unit / LOB / etc.
  scope    jsonb not null default '{}'::jsonb,
  primary key (user_id, role_id)
);

-- ---------------------------------------------------------------------------
-- Organisation structure (multi-company / branch, §9.1) — tenant-scoped, hierarchical
-- ---------------------------------------------------------------------------
create table org_unit (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  parent_id   uuid references org_unit(id) on delete restrict,
  code        citext not null,
  name        text not null,
  kind        text not null default 'company' check (kind in ('group','company','branch','department')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create index on app_user (tenant_id);
create index on role (tenant_id);
create index on org_unit (tenant_id);
