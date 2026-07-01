-- 0047_scheduled_reports.sql
--
-- Scheduled Reports (brief §13.6 / reporting). Report scheduling on top of the
-- existing report_definition: named schedules with a cadence (daily … annual),
-- an output format (PDF / Excel / CSV), an optional distribution list of email
-- recipients, and a run history. The scheduler tick advances next_run_at and
-- records a report_schedule_run row per fire.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists distribution_list (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  description   text,
  recipients    text[] not null default '{}',   -- email addresses
  created_at    timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists distribution_list_idx on distribution_list (tenant_id);

create table if not exists report_schedule (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id) on delete cascade,
  definition_id        uuid references report_definition(id) on delete set null,
  name                 text not null,
  cadence              text not null default 'MONTHLY'
                       check (cadence in ('DAILY','WEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
  format               text not null default 'PDF'
                       check (format in ('PDF','EXCEL','CSV')),
  distribution_list_id uuid references distribution_list(id) on delete set null,
  enabled              boolean not null default true,
  config               jsonb not null default '{}'::jsonb,
  next_run_at          timestamptz,
  last_run_at          timestamptz,
  created_by           uuid references app_user(id) on delete set null,
  created_at           timestamptz not null default now()
);
create index if not exists report_schedule_idx on report_schedule (tenant_id, enabled, next_run_at);

create table if not exists report_schedule_run (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  schedule_id   uuid not null references report_schedule(id) on delete cascade,
  status        text not null default 'SUCCESS' check (status in ('SUCCESS','FAILED','SKIPPED')),
  format        text not null,
  row_count     int not null default 0,
  recipients    int not null default 0,
  note          text,
  generated_at  timestamptz not null default now()
);
create index if not exists report_schedule_run_idx on report_schedule_run (tenant_id, schedule_id, generated_at desc);

do $$
declare t text;
begin
  foreach t in array array['distribution_list','report_schedule','report_schedule_run']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
