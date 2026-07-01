-- 0042_underwriting_counterparties.sql
--
-- Broker & Cedent management, plus capacity and exposure registers (brief §7 /
-- §28). Brokers and cedents are parties (party_role 'broker' / 'cedent'); these
-- tables add the relationship profile, contracts, communications, and the
-- capacity/exposure registers the underwriting console reports against. Portfolio
-- and history are derived from contract / submission / claim by party.
-- RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

-- Broker relationship profile + hierarchy (parent_broker_id).
create table if not exists broker_profile (
  party_id                uuid primary key references party(id) on delete cascade,
  tenant_id               uuid not null references tenant(id) on delete cascade,
  tier                    text not null default 'STANDARD' check (tier in ('GLOBAL','REGIONAL','STANDARD','BOUTIQUE')),
  region                  text,
  parent_broker_id        uuid references party(id) on delete set null,
  default_commission_pct  numeric,
  relationship_score      integer,          -- 0..100
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Broker contracts / terms of business.
create table if not exists broker_contract (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  broker_party_id uuid not null references party(id) on delete cascade,
  reference       text,
  kind            text not null default 'TOBA' check (kind in ('TOBA','BINDER','LINESLIP','FACILITY','OTHER')),
  commission_pct  numeric,
  brokerage_pct   numeric,
  period_start    date,
  period_end      date,
  status          text not null default 'ACTIVE' check (status in ('DRAFT','ACTIVE','EXPIRED','TERMINATED')),
  notes           text,
  created_at      timestamptz not null default now()
);
create index if not exists broker_contract_idx on broker_contract (tenant_id, broker_party_id, created_at desc);

-- Cedent relationship profile + group structure (group_parent_id).
create table if not exists cedent_profile (
  party_id                uuid primary key references party(id) on delete cascade,
  tenant_id               uuid not null references tenant(id) on delete cascade,
  group_parent_id         uuid references party(id) on delete set null,
  domicile                char(2),
  rating_agency           text,
  rating                  text,             -- e.g. A+, AA-
  financial_strength_minor bigint,          -- e.g. capital / surplus
  relationship_score      integer,          -- 0..100
  capacity_allocated_minor bigint,          -- capacity earmarked to this cedent
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Communications log shared by brokers & cedents (party-scoped).
create table if not exists counterparty_communication (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  party_id    uuid not null references party(id) on delete cascade,
  kind        text not null default 'NOTE' check (kind in ('NOTE','EMAIL','CALL','MEETING','SUBMISSION','RENEWAL')),
  direction   text not null default 'INTERNAL' check (direction in ('INBOUND','OUTBOUND','INTERNAL')),
  subject     text,
  body        text,
  actor       uuid references app_user(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists counterparty_comm_idx on counterparty_communication (tenant_id, party_id, created_at desc);

-- Capacity register: available vs consumed by dimension (overall / geo / line /
-- peril / broker / cedent). Money in integer minor units.
create table if not exists capacity_line (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  dimension       text not null default 'OVERALL'
                  check (dimension in ('OVERALL','GEOGRAPHY','LINE_OF_BUSINESS','PERIL','BROKER','CEDENT')),
  dim_key         text not null default 'ALL',      -- e.g. 'US', 'PROPERTY', 'WINDSTORM'
  label           text,
  period          text,                             -- e.g. '2026'
  available_minor bigint not null default 0,
  consumed_minor  bigint not null default 0,
  warn_pct        integer not null default 80,      -- utilisation warn threshold
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists capacity_line_idx on capacity_line (tenant_id, dimension, dim_key);

-- Exposure register: insured/PML values geolocated + peril/line tagged.
create table if not exists exposure_item (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  submission_id   uuid references submission(id) on delete set null,
  name            text,
  country         char(2),
  admin1          text,                             -- state / province
  city            text,
  cresta          text,                             -- CRESTA zone
  postal          text,
  peril           text,
  line_of_business text,
  tiv_minor       bigint not null default 0,        -- total insured value
  pml_minor       bigint,                           -- probable maximum loss
  created_at      timestamptz not null default now()
);
create index if not exists exposure_item_idx on exposure_item (tenant_id, country, peril);
create index if not exists exposure_item_sub_idx on exposure_item (tenant_id, submission_id);

do $$
declare t text;
begin
  foreach t in array array['broker_profile','broker_contract','cedent_profile','counterparty_communication','capacity_line','exposure_item']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
