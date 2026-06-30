-- =============================================================================
-- RIOS - Migration 0023: Scheduler / job orchestration (brief §3)
-- Interval-scheduled jobs and their run history. Next-run / due decisions are
-- computed by @rios/domain (scheduler); these tables hold the schedule and the
-- audit of executions. A real deployment drives these from a worker; here a
-- "run now" endpoint records a run and advances the schedule.
-- =============================================================================

create table scheduled_job (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  key              citext not null,
  name             text not null,
  job_type         text not null,                 -- 'statement_sweep','retention_scan',...
  interval_minutes int not null check (interval_minutes >= 1),
  enabled          boolean not null default true,
  last_run_at      timestamptz,
  next_run_at      timestamptz,
  created_by       uuid references app_user(id),
  created_at       timestamptz not null default now(),
  unique (tenant_id, key)
);
create index on scheduled_job (tenant_id) where enabled;

create table job_run (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  job_id      uuid not null references scheduled_job(id) on delete cascade,
  status      text not null default 'success' check (status in ('success','failed','running')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  detail      text
);
create index on job_run (tenant_id, job_id, started_at desc);

do $$
declare t text;
begin
  foreach t in array array['scheduled_job','job_run'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
