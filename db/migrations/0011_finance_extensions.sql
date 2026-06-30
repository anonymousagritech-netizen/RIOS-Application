-- =============================================================================
-- RIOS - Migration 0011: AR / AP / Cash / Bank (financial accounting breadth)
-- Brief §9.8 - sub-ledgers feeding the GL, reconcilable to technical accounting
-- =============================================================================

-- Accounts receivable / payable invoices derived from statements of account.
create table ar_invoice (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  reference     text,
  party_id      uuid references party(id),
  statement_id  uuid references statement_of_account(id) on delete set null,
  currency      char(3) not null,
  amount_minor  bigint not null default 0,
  settled_minor bigint not null default 0,
  due_date      date,
  status        citext not null default 'OPEN',  -- OPEN/PART_PAID/SETTLED/OVERDUE
  created_at    timestamptz not null default now()
);
create index on ar_invoice (tenant_id, status);
create index on ar_invoice (tenant_id, party_id);

create table ap_invoice (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  reference     text,
  party_id      uuid references party(id),
  statement_id  uuid references statement_of_account(id) on delete set null,
  currency      char(3) not null,
  amount_minor  bigint not null default 0,
  settled_minor bigint not null default 0,
  due_date      date,
  status        citext not null default 'OPEN',
  created_at    timestamptz not null default now()
);
create index on ap_invoice (tenant_id, status);
create index on ap_invoice (tenant_id, party_id);

create table bank_account (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  currency      char(3) not null,
  gl_account_id uuid references gl_account(id),
  iban          text,
  balance_minor bigint not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index on bank_account (tenant_id);

-- Cash transactions and their allocation to AR/AP invoices (settlement & recon).
create table cash_transaction (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  bank_account_id uuid references bank_account(id),
  direction     char(2) not null check (direction in ('IN','OU')),  -- received / paid
  amount_minor  bigint not null check (amount_minor >= 0),
  currency      char(3) not null,
  value_date    date not null default current_date,
  counterparty_id uuid references party(id),
  ar_invoice_id uuid references ar_invoice(id) on delete set null,
  ap_invoice_id uuid references ap_invoice(id) on delete set null,
  is_reconciled boolean not null default false,
  narrative     text,
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create index on cash_transaction (tenant_id, bank_account_id);
create index on cash_transaction (tenant_id, is_reconciled) where not is_reconciled;

do $$
declare t text;
begin
  foreach t in array array['ar_invoice','ap_invoice','bank_account','cash_transaction'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
