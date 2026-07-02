-- 0066_period_close.sql
--
-- Governed period-close orchestration (workbook gap: "auto-invoking the UPR run
-- from the close and full close orchestration are follow-ons"). A period_close is
-- opened for an accounting period (e.g. '2026-Q1') with a fixed checklist of
-- period_close_step rows seeded PENDING. Each step is RUN by calling the existing
-- engine (the UPR/DAC run, the SOA verifier, the FX revaluation, the trial-balance
-- tie-out) - the close orchestrates, it never re-implements the maths. When every
-- non-SKIPPED step is DONE the close may be LOCKED; a LOCKED close may be REOPENED
-- with an audited reason. Additive + idempotent. RLS enable-only (rios_app
-- enforced; owner exempt), matching the 0055 pattern.

create table if not exists period_close (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  period        text not null,
  period_start  date not null,
  period_end    date not null,
  status        text not null default 'OPEN'
                  check (status in ('OPEN','IN_PROGRESS','LOCKED','REOPENED')),
  created_by    uuid references app_user(id) on delete set null,
  locked_by     uuid references app_user(id) on delete set null,
  locked_at     timestamptz,
  reopen_reason text,
  created_at    timestamptz not null default now()
);
create index if not exists period_close_idx on period_close (tenant_id, period_start desc, period);

create table if not exists period_close_step (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  close_id   uuid not null references period_close(id) on delete cascade,
  step_key   text not null,
  status     text not null default 'PENDING'
               check (status in ('PENDING','RUNNING','DONE','FAILED','SKIPPED')),
  detail     jsonb,
  ran_at     timestamptz,
  sequence   int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists period_close_step_uniq on period_close_step (close_id, step_key);
create index if not exists period_close_step_idx on period_close_step (tenant_id, close_id, sequence);

do $$
declare t text;
begin
  foreach t in array array['period_close','period_close_step']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
