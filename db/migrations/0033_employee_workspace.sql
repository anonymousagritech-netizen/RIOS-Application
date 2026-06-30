-- 0033_employee_workspace.sql
--
-- Backs the employee self-service dashboard widgets: company holidays,
-- announcements, and birthdays (a date_of_birth on employee). All tenant
-- scoped with RLS enable-only (rios_app enforced; non-superuser owner exempt,
-- consistent with migration 0031).

alter table employee add column if not exists date_of_birth date;

create table if not exists company_holiday (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  holiday_date date not null,
  name         text not null,
  region       text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, holiday_date, name)
);
create index if not exists company_holiday_tenant_date_idx on company_holiday (tenant_id, holiday_date);

create table if not exists announcement (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  title      text not null,
  body       text not null,
  category   text not null default 'general',
  posted_by  uuid references app_user(id) on delete set null,
  posted_at  timestamptz not null default now()
);
create index if not exists announcement_tenant_posted_idx on announcement (tenant_id, posted_at desc);

do $$
begin
  execute 'alter table company_holiday enable row level security';
  begin execute 'create policy tenant_isolation on company_holiday using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
  execute 'alter table announcement enable row level security';
  begin execute 'create policy tenant_isolation on announcement using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on company_holiday to rios_app;
grant select, insert, update, delete on announcement to rios_app;
