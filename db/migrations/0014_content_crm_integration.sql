-- =============================================================================
-- RIOS — Migration 0014: Content/Templates, Reporting, CRM, Integration
-- Brief §9.4 (content), §13 (reporting/BI), §9.11 (CRM), §17 (integration)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Template engine (§9.4) — document templates with a safe merge syntax.
-- The `document` table (migration 0013) stores rendered output; this holds the
-- reusable, versioned templates (slips, statements, contract wordings, emails).
-- ---------------------------------------------------------------------------
create table document_template (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  key           citext not null,
  name          text not null,
  doc_type      text not null default 'generic',   -- 'slip','statement','contract','email','report'
  -- body with {{merge.field}} placeholders rendered against a context (§10.3 template engine)
  body          text not null default '',
  version       int not null default 1,
  is_active     boolean not null default true,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  unique (tenant_id, key, version)
);
create index on document_template (tenant_id, doc_type) where is_active;

-- ---------------------------------------------------------------------------
-- Reporting & BI (§13) — governed report definitions executed over the warehouse.
-- ---------------------------------------------------------------------------
create table report_definition (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  key           citext not null,
  name          text not null,
  description   text,
  -- the data source (a whitelisted entity/view) and the report shape, all config (§13.1)
  source        text not null,                 -- 'contracts','claims','financial_events','statements',...
  columns       jsonb not null default '[]'::jsonb,   -- [{field,label,agg?}]
  filters       jsonb not null default '[]'::jsonb,   -- [{field,op,value}]
  grouping      jsonb not null default '[]'::jsonb,
  version       int not null default 1,
  status        text not null default 'published' check (status in ('draft','published','archived')),
  is_certified  boolean not null default false,  -- "trusted" data set (§13.6)
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  unique (tenant_id, key, version)
);
create index on report_definition (tenant_id, status);

-- A materialised execution of a report (for audit, scheduling, lineage §13.6).
create table report_run (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  definition_id uuid references report_definition(id) on delete set null,
  params        jsonb not null default '{}'::jsonb,
  row_count     int not null default 0,
  result        jsonb,                          -- small result sets inline; large ones go to storage
  status        text not null default 'complete' check (status in ('running','complete','error')),
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on report_run (tenant_id, definition_id);

-- ---------------------------------------------------------------------------
-- CRM (§9.11) — relationship activity & pipeline on parties.
-- ---------------------------------------------------------------------------
create table crm_activity (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  party_id      uuid references party(id) on delete cascade,
  kind          text not null default 'note' check (kind in ('call','email','meeting','note','task')),
  subject       text not null,
  body          text,
  due_date      date,
  completed     boolean not null default false,
  owner_user_id uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on crm_activity (tenant_id, party_id);
create index on crm_activity (tenant_id, completed) where not completed;

create table crm_opportunity (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  party_id      uuid references party(id) on delete cascade,
  name          text not null,
  stage         citext not null default 'PROSPECT',   -- PROSPECT/QUALIFIED/QUOTED/BOUND/LOST
  amount_minor  bigint not null default 0,
  currency      char(3) not null default 'USD',
  probability   numeric(5,2) not null default 0,       -- 0..100
  expected_close date,
  owner_user_id uuid references app_user(id),
  status        text not null default 'open' check (status in ('open','won','lost')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on crm_opportunity (tenant_id, stage);
create index on crm_opportunity (tenant_id, status);

-- ---------------------------------------------------------------------------
-- Integration (§17) — webhook subscriptions & delivery (outbox-driven §9.3).
-- ---------------------------------------------------------------------------
create table webhook_subscription (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  url           text not null,
  secret        text,
  event_types   jsonb not null default '[]'::jsonb,   -- ["contract.bound","claim.created",...]
  is_active     boolean not null default true,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on webhook_subscription (tenant_id) where is_active;

create table webhook_delivery (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  subscription_id uuid not null references webhook_subscription(id) on delete cascade,
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts      int not null default 0,
  response_code int,
  delivered_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index on webhook_delivery (tenant_id, subscription_id);
create index on webhook_delivery (tenant_id, status) where status <> 'delivered';

do $$
declare t text;
begin
  foreach t in array array['document_template','report_definition','report_run','crm_activity','crm_opportunity','webhook_subscription','webhook_delivery'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
