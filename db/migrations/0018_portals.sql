-- =============================================================================
-- RIOS - Migration 0018: External portals (brief §9.15)
-- Portals are thin, permission-scoped *projections* of the core APIs for an
-- external counterparty (broker, cedent, retrocessionaire, coverholder, client)
-- - never a parallel data store. A portal_grant binds an app_user to one party
-- and one portal type; portal endpoints filter every read to that party.
-- =============================================================================

create table portal_grant (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  user_id       uuid not null references app_user(id) on delete cascade,
  party_id      uuid not null references party(id) on delete cascade,
  -- which portal surface this grant unlocks
  portal_type   text not null check (portal_type in
                  ('broker','cedent','retrocessionaire','coverholder','client')),
  -- optional narrowing of what the grant can see, as code values; empty = the
  -- portal's default read set. Stored as a json array of scope strings.
  scopes        jsonb not null default '[]'::jsonb,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, user_id, party_id, portal_type)
);
create index on portal_grant (tenant_id, user_id) where enabled;
create index on portal_grant (tenant_id, party_id);

do $$
begin
  execute 'alter table portal_grant enable row level security';
  execute 'alter table portal_grant force row level security';
  execute 'create policy tenant_isolation on portal_grant using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
end$$;
