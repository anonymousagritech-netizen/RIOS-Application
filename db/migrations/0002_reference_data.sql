-- =============================================================================
-- RIOS - Migration 0002: Reference data / code lists (the metadata-driven core)
-- Brief §4.1, §10 (configurability mandate), §10.3 (reference-data service)
-- =============================================================================
-- THE most load-bearing constraint in the brief: anything a customer could
-- reasonably change is configuration served from the database, never a literal
-- in source. Code lists are versioned and effective-dated so a value added today
-- does not corrupt last year's records (§10.3).

-- A code_list is a named set of allowed values, e.g. 'contract_status',
-- 'line_of_business', 'currency', 'financial_event_type'.
create table code_list (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  key         citext not null,                -- 'contract_status'
  name        text not null,
  description text,
  -- system lists are seeded and protected; tenants may extend but not break them
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

create table code_value (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code_list_id  uuid not null references code_list(id) on delete cascade,
  code          citext not null,              -- 'BOUND'
  label         text not null,                -- 'Bound'  (translatable, §19)
  -- arbitrary structured metadata: colour, icon, downstream behaviour flags, etc.
  meta          jsonb not null default '{}'::jsonb,
  sort_order    int not null default 0,
  is_active     boolean not null default true,
  -- effective-dating: a value is valid within [effective_from, effective_to)
  effective_from date not null default '0001-01-01',
  effective_to   date,
  created_at    timestamptz not null default now(),
  unique (code_list_id, code, effective_from)
);

create index on code_value (tenant_id, code_list_id) where is_active;

-- ---------------------------------------------------------------------------
-- Currencies & exchange rates (§9.1, §19, §16.1)
-- ---------------------------------------------------------------------------
create table currency (
  tenant_id    uuid not null references tenant(id) on delete cascade,
  code         char(3) not null,
  name         text not null,
  minor_units  smallint not null default 2,    -- ISO-4217 exponent; drives money math
  symbol       text,
  is_active    boolean not null default true,
  primary key (tenant_id, code)
);

create table exchange_rate (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  from_ccy     char(3) not null,
  to_ccy       char(3) not null,
  rate         numeric(20,10) not null check (rate > 0),
  rate_date    date not null,
  source       text not null default 'manual',
  created_at   timestamptz not null default now(),
  unique (tenant_id, from_ccy, to_ccy, rate_date)
);

create index on exchange_rate (tenant_id, from_ccy, to_ccy, rate_date desc);

-- ---------------------------------------------------------------------------
-- Numbering schemes (§10.2 - configurable reference/numbering)
-- ---------------------------------------------------------------------------
create table numbering_scheme (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  key         citext not null,               -- 'treaty_reference'
  prefix      text not null default '',
  -- a printf-style pattern, e.g. 'TRTY-{YYYY}-{SEQ:6}'
  pattern     text not null,
  next_seq    bigint not null default 1,
  unique (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- Generic configuration store (form layouts, dashboards, workflow defs, rules)
-- Brief §10.3: screens, workflows, rules and templates are metadata, versioned.
-- ---------------------------------------------------------------------------
create table config_document (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  kind         text not null,                 -- 'form','workflow','rule','dashboard','report','template','menu'
  key          citext not null,               -- 'treaty.edit', 'statement.generate'
  version      int not null default 1,
  status       text not null default 'draft' check (status in ('draft','published','archived')),
  body         jsonb not null,                -- the actual definition
  effective_from timestamptz not null default now(),
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  unique (tenant_id, kind, key, version)
);

create index on config_document (tenant_id, kind, key, status);

comment on table config_document is
  'Versioned home for metadata-driven definitions: forms, workflows, rules, dashboards, reports, templates, menus (§10.3). Published version is served at runtime; drafts are sandboxed (§10.4).';
