-- 0054_upr_dac.sql
--
-- UPR/DAC accrual runs (industry-gap-analysis §2.2 item 6). A run values every
-- in-force contract's Unearned Premium Reserve and Deferred Acquisition Cost as
-- of a date, using the earning patterns in @rios/domain (PRO_RATA / EIGHTHS /
-- TWENTY_FOURTHS / RISK_ATTACHING). One header row per run plus one line per
-- contract; earned + UPR always equals written to the minor unit. The run-level
-- total_* columns are the raw sums over all lines - meaningful per currency
-- (the API reports per-currency subtotals; cross-currency aggregation goes
-- through FX). Money is integer minor units. Additive + idempotent. RLS
-- enable-only (rios_app enforced; owner exempt).

create table if not exists upr_run (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenant(id) on delete cascade,
  as_of                    date not null,
  status                   text not null default 'COMPLETED',
  line_count               int not null default 0,
  total_written_minor      bigint not null default 0,
  total_earned_minor       bigint not null default 0,
  total_upr_minor          bigint not null default 0,
  total_acquisition_minor  bigint not null default 0,
  total_dac_minor          bigint not null default 0,
  created_by               uuid references app_user(id) on delete set null,
  created_at               timestamptz not null default now()
);
create index if not exists upr_run_idx on upr_run (tenant_id, as_of desc);

create table if not exists upr_line (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenant(id) on delete cascade,
  run_id                  uuid not null references upr_run(id) on delete cascade,
  contract_id             uuid not null references contract(id) on delete cascade,
  pattern                 text not null,
  currency                char(3) not null,
  written_premium_minor   bigint not null,
  earned_minor            bigint not null,
  upr_minor               bigint not null,
  acquisition_cost_minor  bigint not null default 0,
  dac_minor               bigint not null default 0
);
create index if not exists upr_line_idx on upr_line (tenant_id, run_id);
create index if not exists upr_line_contract_idx on upr_line (tenant_id, contract_id);

do $$
declare t text;
begin
  foreach t in array array['upr_run','upr_line']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
