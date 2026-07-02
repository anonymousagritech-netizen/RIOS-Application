-- 0056_account_current.sql
--
-- Account-current, dunning & disputed-items workflow, and ISO 20022 payment
-- runs with maker-checker release (industry-gap-analysis Tier-2 item 9).
-- disputed_item flags an AR invoice (or its whole statement) as contested,
-- which pauses dunning; dunning_notice records each escalation exactly once
-- per (item, level); payment_run / payment_run_item is the maker-checker
-- DRAFT → APPROVED → RELEASED pipeline whose release generates and stores the
-- pain.001.001.03 XML. Money is integer minor units. Additive + idempotent.
-- RLS enable-only (rios_app enforced; owner exempt).

create table if not exists disputed_item (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  invoice_id      uuid references ar_invoice(id) on delete cascade,
  statement_id    uuid references statement_of_account(id) on delete cascade,
  reason          text not null,
  status          text not null default 'OPEN' check (status in ('OPEN','RESOLVED','WRITTEN_OFF')),
  resolution_note text,
  raised_by       uuid references app_user(id) on delete set null,
  resolved_by     uuid references app_user(id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (invoice_id is not null or statement_id is not null)
);
create index if not exists disputed_item_idx on disputed_item (tenant_id, status);
create index if not exists disputed_item_invoice_idx on disputed_item (tenant_id, invoice_id);

create table if not exists dunning_notice (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  party_id    uuid references party(id) on delete set null,
  invoice_id  uuid references ar_invoice(id) on delete cascade,
  level       int not null check (level > 0),
  sent_at     timestamptz not null default now(),
  note        text
);
create index if not exists dunning_notice_idx on dunning_notice (tenant_id, party_id);
-- Idempotency: a given invoice is dunned at a given level at most once.
create unique index if not exists dunning_notice_once_idx
  on dunning_notice (tenant_id, invoice_id, level) where invoice_id is not null;

create table if not exists payment_run (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  reference   text not null,
  status      text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','RELEASED','CANCELLED')),
  currency    char(3) not null,
  total_minor bigint not null default 0,
  created_by  uuid references app_user(id) on delete set null,
  approved_by uuid references app_user(id) on delete set null,
  approved_at timestamptz,
  released_at timestamptz,
  xml         text,
  created_at  timestamptz not null default now()
);
create index if not exists payment_run_idx on payment_run (tenant_id, status);

create table if not exists payment_run_item (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  run_id        uuid not null references payment_run(id) on delete cascade,
  party_id      uuid references party(id) on delete set null,
  invoice_id    uuid references ap_invoice(id) on delete set null,
  amount_minor  bigint not null check (amount_minor > 0),
  currency      char(3) not null,
  creditor_name text not null,
  creditor_iban text not null,
  creditor_bic  text,
  remittance    text,
  created_at    timestamptz not null default now()
);
create index if not exists payment_run_item_idx on payment_run_item (tenant_id, run_id);

do $$
declare t text;
begin
  foreach t in array array['disputed_item','dunning_notice','payment_run','payment_run_item']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
