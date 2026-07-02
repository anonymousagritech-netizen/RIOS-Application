-- =============================================================================
-- RIOS - Migration 0081: Catastrophe Event Loss Table (ELT) store (brief §13 -
-- cat analysis / PML / accumulation). Moves cat-model provider integration from
-- Designed-for to Delivered:
--   * cat_elt        - one imported Event Loss Table (vendor, peril, region,
--     currency, source). RIOS ships a working CSV/JSON import adapter; a licensed
--     vendor API (RMS/Moody's, Verisk/AIR, CoreLogic) is the labelled seam that
--     writes here behind the same CatEltImporter interface.
--   * cat_elt_event  - the ELT rows: per-event annual occurrence rate and loss.
--   * cat_elt_metric - a cache of the pure @rios/domain metrics (AAL, EP curve,
--     PML profile) computed from the events, so dashboards render without
--     recomputing.
-- Losses are integer minor units; rates are events-per-year. Additive +
-- idempotent. RLS enable-only (rios_app enforced via tenant_isolation).
-- =============================================================================

create table if not exists cat_elt (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  name         text not null,
  vendor       text not null default 'IMPORT',      -- RMS / AIR / CoreLogic / IMPORT
  peril        text,
  region       text,
  currency     char(3) not null default 'USD',
  source       text not null default 'CSV',         -- CSV / JSON / vendor api name
  event_count  int not null default 0,
  contract_id  uuid references contract(id) on delete set null,  -- optional attachment
  created_by   uuid references app_user(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists cat_elt_idx on cat_elt (tenant_id, created_at desc);

create table if not exists cat_elt_event (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  elt_id       uuid not null references cat_elt(id) on delete cascade,
  event_ref    text,                                -- vendor event id
  event_name   text,
  rate         numeric(12,8) not null,              -- annual occurrence rate (lambda)
  loss_minor   bigint not null                      -- event loss, minor units
);
create index if not exists cat_elt_event_idx on cat_elt_event (tenant_id, elt_id);

create table if not exists cat_elt_metric (
  elt_id       uuid primary key references cat_elt(id) on delete cascade,
  tenant_id    uuid not null references tenant(id) on delete cascade,
  aal_minor    bigint not null,
  ep_curve     jsonb not null,                      -- [{lossMinor, rate, probability, returnPeriod}]
  pml_profile  jsonb not null,                      -- [{returnPeriod, lossMinor}]
  computed_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['cat_elt','cat_elt_event','cat_elt_metric']
  loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
