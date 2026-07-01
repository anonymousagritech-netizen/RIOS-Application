-- 0049_search.sql
--
-- Global Search enhancements (brief §29). Saved searches (a named query + its
-- filters, per user) and a per-user search history feeding suggestions. The
-- base full-text search lives in the search module; this adds persistence.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists saved_search (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  user_id     uuid references app_user(id) on delete cascade,
  name        text not null,
  query       text not null,
  filters     jsonb not null default '{}'::jsonb,   -- {types:[], status, year}
  created_at  timestamptz not null default now(),
  unique (tenant_id, user_id, name)
);
create index if not exists saved_search_idx on saved_search (tenant_id, user_id);

create table if not exists search_history (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  user_id       uuid references app_user(id) on delete cascade,
  query         text not null,
  results_count int not null default 0,
  searched_at   timestamptz not null default now()
);
create index if not exists search_history_idx on search_history (tenant_id, user_id, searched_at desc);

do $$
declare t text;
begin
  foreach t in array array['saved_search','search_history']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
