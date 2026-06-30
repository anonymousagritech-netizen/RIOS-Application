-- =============================================================================
-- RIOS — Migration 0030: WebAuthn credentials & API marketplace (brief §14.1, §26)
-- WebAuthn (passkey) credential storage to complete the auth surface, and an
-- app/API marketplace catalog + per-tenant install state. AI Automation Studio
-- and the Assistant evaluation suite reuse config_document / the assistant, so
-- they need no tables here.
-- =============================================================================

-- A registered WebAuthn (passkey) credential for a user.
create table webauthn_credential (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  user_id       uuid not null references app_user(id) on delete cascade,
  credential_id text not null,                 -- base64url credential id from the authenticator
  public_key    text not null,                 -- base64url COSE public key
  sign_count    bigint not null default 0,
  transports    text,
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  unique (tenant_id, credential_id)
);
create index on webauthn_credential (tenant_id, user_id);

-- A marketplace listing (an installable app / API product). Tenant-scoped catalog.
create table marketplace_listing (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  key          citext not null,
  name         text not null,
  category     text,
  publisher    text,
  description  text,
  version      text not null default '1.0.0',
  created_at   timestamptz not null default now(),
  unique (tenant_id, key)
);
create index on marketplace_listing (tenant_id, category);

-- Per-tenant install state for a listing.
create table marketplace_install (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  listing_key  citext not null,
  enabled      boolean not null default true,
  installed_by uuid references app_user(id),
  installed_at timestamptz not null default now(),
  unique (tenant_id, listing_key)
);
create index on marketplace_install (tenant_id) where enabled;

do $$
declare t text;
begin
  foreach t in array array['webauthn_credential','marketplace_listing','marketplace_install'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
