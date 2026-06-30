-- =============================================================================
-- RIOS — Migration 0009: Placement & Slip, Pricing & Rating, Exposure
-- Brief §7.3 (placement), §7.8 (pricing/exposure), §29.4, §29.5
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Placement & Slip (§29.4) — market the risk and capture written/signed lines
-- ---------------------------------------------------------------------------
create table slip (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid not null references contract(id) on delete cascade,
  reference     text,
  umr           text,                          -- unique market reference
  status        citext not null default 'DRAFT',  -- DRAFT/QUOTED/FIRM_ORDER/SIGNED/CLOSED
  order_pct     numeric(9,6) not null default 1.0,   -- the order being placed (100% = 1.0)
  -- written lines may oversubscribe; signing down reconciles to the order (§7.3 step 4)
  total_written numeric(12,6) not null default 0,
  total_signed  numeric(12,6) not null default 0,
  is_oversubscribed boolean not null default false,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on slip (tenant_id, contract_id);

-- A market line written on the slip by a (re)insurer. Signing-down derives the
-- signed line from the written line and the order. Linked to participation once bound.
create table market_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  slip_id       uuid not null references slip(id) on delete cascade,
  party_id      uuid not null references party(id),
  layer_id      uuid references contract_layer(id),
  written_line  numeric(9,6) not null default 0,
  signed_line   numeric(9,6),
  written_at    date not null default current_date,
  status        citext not null default 'WRITTEN',
  created_at    timestamptz not null default now()
);
create index on market_line (tenant_id, slip_id);

-- ---------------------------------------------------------------------------
-- Pricing & Rating (§29.5) — reproducible rating runs
-- ---------------------------------------------------------------------------
create table rating_run (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid references contract(id) on delete set null,
  layer_id      uuid references contract_layer(id) on delete set null,
  method        text not null check (method in ('BURNING_COST','EXPOSURE','BLEND','MANUAL')),
  -- the full input set (experience years, exposure bands, curve params) for reproducibility (§29.5)
  inputs        jsonb not null default '{}'::jsonb,
  -- the computed results (technical premium, ROL, pure & loaded burning cost)
  results       jsonb not null default '{}'::jsonb,
  technical_premium_minor bigint,
  rate_on_line  numeric(12,8),
  currency      char(3),
  status        text not null default 'final' check (status in ('draft','final','superseded')),
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on rating_run (tenant_id, contract_id);

-- ---------------------------------------------------------------------------
-- Exposure & Aggregate management (§7.8, §9.9)
-- ---------------------------------------------------------------------------
-- An accumulation point: aggregate exposure by peril/zone with a capacity limit.
create table accumulation (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  peril         text not null,
  zone          text not null,
  currency      char(3) not null,
  capacity_minor bigint not null default 0,    -- capacity / aggregate limit for the zone
  as_at         date not null default current_date,
  created_at    timestamptz not null default now(),
  unique (tenant_id, peril, zone, as_at)
);
create index on accumulation (tenant_id, peril, zone);

-- A risk's contribution to an accumulation (gross & net of inuring covers).
create table exposure_entry (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  accumulation_id uuid references accumulation(id) on delete cascade,
  risk_id       uuid references risk(id) on delete cascade,
  contract_id   uuid references contract(id) on delete set null,
  gross_exposure_minor bigint not null default 0,
  net_exposure_minor   bigint not null default 0,
  currency      char(3) not null,
  created_at    timestamptz not null default now()
);
create index on exposure_entry (tenant_id, accumulation_id);

-- Enable RLS + tenant policy for the new tables.
do $$
declare t text;
begin
  foreach t in array array['slip','market_line','rating_run','accumulation','exposure_entry'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
