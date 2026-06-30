-- =============================================================================
-- RIOS — Migration 0016: Module depth (treaty adjustments, claims, accounting,
-- payroll) and regulatory completeness (IFRS 17 GMM/VFA, returns)
-- Brief §7.2, §7.6, §7.7, §9.8, §9.14, §18
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Treaty depth: profit-commission runs, portfolio transfers, endorsements
-- ---------------------------------------------------------------------------
create table pc_run (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid not null references contract(id) on delete cascade,
  period        text,
  ceded_premium_minor    bigint not null default 0,
  commission_paid_minor  bigint not null default 0,
  incurred_losses_minor  bigint not null default 0,
  allowable_expenses_pct numeric(6,3) not null default 0,
  rate_pct               numeric(6,3) not null default 0,
  loss_brought_forward_minor bigint not null default 0,
  profit_minor           bigint not null default 0,
  profit_commission_minor bigint not null default 0,
  loss_carried_forward_minor bigint not null default 0,
  currency      char(3) not null,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on pc_run (tenant_id, contract_id);

create table portfolio_transfer (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid not null references contract(id) on delete cascade,
  direction     text not null check (direction in ('entry','withdrawal')),
  unearned_premium_minor bigint not null default 0,
  outstanding_losses_minor bigint not null default 0,
  premium_pct   numeric(6,3) not null default 0,
  loss_pct      numeric(6,3) not null default 0,
  premium_transfer_minor bigint not null default 0,
  loss_transfer_minor    bigint not null default 0,
  net_transfer_minor     bigint not null default 0,
  currency      char(3) not null,
  effective_date date not null default current_date,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on portfolio_transfer (tenant_id, contract_id);

create table contract_endorsement (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid not null references contract(id) on delete cascade,
  endorsement_no int not null,
  effective_date date not null default current_date,
  description   text,
  changes       jsonb not null default '{}'::jsonb,
  term_set_version int,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now(),
  unique (contract_id, endorsement_no)
);
create index on contract_endorsement (tenant_id, contract_id);

-- ---------------------------------------------------------------------------
-- Claims depth: cash calls (reinstatement premium reuses financial_event)
-- ---------------------------------------------------------------------------
create table cash_call (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  claim_id      uuid not null references claim(id) on delete cascade,
  contract_id   uuid references contract(id),
  amount_minor  bigint not null default 0,
  currency      char(3) not null,
  status        text not null default 'requested' check (status in ('requested','paid','rejected')),
  requested_date date not null default current_date,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on cash_call (tenant_id, claim_id);

-- ---------------------------------------------------------------------------
-- Accounting depth: periods (close) & FX revaluation
-- ---------------------------------------------------------------------------
create table accounting_period (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  code          citext not null,                 -- '2026-Q1'
  start_date    date not null,
  end_date      date not null,
  status        text not null default 'open' check (status in ('open','closed','reopened')),
  closed_by     uuid references app_user(id),
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);
create index on accounting_period (tenant_id, status);

create table fx_revaluation (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  as_at         date not null default current_date,
  base_currency char(3) not null,
  gain_loss_minor bigint not null default 0,
  detail        jsonb not null default '[]'::jsonb,   -- per-currency working
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on fx_revaluation (tenant_id, as_at);

-- ---------------------------------------------------------------------------
-- Payroll (§9.14)
-- ---------------------------------------------------------------------------
create table payroll_run (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  period        text not null,                   -- '2026-06'
  pay_date      date not null default current_date,
  currency      char(3) not null,
  status        text not null default 'draft' check (status in ('draft','approved','paid')),
  total_gross_minor bigint not null default 0,
  total_net_minor   bigint not null default 0,
  total_tax_minor   bigint not null default 0,
  total_employer_cost_minor bigint not null default 0,
  headcount     int not null default 0,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on payroll_run (tenant_id, period);

create table payslip (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  payroll_run_id uuid not null references payroll_run(id) on delete cascade,
  employee_id   uuid not null references employee(id),
  gross_minor   bigint not null default 0,
  taxable_minor bigint not null default 0,
  income_tax_minor bigint not null default 0,
  employee_social_minor bigint not null default 0,
  net_minor     bigint not null default 0,
  employer_cost_minor bigint not null default 0,
  currency      char(3) not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index on payslip (tenant_id, payroll_run_id);

-- ---------------------------------------------------------------------------
-- Regulatory completeness: returns/QRT/Schedule F as governed packs (§18)
-- ---------------------------------------------------------------------------
create table regulatory_return (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  kind          text not null,                   -- 'IFRS17_DISCLOSURE','SOLVENCY2_QRT','SCHEDULE_F','LLOYDS_RETURN'
  period        text,
  reference     text,
  status        text not null default 'draft' check (status in ('draft','prepared','approved','submitted')),
  data          jsonb not null default '{}'::jsonb,
  created_by    uuid references app_user(id),
  approved_by   uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on regulatory_return (tenant_id, kind);

-- Extend IFRS 17 measurement to carry GMM/VFA figures (CSM, fulfilment CF, RA).
alter table ifrs17_measurement
  add column if not exists csm_minor bigint not null default 0,
  add column if not exists fulfilment_cf_minor bigint not null default 0,
  add column if not exists risk_adjustment_minor bigint not null default 0;

do $$
declare t text;
begin
  foreach t in array array[
    'pc_run','portfolio_transfer','contract_endorsement','cash_call',
    'accounting_period','fx_revaluation','payroll_run','payslip','regulatory_return'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
