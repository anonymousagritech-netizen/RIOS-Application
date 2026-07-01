-- 0046_territory.sql
--
-- Territory Management (brief §17 / geographic reference). A metadata-driven
-- geographic master: a self-referential hierarchy (country → region → state →
-- city) plus the accumulation-zone taxonomies underwriters watch (CRESTA,
-- postal, peril and risk zones). Exposure_item already carries the per-risk
-- geo dimensions; this table is the reference tree those dimensions roll up to.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists territory (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  parent_id     uuid references territory(id) on delete set null,
  kind          text not null default 'COUNTRY'
                check (kind in ('COUNTRY','REGION','STATE','CITY','CRESTA','POSTAL','PERIL','RISK')),
  code          text not null,                 -- ISO2 for countries, zone code otherwise
  name          text not null,
  country_code  char(2),                       -- denormalised owning country (for zone rows)
  risk_grade    text check (risk_grade in ('LOW','MODERATE','ELEVATED','HIGH','SEVERE')),
  perils        text[] not null default '{}',  -- e.g. {EQ,WIND,FLOOD} for a peril/CRESTA zone
  attributes    jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (tenant_id, kind, code)
);
create index if not exists territory_tenant_idx on territory (tenant_id, kind);
create index if not exists territory_parent_idx on territory (parent_id);
create index if not exists territory_country_idx on territory (tenant_id, country_code);

do $$
declare t text;
begin
  foreach t in array array['territory']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
