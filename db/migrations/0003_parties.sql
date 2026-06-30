-- =============================================================================
-- RIOS - Migration 0003: Party & role-centric model
-- Brief §7 design implication, §16.1: a legal entity can simultaneously be
-- cedent, reinsurer, retrocessionaire, broker, coverholder. Model roles, not
-- "customer vs vendor".
-- =============================================================================

create table party (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  -- human reference, from a numbering scheme (§10)
  reference     text,
  legal_name    text not null,
  short_name    text,
  kind          text not null default 'organisation'
                  check (kind in ('organisation','individual','syndicate','pool','captive')),
  country       char(2),
  -- regulatory identifiers (LEI, NAIC, Lloyd's syndicate number, tax ids)
  identifiers   jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active','inactive','prospect','archived')),
  is_deleted    boolean not null default false,    -- soft delete (§16.2)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index on party (tenant_id) where not is_deleted;
create index on party (tenant_id, legal_name);

-- A party plays one or more roles. The role vocabulary comes from a code list
-- so tenants can extend it (§10).
create table party_role (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  party_id    uuid not null references party(id) on delete cascade,
  role_code   citext not null,   -- 'cedent','reinsurer','retrocessionaire','broker','coverholder','claimant_payee'
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (party_id, role_code)
);

create index on party_role (tenant_id, role_code) where is_active;

-- Contacts & addresses (kept lean; extendable)
create table party_contact (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  party_id    uuid not null references party(id) on delete cascade,
  kind        text not null default 'email' check (kind in ('email','phone','address','portal_user')),
  value       text not null,
  label       text,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);

create index on party_contact (tenant_id, party_id);

-- Financial setup for settlement (bank, default settlement currency, payment terms)
create table party_financial (
  party_id          uuid primary key references party(id) on delete cascade,
  tenant_id         uuid not null references tenant(id) on delete cascade,
  settlement_ccy    char(3),
  payment_terms_days int not null default 30,
  bank_details      jsonb not null default '{}'::jsonb
);
