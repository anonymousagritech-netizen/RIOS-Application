-- 0069_risk_capital_runs.sql
--
-- Risk & capital: persisted measurement runs + disclosure roll-forward store.
--
-- The measurement engines already live and are unit-tested in @rios/domain
-- (Solvency II Pillar 1 SCR/MCR/risk-margin/own-funds in solvency2.ts, the
-- standard-formula correlation matrices in solvencyCorrelations.ts, and the
-- IFRS 17 CSM roll-forward in ifrs17.ts). This migration adds the *persistence*
-- layer so a run's inputs and computed result are stored and auditable, plus a
-- disclosure roll-forward table (opening / movement / closing) that underpins
-- the reconciled disclosure views.
--
-- capital_run          one measurement run (SOLVENCY_II | IFRS17) with the
--                      headline figures pulled out for querying plus the full
--                      inputs/result as jsonb.
-- disclosure_rollforward  opening + movement = closing lines tied (optionally)
--                      to a run, for a framework/period.
--
-- No per-tenant seed here — reference/config data is seeded in db/seed/seed.sql
-- (migrations run before seed on a fresh install). Additive + idempotent. RLS
-- enable-only (rios_app enforced via tenant_isolation; owner exempt). Money is
-- integer minor units.

create table if not exists capital_run (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  as_of             date not null default current_date,
  framework         text not null check (framework in ('SOLVENCY_II','IFRS17')),
  scr_minor         bigint,
  mcr_minor         bigint,
  risk_margin_minor bigint,
  own_funds_minor   bigint,
  ratio             numeric,
  inputs            jsonb not null default '{}'::jsonb,
  result            jsonb not null default '{}'::jsonb,
  created_by        uuid references app_user(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists capital_run_idx on capital_run (tenant_id, framework, as_of desc);

create table if not exists disclosure_rollforward (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  run_id         uuid references capital_run(id) on delete cascade,
  framework      text not null,
  line_item      text not null,
  opening_minor  bigint not null default 0,
  movement_minor bigint not null default 0,
  closing_minor  bigint not null default 0,
  currency       char(3) not null default 'USD',
  period         text,
  created_at     timestamptz not null default now()
);
create index if not exists disclosure_rollforward_idx on disclosure_rollforward (tenant_id, run_id);

do $$
declare t text;
begin
  foreach t in array array['capital_run','disclosure_rollforward']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
