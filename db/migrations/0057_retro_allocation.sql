-- 0057_retro_allocation.sql
--
-- Retro cession allocation engine (industry-gap-analysis Tier-2 #10, brief
-- §7.5, §29.3). Rules automatically allocate every inward premium/claim
-- financial event to the outward retrocession program: a rule targets one
-- OUTWARDS (retro) contract, applies to PREMIUM/CLAIM/BOTH, optionally filters
-- by LOB / currency / event-date window, and cedes a quota-share percentage of
-- the gross. Each executed allocation links the inward source financial_event
-- to the ceded financial_event booked on the retro contract, so the ceded money
-- stays on the same reconcilable technical chain (§7.6). The UNIQUE
-- (tenant_id, rule_id, source_event_id) makes allocation runs idempotent:
-- re-runs can never double-allocate. Money is integer minor units. Additive +
-- idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists retro_allocation_rule (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  retro_contract_id uuid not null references contract(id) on delete cascade,
  name              text not null,
  applies_to        text not null check (applies_to in ('PREMIUM','CLAIM','BOTH')),
  lob               citext,                      -- null = any line of business
  currency          char(3),                     -- null = any currency
  period_start      date,                        -- null = open-ended window
  period_end        date,
  method            text not null default 'QUOTA_SHARE' check (method in ('QUOTA_SHARE')),
  cession_pct       numeric(7,4) not null check (cession_pct > 0 and cession_pct <= 100),
  priority          int not null default 100,
  active            boolean not null default true,
  created_by        uuid references app_user(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists retro_allocation_rule_idx on retro_allocation_rule (tenant_id, active, priority);
create index if not exists retro_allocation_rule_contract_idx on retro_allocation_rule (tenant_id, retro_contract_id);

create table if not exists retro_allocation (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  rule_id           uuid not null references retro_allocation_rule(id) on delete cascade,
  source_event_id   uuid not null references financial_event(id) on delete cascade,
  retro_contract_id uuid not null references contract(id) on delete cascade,
  -- null when the computed cession rounded to zero minor units (recorded so the
  -- pair is still never re-attempted).
  ceded_event_id    uuid references financial_event(id) on delete set null,
  amount_minor      bigint not null check (amount_minor >= 0),
  currency          char(3) not null,
  created_at        timestamptz not null default now(),
  unique (tenant_id, rule_id, source_event_id)   -- re-runs never double-allocate
);
create index if not exists retro_allocation_source_idx on retro_allocation (tenant_id, source_event_id);
create index if not exists retro_allocation_contract_idx on retro_allocation (tenant_id, retro_contract_id);

do $$
declare t text;
begin
  foreach t in array array['retro_allocation_rule','retro_allocation']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
