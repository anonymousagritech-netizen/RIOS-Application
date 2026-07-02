-- 0077_dashboard_layout.sql
--
-- No-code Dashboard designer (brief §30 - "drag-and-drop dashboard designer is
-- designed-for"). Persists a user-composed dashboard: an ordered set of KPI /
-- chart tiles chosen from the LIVE /api/executive packs. A layout is either
-- personal (user_id set - belongs to that user) or shared/tenant-wide
-- (user_id null - visible to everyone in the tenant; only platform:write may
-- create/delete one). `tiles` is an opaque jsonb array of tile references
-- ({persona, kind, ref, size}) resolved against live data on the client, so no
-- metric value is ever persisted or faked here. Additive + idempotent.
--
-- Per-tenant demo rows live in db/seed/seed.sql, NOT in this migration.

create table if not exists dashboard_layout (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  user_id    uuid references app_user(id) on delete cascade,  -- null => shared/tenant-wide
  name       text not null,
  tiles      jsonb not null default '[]'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists dashboard_layout_tenant_idx on dashboard_layout (tenant_id);
create index if not exists dashboard_layout_user_idx on dashboard_layout (user_id);

-- One layout per (owner, name): partial unique indexes let personal and shared
-- layouts share names and give POST a clean upsert target per scope.
create unique index if not exists dashboard_layout_user_name
  on dashboard_layout (tenant_id, user_id, name) where user_id is not null;
create unique index if not exists dashboard_layout_shared_name
  on dashboard_layout (tenant_id, name) where user_id is null;

-- RLS: tenant isolation (rios_app enforced; owner - migrations/seed - exempt).
do $$
begin
  execute 'alter table dashboard_layout enable row level security';
  begin
    execute 'create policy tenant_isolation on dashboard_layout using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
  execute 'grant select, insert, update, delete on dashboard_layout to rios_app';
end$$;
