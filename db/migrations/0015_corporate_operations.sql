-- =============================================================================
-- RIOS - Migration 0015: Corporate back-office & Operations/Observability
-- Brief §9.14 (Procurement, HRMS, Payroll, Assets), §9.13 (observability/SLA),
-- §9.1 (entitlement engine)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- HRMS (§9.14)
-- ---------------------------------------------------------------------------
create table department (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          citext not null,
  name          text not null,
  parent_id     uuid references department(id) on delete set null,
  cost_centre   text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);
create index on department (tenant_id);

create table employee (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  employee_no   citext not null,
  first_name    text not null,
  last_name     text not null,
  email         citext,
  department_id uuid references department(id) on delete set null,
  position      text,
  manager_id    uuid references employee(id) on delete set null,
  user_id       uuid references app_user(id) on delete set null,
  hire_date     date,
  -- monthly base salary in minor units (feeds Payroll, designed-for)
  base_salary_minor bigint,
  currency      char(3),
  status        text not null default 'active' check (status in ('active','on_leave','terminated')),
  is_deleted    boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (tenant_id, employee_no)
);
create index on employee (tenant_id, department_id) where not is_deleted;

create table leave_request (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  employee_id   uuid not null references employee(id) on delete cascade,
  kind          text not null default 'annual' check (kind in ('annual','sick','unpaid','parental','other')),
  start_date    date not null,
  end_date      date not null,
  days          numeric(5,1) not null default 0,
  reason        text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  decided_by    uuid references app_user(id),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index on leave_request (tenant_id, employee_id);
create index on leave_request (tenant_id, status) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Procurement (§9.14)
-- ---------------------------------------------------------------------------
create table vendor (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  -- a vendor may also be a Party (party-centric §7); link optional
  party_id      uuid references party(id) on delete set null,
  code          citext not null,
  name          text not null,
  category      text,
  email         text,
  status        text not null default 'active' check (status in ('active','inactive','blocked')),
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);
create index on vendor (tenant_id);

create table purchase_requisition (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  reference     text,
  department_id uuid references department(id),
  requested_by  uuid references app_user(id),
  description   text,
  currency      char(3) not null default 'USD',
  total_minor   bigint not null default 0,
  status        text not null default 'draft' check (status in ('draft','submitted','approved','rejected','ordered')),
  created_at    timestamptz not null default now()
);
create index on purchase_requisition (tenant_id, status);

create table purchase_order (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  reference     text,
  vendor_id     uuid references vendor(id),
  requisition_id uuid references purchase_requisition(id) on delete set null,
  currency      char(3) not null default 'USD',
  total_minor   bigint not null default 0,
  order_date    date not null default current_date,
  status        text not null default 'draft' check (status in ('draft','issued','received','closed','cancelled')),
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on purchase_order (tenant_id, status);
create index on purchase_order (tenant_id, vendor_id);

create table purchase_order_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  po_id         uuid not null references purchase_order(id) on delete cascade,
  line_no       int not null,
  description   text not null,
  quantity      numeric(14,3) not null default 1,
  unit_price_minor bigint not null default 0,
  line_total_minor bigint not null default 0,
  currency      char(3) not null default 'USD',
  unique (po_id, line_no)
);
create index on purchase_order_line (tenant_id, po_id);

-- ---------------------------------------------------------------------------
-- Asset & License inventory (§9.14) + per-tenant entitlements (§9.1)
-- ---------------------------------------------------------------------------
create table asset (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  tag           citext not null,
  name          text not null,
  category      text,
  assigned_to   uuid references employee(id) on delete set null,
  purchase_date date,
  value_minor   bigint,
  currency      char(3),
  status        text not null default 'in_use' check (status in ('in_use','in_store','retired','lost')),
  created_at    timestamptz not null default now(),
  unique (tenant_id, tag)
);
create index on asset (tenant_id, status);

create table software_license (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  vendor        text,
  seats_total   int not null default 0,
  seats_used    int not null default 0,
  expiry_date   date,
  cost_minor    bigint,
  currency      char(3),
  status        text not null default 'active' check (status in ('active','expired','cancelled')),
  created_at    timestamptz not null default now()
);
create index on software_license (tenant_id, status);

-- Per-tenant feature entitlements / plan limits (the entitlement engine, §9.1, §10.3).
create table feature_entitlement (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  feature_key   citext not null,
  is_enabled    boolean not null default true,
  plan          text,
  limit_value   bigint,                          -- null = unlimited
  created_at    timestamptz not null default now(),
  unique (tenant_id, feature_key)
);
create index on feature_entitlement (tenant_id);

-- ---------------------------------------------------------------------------
-- Operations / Observability (§9.13) - SLA targets; the module also reads the
-- existing audit_log and outbox tables for the audit viewer & event monitor.
-- ---------------------------------------------------------------------------
create table sla_target (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  service       text not null,
  metric        text not null,                   -- 'availability','p95_latency_ms','rto_minutes', etc.
  target_value  numeric(14,4) not null,
  unit          text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, service, metric)
);
create index on sla_target (tenant_id);

do $$
declare t text;
begin
  foreach t in array array[
    'department','employee','leave_request',
    'vendor','purchase_requisition','purchase_order','purchase_order_line',
    'asset','software_license','feature_entitlement','sla_target'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
