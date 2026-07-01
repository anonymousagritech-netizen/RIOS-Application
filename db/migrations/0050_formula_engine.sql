-- 0050_formula_engine.sql
--
-- Formula Engine (metadata-driven reinsurance calculations). Tenants can store,
-- version and effective-date FormulaDefinitions (the same shape consumed by the
-- pure @rios/domain computeFormula) so calculations can be edited without a
-- redeploy. formula_override records an authorised, reasoned override of a
-- system-computed field value, retaining the original so the system value can be
-- restored. Money is integer minor units.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists formula_definition (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  key            citext not null,
  name           text not null,
  category       text,
  version        int not null default 1,
  effective_from date,
  effective_to   date,
  definition     jsonb not null,               -- the full FormulaDefinition
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user(id) on delete set null,
  unique (tenant_id, key, version)
);
create index if not exists formula_definition_key_idx on formula_definition (tenant_id, key);

create table if not exists formula_override (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  entity_type    text not null,
  entity_id      text not null,
  field          text not null,
  formula_key    text,
  original_minor bigint,
  override_minor bigint,
  reason         text not null,
  status         text not null default 'ACTIVE',
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user(id) on delete set null,
  restored_at    timestamptz,
  restored_by    uuid references app_user(id) on delete set null
);
create index if not exists formula_override_entity_idx on formula_override (tenant_id, entity_type, entity_id);

do $$
declare t text;
begin
  foreach t in array array['formula_definition','formula_override']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
