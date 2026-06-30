-- 0032_attendance.sql
--
-- HRMS attendance: one row per user per working day. Tracks punch in/out and
-- accumulated break time so the app can show live working hours, today's
-- status, and weekly/monthly history. Keyed on the app_user (every signed-in
-- person can punch), tenant-isolated via RLS.
--
-- RLS is ENABLE (not FORCE): the rios_app application role is fully enforced;
-- the non-superuser owner stays exempt, consistent with migration 0031.

create table if not exists attendance_record (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  user_id       uuid not null references app_user(id) on delete cascade,
  work_date     date not null,
  punch_in_at   timestamptz,
  punch_out_at  timestamptz,
  break_open_at timestamptz,
  break_minutes integer not null default 0,
  status        text not null default 'present',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, user_id, work_date)
);
create index if not exists attendance_record_tenant_user_idx on attendance_record (tenant_id, user_id, work_date desc);
create index if not exists attendance_record_tenant_date_idx on attendance_record (tenant_id, work_date desc);

do $$
begin
  execute 'alter table attendance_record enable row level security';
  begin
    execute 'create policy tenant_isolation on attendance_record using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null;
  end;
end$$;

grant select, insert, update, delete on attendance_record to rios_app;
