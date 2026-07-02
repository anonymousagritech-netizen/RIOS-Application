-- 0058_multi_gaap.sql
--
-- Multi-GAAP parallel ledgers (industry-gap-analysis §Tier-3 item 11). The same
-- economic events reported under multiple accounting bases (LOCAL_GAAP, IFRS17,
-- US_GAAP, …) using the standard "parallel ledger = core + adjustment layer"
-- model: the primary GL (journal/ledger_posting) stays the single source of
-- booked postings, and each parallel ledger carries only basis-adjustment
-- journals on top of it. The existing single-ledger tables are NOT touched -
-- basis adjustments live in their own header/lines tables that mirror the
-- journal/ledger_posting shape, so every existing GL query (trial balance,
-- P&L, balance sheet, reconciliation) keeps reading exactly the rows it read
-- before. Ledgers are tenant configuration created via the API - nothing is
-- seeded. Money is integer minor units. Additive + idempotent. RLS enable-only
-- (rios_app enforced; owner exempt).

-- A parallel ledger / accounting basis. is_primary marks the (at most one)
-- ledger that represents the core GL itself; parallel ledgers are non-primary.
create table if not exists gl_ledger (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  code        text not null,                 -- e.g. PRIMARY / IFRS17 / LOCAL_GAAP / US_GAAP
  name        text not null,
  basis       text not null,                 -- accounting basis label (free config, not an enum)
  currency    char(3),                       -- optional presentation currency
  is_primary  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references app_user(id) on delete set null,
  unique (tenant_id, code)
);
create index if not exists gl_ledger_idx on gl_ledger (tenant_id, code);
-- At most one primary ledger per tenant (the API also returns 409).
create unique index if not exists gl_ledger_one_primary_idx
  on gl_ledger (tenant_id) where is_primary;

-- Basis-adjustment journal header: mirrors the journal table's shape
-- (posted_at/currency/status/source) but is scoped to one parallel ledger.
create table if not exists gl_basis_adjustment (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  ledger_id   uuid not null references gl_ledger(id) on delete cascade,
  reference   text,
  description text,
  posted_at   date not null default current_date,
  currency    char(3) not null,
  status      text not null default 'posted' check (status in ('draft','posted','reversed')),
  source      text,                          -- 'basis_adjustment', etc.
  created_at  timestamptz not null default now(),
  created_by  uuid references app_user(id) on delete set null
);
create index if not exists gl_basis_adjustment_idx on gl_basis_adjustment (tenant_id, ledger_id, posted_at);

-- Basis-adjustment lines: mirror ledger_posting's shape and balance rules
-- (a leg is either a debit or a credit; both non-negative).
create table if not exists gl_basis_adjustment_line (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  adjustment_id  uuid not null references gl_basis_adjustment(id) on delete cascade,
  gl_account_id  uuid not null references gl_account(id),
  debit_minor    bigint not null default 0 check (debit_minor >= 0),
  credit_minor   bigint not null default 0 check (credit_minor >= 0),
  currency       char(3) not null,
  narrative      text,
  check (debit_minor = 0 or credit_minor = 0)
);
create index if not exists gl_basis_adjustment_line_adj_idx on gl_basis_adjustment_line (tenant_id, adjustment_id);
create index if not exists gl_basis_adjustment_line_acct_idx on gl_basis_adjustment_line (tenant_id, gl_account_id);

do $$
declare t text;
begin
  foreach t in array array['gl_ledger','gl_basis_adjustment','gl_basis_adjustment_line']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
