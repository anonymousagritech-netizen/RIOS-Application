-- =============================================================================
-- RIOS - Migration 0067: Treasury dealing sub-ledger, market data & cash-flow
-- forecasting (brief §9, §13, §16). Moves Treasury from Partial to Delivered:
--   * investment_trade  - a full dealing/settlement sub-ledger (BUY/SELL capture
--     -> confirm -> settle). Settlement books a balanced GL journal (cash vs the
--     investment asset account) via the existing accounting posting path.
--   * market_price       - the market-data store. RIOS ships a *deterministic
--     mock* provider that populates this (source='MOCK'); a real vendor feed
--     (Bloomberg/Refinitiv/ICE) is the integration seam that would replace it.
--   * cash_flow_forecast / _line - persisted liquidity forecasts, bucketed by the
--     pure @rios/domain bucketCashFlows engine.
-- Money is integer minor units. Additive + idempotent. RLS enable-only
-- (rios_app enforced via tenant_isolation; owner exempt), grants to rios_app.
-- =============================================================================

-- Dealing sub-ledger: one row per investment trade through its lifecycle.
create table if not exists investment_trade (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id) on delete cascade,
  instrument           text not null,
  trade_type           text not null check (trade_type in ('BUY','SELL')),
  trade_date           date not null default current_date,
  settle_date          date not null default current_date,
  quantity             numeric(20,4) not null,
  price_minor          bigint not null,                  -- clean price per unit, minor units
  gross_minor          bigint not null,                  -- qty*price (+/- fees per side)
  fees_minor           bigint not null default 0,
  currency             char(3) not null,
  status               text not null default 'CAPTURED'
                         check (status in ('CAPTURED','CONFIRMED','SETTLED','CANCELLED')),
  counterparty_party_id uuid references party(id) on delete set null,
  journal_id           uuid references journal(id) on delete set null,  -- set on settle
  created_by           uuid references app_user(id) on delete set null,
  created_at           timestamptz not null default now()
);
create index if not exists investment_trade_idx on investment_trade (tenant_id, status, trade_date desc);
create index if not exists investment_trade_instrument_idx on investment_trade (tenant_id, instrument);

-- Market-data store: latest/observed prices per instrument. Populated by the
-- deterministic MOCK provider; a real feed would write here with its own source.
create table if not exists market_price (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  instrument   text not null,
  as_of        date not null default current_date,
  price_minor  bigint not null,
  currency     char(3) not null,
  source       text not null default 'MOCK',
  created_at   timestamptz not null default now(),
  unique (tenant_id, instrument, as_of, source)
);
create index if not exists market_price_idx on market_price (tenant_id, instrument, as_of desc);

-- A persisted cash-flow forecast header + its bucketed lines.
create table if not exists cash_flow_forecast (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  as_of         date not null default current_date,
  horizon_days  int not null,
  currency      char(3) not null default 'USD',
  created_by    uuid references app_user(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists cash_flow_forecast_idx on cash_flow_forecast (tenant_id, as_of desc);

create table if not exists cash_flow_forecast_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  forecast_id   uuid not null references cash_flow_forecast(id) on delete cascade,
  bucket_date   date not null,
  inflow_minor  bigint not null default 0,
  outflow_minor bigint not null default 0,
  net_minor     bigint not null default 0,
  currency      char(3) not null,
  source        text
);
create index if not exists cash_flow_forecast_line_idx on cash_flow_forecast_line (tenant_id, forecast_id, bucket_date);

-- Investment asset control account for the dealing sub-ledger's settlement legs.
-- Seed the chart with a '1200 Investments' asset account per tenant if absent so
-- BUY/SELL settlement has a real cash (1000) <-> investment (1200) contra pair.
insert into gl_account (tenant_id, code, name, type, is_control)
select id, '1200', 'Investments', 'asset', false from tenant
on conflict (tenant_id, code) do nothing;

do $$
declare t text;
begin
  foreach t in array array['investment_trade','market_price','cash_flow_forecast','cash_flow_forecast_line']
  loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
