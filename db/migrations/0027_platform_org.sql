-- =============================================================================
-- RIOS — Migration 0027: Platform & org administration (brief §9.1, §13)
-- Multi-company (legal entities within a tenant), branch/office management,
-- feature & license flags, and cost/capacity records. All tenant-isolated.
-- =============================================================================

-- A legal entity / operating company within the tenant group.
create table company (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          citext not null,
  name          text not null,
  country       char(2),
  base_currency char(3),
  parent_id     uuid references company(id) on delete set null,
  status        text not null default 'active' check (status in ('active','dormant','closed')),
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);
create index on company (tenant_id);

-- A branch / office belonging to a company.
create table office (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  company_id   uuid references company(id) on delete set null,
  code         citext not null,
  name         text not null,
  city         text,
  country      char(2),
  is_head_office boolean not null default false,
  status       text not null default 'open' check (status in ('open','closed')),
  created_at   timestamptz not null default now(),
  unique (tenant_id, code)
);
create index on office (tenant_id, company_id);

-- Feature & license flags: gate optional capability per tenant.
create table feature_flag (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  key          citext not null,
  name         text not null,
  enabled      boolean not null default false,
  -- license seat limit (null = unlimited); plan tier label
  seat_limit   int,
  plan         text,
  updated_at   timestamptz not null default now(),
  unique (tenant_id, key)
);
create index on feature_flag (tenant_id) where enabled;

-- Cost & capacity records: spend lines with an optional capacity dimension.
create table cost_record (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  category      text not null,                 -- 'compute','storage','licenses','staff',...
  period        text not null,                 -- 'YYYY-MM'
  amount_minor  bigint not null default 0,
  currency      char(3) not null default 'USD',
  -- capacity: provisioned vs used (e.g. seats, GB, vCPU) for utilisation %
  capacity_provisioned numeric(14,2),
  capacity_used        numeric(14,2),
  capacity_unit        text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, category, period)
);
create index on cost_record (tenant_id, period);

do $$
declare t text;
begin
  foreach t in array array['company','office','feature_flag','cost_record'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
