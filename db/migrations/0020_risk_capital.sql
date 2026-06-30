-- =============================================================================
-- RIOS — Migration 0020: Risk & capital management + RDS (brief §13)
-- The capital position (own funds vs SCR/MCR) and a library of Realistic
-- Disaster Scenarios with prescribed gross losses and assumed recoveries. The
-- metrics (solvency ratio, net loss, post-event ratio, VaR/TVaR) are computed
-- by @rios/domain; these tables hold the persisted inputs. Money in minor units.
-- =============================================================================

-- A point-in-time capital position.
create table capital_position (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  as_of_date      date not null default current_date,
  currency        char(3) not null default 'USD',
  own_funds_minor bigint not null default 0,
  scr_minor       bigint not null default 0,     -- Solvency Capital Requirement
  mcr_minor       bigint not null default 0,     -- Minimum Capital Requirement
  note            text,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  unique (tenant_id, as_of_date)
);
create index on capital_position (tenant_id, as_of_date desc);

-- A Realistic Disaster Scenario (a prescribed deterministic event).
create table rds_scenario (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id) on delete cascade,
  code                  citext not null,
  name                  text not null,
  peril                 text,
  region                text,
  currency              char(3) not null default 'USD',
  gross_loss_minor      bigint not null default 0,
  assumed_recovery_minor bigint not null default 0,  -- modelled reinsurance/retro recovery
  status                text not null default 'ACTIVE' check (status in ('ACTIVE','RETIRED')),
  created_by            uuid references app_user(id),
  created_at            timestamptz not null default now(),
  unique (tenant_id, code)
);
create index on rds_scenario (tenant_id) where status = 'ACTIVE';

do $$
declare t text;
begin
  foreach t in array array['capital_position','rds_scenario'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
