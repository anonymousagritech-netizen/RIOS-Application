-- 0061_accumulation_control.sql
--
-- Accumulation control at bind time (industry-gap-analysis Tier-3 item 14):
-- "if we bind this, the zone aggregate becomes X vs limit Y". Zonal aggregate
-- limits (peril optional) with a HARD (blocks the BOUND transition) / SOFT
-- (binds with warnings) mode, checked inside the bind transaction.
--
-- Per-contract zone exposure deliberately REUSES the existing accumulation +
-- exposure_entry tables (migration 0009): exposure_entry.contract_id joined to
-- accumulation.zone/peril already carries what a contract contributes to each
-- zone, so no second exposure table is added here.
--
-- Money is integer minor units. Additive + idempotent. RLS enable-only
-- (rios_app enforced; owner exempt) - pattern as 0052.

create table if not exists accumulation_zone_limit (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  zone        text not null,             -- e.g. 'US-FL-WIND', a CRESTA code, ...
  peril       text,                      -- null = the limit covers all perils in the zone
  currency    char(3) not null,
  limit_minor bigint not null check (limit_minor > 0),
  mode        text not null default 'SOFT' check (mode in ('HARD','SOFT')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references app_user(id) on delete set null,
  -- nulls not distinct: at most one all-perils limit per tenant/zone/currency.
  unique nulls not distinct (tenant_id, zone, peril, currency)
);
create index if not exists accumulation_zone_limit_active_idx
  on accumulation_zone_limit (tenant_id, zone) where active;

do $$
declare t text;
begin
  foreach t in array array['accumulation_zone_limit']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
