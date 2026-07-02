-- 0052_counterparty_security.sql
--
-- Counterparty security management + sanctions screening (industry-gap-analysis
-- §2.2 items 2-3). Security ratings per agency, credit limits with consumption,
-- collateral (LOC / funds withheld / trust / cash), and a sanctions screening
-- log. sanctions_list_entry is a tenant-loaded denylist: in production a real
-- provider feed (OFAC SDN, UN consolidated, EU CFSP, Dow Jones, World-Check…)
-- would populate it; RIOS ships the matcher and the audit trail, not the feed.
-- Money is integer minor units. Additive + idempotent. RLS enable-only
-- (rios_app enforced; owner exempt).

create table if not exists security_rating (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  party_id    uuid not null references party(id) on delete cascade,
  agency      text not null check (agency in ('SP','AM_BEST','MOODYS','FITCH','INTERNAL')),
  rating      text not null,
  outlook     text,
  rated_on    date not null default current_date,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references app_user(id) on delete set null
);
create index if not exists security_rating_idx on security_rating (tenant_id, party_id, rated_on desc);

create table if not exists credit_limit (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  party_id       uuid not null references party(id) on delete cascade,
  currency       char(3) not null,
  limit_minor    bigint not null,
  consumed_minor bigint not null default 0,
  status         text not null default 'ACTIVE',
  review_date    date,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user(id) on delete set null,
  unique (tenant_id, party_id, currency)
);

create table if not exists collateral (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  party_id     uuid not null references party(id) on delete cascade,
  kind         text not null check (kind in ('LOC','FUNDS_WITHHELD','TRUST','CASH')),
  reference    text,
  amount_minor bigint not null,
  currency     char(3) not null,
  expiry_date  date,
  status       text not null default 'ACTIVE',
  created_at   timestamptz not null default now(),
  created_by   uuid references app_user(id) on delete set null
);
create index if not exists collateral_idx on collateral (tenant_id, party_id);

create table if not exists sanctions_screening (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  party_id      uuid references party(id) on delete set null,
  payment_ref   text,
  screened_name text not null,
  result        text not null check (result in ('CLEAR','POTENTIAL_MATCH','BLOCKED')),
  matches       jsonb not null default '[]'::jsonb,
  screened_at   timestamptz not null default now(),
  screened_by   uuid references app_user(id) on delete set null
);
create index if not exists sanctions_screening_idx on sanctions_screening (tenant_id, party_id);

create table if not exists sanctions_list_entry (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  list_source text not null,               -- OFAC / UN / EU / LOCAL
  full_name   text not null,
  alias       text,
  country     char(2),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists sanctions_list_entry_idx on sanctions_list_entry (tenant_id);

do $$
declare t text;
begin
  foreach t in array array['security_rating','credit_limit','collateral','sanctions_screening','sanctions_list_entry']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
