-- 0036_employee_profile.sql
--
-- HR-managed employee profile depth: personal & statutory identity details
-- (govt IDs, alternate contacts, blood group, gender, insurance) plus a
-- dependents/family table. Sensitive fields (PAN/Aadhaar/national IDs) are
-- stored here and masked by the field-security layer for non-PII roles.
-- RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

alter table employee add column if not exists gender          text;
alter table employee add column if not exists date_of_birth   date;
alter table employee add column if not exists blood_group     text;
alter table employee add column if not exists marital_status  text;
alter table employee add column if not exists nationality     text;
alter table employee add column if not exists personal_email  citext;
alter table employee add column if not exists phone           text;
alter table employee add column if not exists alt_phone       text;
alter table employee add column if not exists address         text;
-- Government / statutory identifiers (PII).
alter table employee add column if not exists pan             text;
alter table employee add column if not exists aadhaar         text;
alter table employee add column if not exists national_id     text;
alter table employee add column if not exists passport_no     text;
-- Insurance.
alter table employee add column if not exists insurance_provider text;
alter table employee add column if not exists insurance_number   text;

-- Family / dependents (emergency contacts live here too, flagged is_emergency).
create table if not exists employee_dependent (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  employee_id  uuid not null references employee(id) on delete cascade,
  name         text not null,
  relationship text not null,
  date_of_birth date,
  phone        text,
  is_emergency boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists employee_dependent_idx on employee_dependent (tenant_id, employee_id);

do $$
begin
  execute 'alter table employee_dependent enable row level security';
  begin execute 'create policy tenant_isolation on employee_dependent using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on employee_dependent to rios_app;
