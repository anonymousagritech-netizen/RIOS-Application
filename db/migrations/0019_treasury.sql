-- =============================================================================
-- RIOS - Migration 0019: Treasury, investments & tax/levies (brief §9, §13)
-- The asset side (an investment portfolio backing reserves) and the configurable
-- premium-tax / levy stack. Valuations & levy maths live in @rios/domain; these
-- tables are the persisted state. Money is integer minor units.
-- =============================================================================

-- An investment holding in a portfolio.
create table investment_holding (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  portfolio        text not null default 'GENERAL',
  name             text not null,
  instrument_type  text not null check (instrument_type in ('BOND','BILL','EQUITY','CASH','FUND')),
  currency         char(3) not null,
  face_value_minor   bigint not null default 0,
  book_value_minor   bigint not null default 0,
  market_value_minor bigint not null default 0,
  coupon_rate      numeric(9,6),                 -- annual fraction, fixed income
  maturity_date    date,
  acquired_date    date not null default current_date,
  status           text not null default 'HELD' check (status in ('HELD','SOLD','MATURED')),
  created_by       uuid references app_user(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on investment_holding (tenant_id, portfolio) where status = 'HELD';
create index on investment_holding (tenant_id, instrument_type);

-- A configurable tax/levy applied to premium (or another base).
create table tax_levy (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          citext not null,
  name          text not null,
  jurisdiction  text,
  rate          numeric(9,6) not null,           -- fraction, e.g. 0.05
  basis         text not null default 'premium', -- which base the rate applies to
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);
create index on tax_levy (tenant_id) where active;

do $$
declare t text;
begin
  foreach t in array array['investment_holding','tax_levy'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
