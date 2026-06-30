-- =============================================================================
-- RIOS — Migration 0013: Regulatory (IFRS 17 / Solvency II) & Documents
-- Brief §18.1–§18.2 (regulatory), §9.4 (documents/templates)
-- =============================================================================

-- IFRS 17: a group of insurance contracts measured together (PAA here, §18.1).
create table ifrs17_group (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  measurement_model text not null default 'PAA' check (measurement_model in ('PAA','GMM','VFA')),
  -- reinsurance-held vs reinsurance-issued treatment (§18.1)
  held_or_issued text not null default 'ISSUED' check (held_or_issued in ('ISSUED','HELD')),
  portfolio     text,
  cohort_year   int,
  currency      char(3) not null,
  created_at    timestamptz not null default now(),
  unique (tenant_id, name)
);
create index on ifrs17_group (tenant_id);

-- A point-in-time measurement of a group (LRC, LIC, loss component, totals).
create table ifrs17_measurement (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  group_id      uuid not null references ifrs17_group(id) on delete cascade,
  as_at         date not null default current_date,
  inputs        jsonb not null default '{}'::jsonb,
  lrc_minor     bigint not null default 0,
  lic_minor     bigint not null default 0,
  loss_component_minor bigint not null default 0,
  total_liability_minor bigint not null default 0,
  is_onerous    boolean not null default false,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on ifrs17_measurement (tenant_id, group_id);

-- Solvency II: an SCR/MCR calculation run (standard-formula skeleton, §18.2).
create table solvency_run (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  as_at         date not null default current_date,
  currency      char(3) not null,
  inputs        jsonb not null default '{}'::jsonb,
  basic_scr_minor bigint not null default 0,
  operational_risk_minor bigint not null default 0,
  scr_minor     bigint not null default 0,
  mcr_minor     bigint not null default 0,
  own_funds_minor bigint not null default 0,
  solvency_ratio numeric(8,4),
  status        text not null default 'final' check (status in ('draft','final')),
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on solvency_run (tenant_id, as_at);

-- The per-module SCR breakdown for a run (market, underwriting, counterparty, …).
create table scr_module (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  run_id        uuid not null references solvency_run(id) on delete cascade,
  module        text not null,
  scr_minor     bigint not null default 0
);
create index on scr_module (tenant_id, run_id);

-- ---------------------------------------------------------------------------
-- Documents & templates (§9.4) — generated artifacts (slips, statements, etc.)
-- ---------------------------------------------------------------------------
-- Template definitions live in config_document (kind='template'); generated
-- documents are recorded here with their merge context and a link to storage.
create table document (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  template_key  citext,
  title         text not null,
  doc_type      text not null default 'generic',  -- 'slip','statement','contract','report'
  entity_type   text,
  entity_id     uuid,
  -- rendered content (for small docs) or a storage pointer for large/binary ones
  content       text,
  storage_url   text,
  merge_context jsonb not null default '{}'::jsonb,
  status        text not null default 'draft' check (status in ('draft','final','issued')),
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on document (tenant_id, entity_type, entity_id);
create index on document (tenant_id, doc_type);

do $$
declare t text;
begin
  foreach t in array array['ifrs17_group','ifrs17_measurement','solvency_run','scr_module','document'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
