-- 0035_hr_depth.sql
--
-- HR / Attendance depth: employment type, an audited employee status lifecycle,
-- attendance day status (OD / WFH / regularized) with the original system value
-- preserved, and an approval-routed attendance request (regularization / OD /
-- WFH). RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

-- Employment type + widened status lifecycle.
alter table employee add column if not exists employment_type text not null default 'full_time';
do $$ begin
  alter table employee drop constraint if exists employee_status_check;
  alter table employee add constraint employee_status_check
    check (status in ('active','on_leave','suspended','exited','terminated'));
exception when others then null; end $$;

-- Audited status-change history (§4.3 - never silently overwritten).
create table if not exists employee_status_history (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  employee_id uuid not null references employee(id) on delete cascade,
  from_status text,
  to_status   text not null,
  reason      text,
  changed_by  uuid references app_user(id) on delete set null,
  changed_at  timestamptz not null default now()
);
create index if not exists emp_status_hist_idx on employee_status_history (tenant_id, employee_id, changed_at desc);

-- Attendance day status now carries OD/WFH/regularized; keep the original
-- system-captured punches when a day is regularized.
alter table attendance_record add column if not exists day_source text not null default 'office';
alter table attendance_record add column if not exists original_punch_in_at  timestamptz;
alter table attendance_record add column if not exists original_punch_out_at timestamptz;
alter table attendance_record add column if not exists regularized boolean not null default false;

-- Approval-routed attendance requests. The approver is resolved from the
-- employee's manager chain by the application, reusing the org hierarchy.
create table if not exists attendance_request (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  employee_id   uuid not null references employee(id) on delete cascade,
  user_id       uuid not null references app_user(id) on delete cascade,
  request_date  date not null,
  kind          text not null check (kind in ('regularization','od','wfh')),
  reason        text,
  requested_punch_in_at  timestamptz,
  requested_punch_out_at timestamptz,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approver_user_id uuid references app_user(id) on delete set null,
  decided_by    uuid references app_user(id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists attendance_request_tenant_idx on attendance_request (tenant_id, request_date desc);
create index if not exists attendance_request_approver_idx on attendance_request (tenant_id, approver_user_id, status);

do $$
begin
  execute 'alter table employee_status_history enable row level security';
  begin execute 'create policy tenant_isolation on employee_status_history using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
  execute 'alter table attendance_request enable row level security';
  begin execute 'create policy tenant_isolation on attendance_request using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on employee_status_history to rios_app;
grant select, insert, update, delete on attendance_request to rios_app;
