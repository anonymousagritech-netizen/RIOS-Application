-- =============================================================================
-- RIOS — Migration 0006: Claims, events, reserves & recoveries
-- Brief §7.7 (claims & recoveries lifecycle), §9.7, §28.4 (claim state machine)
-- =============================================================================

-- A coded catastrophe/occurrence that aggregates losses across contracts (§7.7 step 7).
create table cat_event (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  event_code    citext not null,             -- market/cat code, e.g. 'HURR-2026-IAN'
  name          text not null,
  peril         text,
  region        text,
  event_date    date,
  status        citext not null default 'OPEN',
  created_at    timestamptz not null default now(),
  unique (tenant_id, event_code)
);

create index on cat_event (tenant_id, status);

-- A notified loss / claim against a contract (§28.1).
create table claim (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  reference       text,
  contract_id     uuid not null references contract(id),
  layer_id        uuid references contract_layer(id),
  risk_id         uuid references risk(id),
  cat_event_id    uuid references cat_event(id),
  description     text,
  loss_date       date,
  notified_date   date not null default current_date,
  currency        char(3) not null,
  -- denormalised current figures (kept consistent via reserve movements below)
  gross_loss_minor      bigint not null default 0,
  outstanding_minor     bigint not null default 0,   -- case reserve
  paid_minor            bigint not null default 0,
  recovered_minor       bigint not null default 0,
  -- state machine value (§28.4), validated against code list 'claim_status'
  status          citext not null default 'NOTIFIED',
  is_deleted      boolean not null default false,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on claim (tenant_id, status) where not is_deleted;
create index on claim (tenant_id, contract_id);
create index on claim (tenant_id, cat_event_id);

-- Now that claim exists, wire the deferred FK from financial_event (migration 0005).
alter table financial_event
  add constraint financial_event_claim_fk
  foreign key (claim_id) references claim(id) on delete set null;

-- Immutable reserve movement history (§9.7, §7.7 step 2). Reserves change only
-- through movements so the audit trail is complete and reproducible.
create table reserve_movement (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  claim_id      uuid not null references claim(id) on delete cascade,
  movement_type text not null check (movement_type in ('OPEN','INCREASE','DECREASE','PAYMENT','CLOSE')),
  -- signed delta to the outstanding reserve in minor units
  outstanding_delta_minor bigint not null default 0,
  paid_delta_minor        bigint not null default 0,
  currency      char(3) not null,
  reason        text,
  effective_date date not null default current_date,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);

create index on reserve_movement (tenant_id, claim_id);

-- Outwards / retro recoveries computed and collected (§7.7 step 6).
create table recovery (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  claim_id        uuid not null references claim(id) on delete cascade,
  -- the outwards contract the recovery is made under (retro / outwards reinsurance)
  recovery_contract_id uuid references contract(id),
  recovery_type   text not null default 'REINSURANCE'
                    check (recovery_type in ('REINSURANCE','SALVAGE','SUBROGATION')),
  amount_minor    bigint not null default 0,
  currency        char(3) not null,
  status          citext not null default 'EXPECTED',
  collected_date  date,
  created_at      timestamptz not null default now()
);

create index on recovery (tenant_id, claim_id);
