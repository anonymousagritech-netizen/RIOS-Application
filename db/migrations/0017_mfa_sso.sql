-- =============================================================================
-- RIOS — Migration 0017: MFA & federated identity (SSO / OIDC)
-- Brief §14.1 (MFA enforced by policy; SSO via OAuth2/OIDC, SAML, Azure AD, LDAP)
-- =============================================================================

-- TOTP (and future WebAuthn) credentials per user.
create table mfa_credential (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  user_id       uuid not null references app_user(id) on delete cascade,
  type          text not null default 'totp' check (type in ('totp','webauthn')),
  -- base32 TOTP secret (encrypt at rest with a KMS-managed key in production, §9.2)
  secret        text not null,
  enabled       boolean not null default false,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, type)
);
create index on mfa_credential (tenant_id, user_id);

-- A configured federated identity provider (OIDC) for a tenant.
create table identity_provider (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  key           citext not null,                  -- 'azure-ad', 'okta', …
  name          text not null,
  type          text not null default 'oidc' check (type in ('oidc','saml')),
  issuer        text,
  authorization_endpoint text,
  token_endpoint         text,
  userinfo_endpoint      text,
  jwks_uri               text,
  client_id     text,
  -- store the client secret encrypted with a KMS key in production (§9.2)
  client_secret text,
  scopes        text not null default 'openid email profile',
  -- map an OIDC subject/email onto an app_user by this claim (default email)
  match_claim   text not null default 'email',
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, key)
);
create index on identity_provider (tenant_id) where enabled;

-- A federated identity bound to an app_user (one user may have several).
create table user_identity (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  provider_key  citext not null,
  subject       text not null,                    -- the IdP 'sub' claim
  email         citext,
  user_id       uuid not null references app_user(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (tenant_id, provider_key, subject)
);
create index on user_identity (tenant_id, user_id);

do $$
declare t text;
begin
  foreach t in array array['mfa_credential','identity_provider','user_identity'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
