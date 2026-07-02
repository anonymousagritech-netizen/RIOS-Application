-- =============================================================================
-- RIOS - Migration 0082: Sanctions feed refresh log (brief §12 - compliance).
-- The denylist (sanctions_list_entry, migration 0052) and the screening matcher
-- already exist, but the list had no way to be *loaded* from a provider. This
-- adds the provider-refresh audit log; the sanctionsFeed module ships a working
-- in-repo sample feed adapter (SanctionsFeedProvider) that populates
-- sanctions_list_entry, with a live OFAC/EU/UN/OFSI feed as the labelled seam
-- behind the same interface. Additive + idempotent. RLS enable-only.
-- =============================================================================

create table if not exists sanctions_feed_refresh (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  source        text not null,                 -- OFAC-SAMPLE / OFAC / EU / UN / OFSI
  provider      text not null default 'BUNDLED',
  entry_count   int not null default 0,
  refreshed_at  timestamptz not null default now(),
  refreshed_by  uuid references app_user(id) on delete set null
);
create index if not exists sanctions_feed_refresh_idx on sanctions_feed_refresh (tenant_id, source, refreshed_at desc);

do $$
declare t text;
begin
  foreach t in array array['sanctions_feed_refresh']
  loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
