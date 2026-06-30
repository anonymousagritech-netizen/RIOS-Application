-- =============================================================================
-- RIOS — Migration 0026: Product lifecycle management (brief §14)
-- The insurance-product factory: versioned product definitions driven through a
-- lifecycle state machine. The lifecycle and its transitions are interpreted by
-- @rios/domain (PRODUCT_LIFECYCLE + applyEvent); this table holds the products.
-- =============================================================================

create table insurance_product (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  code              citext not null,
  name              text not null,
  line_of_business  citext,
  version           int not null default 1,
  status            text not null default 'DRAFT' check (status in ('DRAFT','ACTIVE','SUSPENDED','RETIRED')),
  -- the configurable product definition (covers, terms, rating refs, wording)
  definition        jsonb not null default '{}'::jsonb,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, code, version)
);
create index on insurance_product (tenant_id, status);
create index on insurance_product (tenant_id, code);

do $$
begin
  execute 'alter table insurance_product enable row level security';
  execute 'alter table insurance_product force row level security';
  execute 'create policy tenant_isolation on insurance_product using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
end$$;
