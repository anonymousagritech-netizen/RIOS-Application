-- =============================================================================
-- RIOS — Migration 0004: Reinsurance core (programme, contract, layer, participation, terms)
-- Brief §7.2–§7.5, §9.6, §28 (illustrative core model), §29 (module functional notes)
-- =============================================================================

-- A programme groups related contracts protecting a book or layer band (§28.1).
create table programme (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  reference     text,
  name          text not null,
  cedent_party_id uuid references party(id),
  period_start  date,
  period_end    date,
  currency      char(3) not null,
  status        citext not null default 'OPEN',   -- code_value: programme_status
  is_deleted    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index on programme (tenant_id) where not is_deleted;

-- The cover instrument: treaty, facultative certificate, or retrocession contract.
create table contract (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  programme_id    uuid references programme(id) on delete set null,
  reference       text,
  name            text not null,
  -- business line / structure, all from code lists (§10)
  contract_kind   citext not null,        -- 'TREATY','FACULTATIVE','RETROCESSION'
  basis           citext not null,        -- 'PROPORTIONAL','NON_PROPORTIONAL'
  proportional_type citext,               -- 'QUOTA_SHARE','SURPLUS' (when proportional)
  np_type           citext,               -- 'PER_RISK_XL','CAT_XL','AGG_XL','STOP_LOSS' (when non-proportional)
  line_of_business  citext,               -- code_value: line_of_business
  -- direction relative to the tenant: inwards (assumed) vs outwards (ceded/retro)
  direction       text not null default 'INWARDS' check (direction in ('INWARDS','OUTWARDS')),
  cedent_party_id uuid references party(id),
  broker_party_id uuid references party(id),
  currency        char(3) not null,
  period_start    date,
  period_end      date,
  -- state machine value (§28.3), validated against code list 'contract_status'
  status          citext not null default 'DRAFT',
  wording_ref     text,
  market_refs     jsonb not null default '{}'::jsonb,   -- UMR, bureau refs, etc.
  is_deleted      boolean not null default false,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on contract (tenant_id, status) where not is_deleted;
create index on contract (tenant_id, programme_id);
create index on contract (tenant_id, contract_kind, basis);

-- A layer/section of a non-proportional contract (§28.1). Money stored in minor units.
create table contract_layer (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  contract_id     uuid not null references contract(id) on delete cascade,
  layer_no        int not null,
  name            text,
  currency        char(3) not null,
  attachment_minor  bigint not null default 0,   -- priority / retention
  limit_minor       bigint not null default 0,
  aad_minor         bigint not null default 0,    -- annual aggregate deductible
  reinstatements    int,                          -- null = unlimited
  reinstatement_rates jsonb not null default '[]'::jsonb,  -- [1.0, 0.5] fractions of annual premium
  rate_on_line      numeric(12,8),
  created_at      timestamptz not null default now(),
  unique (contract_id, layer_no)
);

create index on contract_layer (tenant_id, contract_id);

-- A (re)insurer's share of a contract/layer with written vs signed lines (§7.3 step 4, §29.4).
create table participation (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  contract_id     uuid not null references contract(id) on delete cascade,
  layer_id        uuid references contract_layer(id) on delete cascade,
  party_id        uuid not null references party(id),  -- the reinsurer taking the line
  role_code       citext not null default 'reinsurer',
  written_line    numeric(9,6) not null default 0,     -- intended share, e.g. 0.15
  signed_line     numeric(9,6),                         -- final share after signing down
  order_pct       numeric(9,6),                         -- the placed order (e.g. 1.0 = 100%)
  status          citext not null default 'WRITTEN',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on participation (tenant_id, contract_id);

-- Configurable commercial terms attached to a contract/layer, versioned & effective-dated (§28.1, §10).
create table term_set (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  contract_id     uuid not null references contract(id) on delete cascade,
  layer_id        uuid references contract_layer(id) on delete cascade,
  version         int not null default 1,
  effective_from  date not null default current_date,
  -- the full structured term bag: commissions, brokerage, taxes, EPI, MDP,
  -- instalments, reinstatement basis, indexation, hours clause, occurrence def.
  terms           jsonb not null default '{}'::jsonb,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now()
);

create unique index term_set_unique_version on term_set
  (contract_id, coalesce(layer_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
create index on term_set (tenant_id, contract_id);

-- The underlying exposure for facultative & exposure aggregation (§28.1).
create table risk (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  contract_id     uuid references contract(id) on delete set null,
  reference       text,
  description     text,
  insured_name    text,
  line_of_business citext,
  country         char(2),
  peril_zone      text,
  sum_insured_minor bigint,
  currency        char(3),
  inception       date,
  expiry          date,
  created_at      timestamptz not null default now()
);

create index on risk (tenant_id, contract_id);
create index on risk (tenant_id, peril_zone);
