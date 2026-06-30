-- =============================================================================
-- RIOS — Migration 0005: Technical & financial accounting
-- Brief §7.6 (reconcilable chain), §9.8, §28.1 (Financial Event, Statement, Posting)
-- =============================================================================
-- The reconcilable chain: Financial Event (technical) -> Statement of Account
-- -> Ledger Posting (GL). Financial events are immutable facts; corrections are
-- new reversing events, never edits (§4.3, event-sourced spirit of §15.1).

-- Immutable technical-accounting events (§7.6, §28.1).
create table financial_event (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  contract_id     uuid not null references contract(id),
  layer_id        uuid references contract_layer(id),
  participation_id uuid references participation(id),
  claim_id        uuid,                      -- FK added in 0006 (claims) to avoid cycle
  -- event type from code list 'financial_event_type' (DEPOSIT_PREMIUM, CEDING_COMMISSION, …)
  event_type      citext not null,
  direction       char(2) not null check (direction in ('DR','CR')),  -- from cedent perspective
  amount_minor    bigint not null check (amount_minor >= 0),
  currency        char(3) not null,
  -- settlement currency view (original vs settlement, §7.6)
  settlement_ccy      char(3),
  settlement_rate     numeric(20,10),
  settlement_amount_minor bigint,
  booked_at       date not null default current_date,
  narrative       text,
  -- reversal linkage: a correcting event references the one it reverses
  reverses_event_id uuid references financial_event(id),
  statement_id    uuid,                      -- set when included in a statement
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now()
);

create index on financial_event (tenant_id, contract_id);
create index on financial_event (tenant_id, event_type);
create index on financial_event (tenant_id, statement_id);
-- partition-ready: large tenants partition by (tenant_id, booked_at range) — §16.2

-- Statement of account: periodic netting between two parties (§28.1, §28.5).
create table statement_of_account (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  reference       text,
  contract_id     uuid references contract(id),
  counterparty_id uuid references party(id),
  period_start    date,
  period_end      date,
  currency        char(3) not null,
  -- net balance in minor units; positive = owed by cedent to reinsurer
  balance_minor   bigint not null default 0,
  status          citext not null default 'OPEN',   -- code list statement_status (§28.5)
  issued_at       timestamptz,
  settled_at      timestamptz,
  created_by      uuid references app_user(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index on statement_of_account (tenant_id, status);
create index on statement_of_account (tenant_id, contract_id);

alter table financial_event
  add constraint financial_event_statement_fk
  foreign key (statement_id) references statement_of_account(id) on delete set null;

-- ---------------------------------------------------------------------------
-- General ledger (§9.8)
-- ---------------------------------------------------------------------------
create table gl_account (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  code        citext not null,
  name        text not null,
  type        text not null check (type in ('asset','liability','income','expense','equity')),
  is_control  boolean not null default false,
  parent_id   uuid references gl_account(id),
  is_active   boolean not null default true,
  unique (tenant_id, code)
);

-- A journal is a balanced set of postings derived from financial events (§7.6).
create table journal (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  reference     text,
  description   text,
  posted_at     date not null default current_date,
  currency      char(3) not null,
  status        text not null default 'posted' check (status in ('draft','posted','reversed')),
  source        text,                        -- 'technical_accounting','manual', etc.
  created_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);

create index on journal (tenant_id, posted_at);

create table ledger_posting (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  journal_id    uuid not null references journal(id) on delete cascade,
  gl_account_id uuid not null references gl_account(id),
  debit_minor   bigint not null default 0 check (debit_minor >= 0),
  credit_minor  bigint not null default 0 check (credit_minor >= 0),
  currency      char(3) not null,
  -- lineage back to the technical event(s) (§18.4)
  source_event_id uuid references financial_event(id),
  narrative     text,
  check (debit_minor = 0 or credit_minor = 0)   -- a leg is either a debit or a credit
);

create index on ledger_posting (tenant_id, journal_id);
create index on ledger_posting (tenant_id, gl_account_id);
create index on ledger_posting (tenant_id, source_event_id);
