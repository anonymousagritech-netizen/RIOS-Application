-- 0073_entitlements.sql
--
-- Per-tenant / per-plan entitlement engine (brief §9.1 - feature flags & limits).
-- Closes the "entitlement engine (flags & limits) is designed-for" gap: a real
-- plan catalog with typed entitlements, a tenant->plan assignment, and per-tenant
-- overrides, resolved (override > plan > unset) and enforced server-side.
--
-- A `plan` may be a global catalog plan (tenant_id null, seeded by the owner) or
-- tenant-scoped. Entitlements are typed FLAG (bool_value) or LIMIT (limit_value,
-- integer). Additive + idempotent. RLS enable-only (rios_app enforced; owner -
-- migrations/seed - exempt, so global catalog rows can be seeded).

-- Plan catalog: tenant_id null = shared/global plan visible to every tenant.
create table if not exists plan (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenant(id) on delete cascade,
  code       text not null,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
create index if not exists plan_tenant_idx on plan (tenant_id);

-- Typed entitlements attached to a plan. tenant_id mirrors the plan's owner
-- (null for global plans) so RLS can be enforced without a join.
create table if not exists entitlement (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references plan(id) on delete cascade,
  tenant_id   uuid references tenant(id) on delete cascade,
  key         text not null,
  kind        text not null check (kind in ('FLAG','LIMIT')),
  bool_value  boolean,
  limit_value bigint,
  created_at  timestamptz not null default now(),
  unique (plan_id, key)
);
create index if not exists entitlement_plan_idx on entitlement (plan_id);

-- Which plan a tenant is on (one plan per tenant).
create table if not exists tenant_plan (
  tenant_id   uuid primary key references tenant(id) on delete cascade,
  plan_id     uuid not null references plan(id) on delete cascade,
  assigned_at timestamptz not null default now()
);

-- Per-tenant override of a single entitlement; outranks the assigned plan.
create table if not exists tenant_entitlement_override (
  tenant_id   uuid not null references tenant(id) on delete cascade,
  key         text not null,
  kind        text not null check (kind in ('FLAG','LIMIT')),
  bool_value  boolean,
  limit_value bigint,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- RLS: enable-only (owner exempt for seeding). Plan/entitlement also expose
-- global (tenant_id null) rows read-only to every tenant; writes stay scoped.
do $$
declare t text;
begin
  foreach t in array array['plan','entitlement'] loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant() or tenant_id is null) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;

  foreach t in array array['tenant_plan','tenant_entitlement_override'] loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
