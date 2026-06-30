-- =============================================================================
-- RIOS - Migration 0021: Data retention & legal hold (brief §14)
-- Retention policies (how long each entity type is kept, and what happens when
-- it ages out) and legal holds (suspend disposal of records under litigation).
-- The eligibility decision is computed by @rios/domain (retentionVerdict);
-- these tables hold the policy state. A hold always overrides a policy.
-- =============================================================================

create table retention_policy (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  entity_type    text not null,
  retention_days int not null check (retention_days >= 0),
  action         text not null default 'archive' check (action in ('archive','purge')),
  active         boolean not null default true,
  note           text,
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now(),
  unique (tenant_id, entity_type)
);
create index on retention_policy (tenant_id) where active;

create table legal_hold (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  reason        text,
  -- scope: null entity_type = a global hold; null entity_id = whole type
  entity_type   text,
  entity_id     uuid,
  active        boolean not null default true,
  placed_by     uuid references app_user(id),
  placed_at     timestamptz not null default now(),
  released_at   timestamptz
);
create index on legal_hold (tenant_id) where active;

do $$
declare t text;
begin
  foreach t in array array['retention_policy','legal_hold'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
