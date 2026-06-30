-- =============================================================================
-- RIOS - Migration 0024: Approval delegation (brief §3)
-- A delegation grants a delegate the delegator's approval authority for a window,
-- optionally scoped to one permission. The "may act" decision is computed by
-- @rios/domain (canActAs); this table holds the grants.
-- =============================================================================

create table approval_delegation (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  delegator_user_id uuid not null references app_user(id) on delete cascade,
  delegate_user_id  uuid not null references app_user(id) on delete cascade,
  scope_permission  text,                       -- null = all approvals
  reason            text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  active            boolean not null default true,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  check (delegator_user_id <> delegate_user_id)
);
create index on approval_delegation (tenant_id, delegate_user_id) where active;
create index on approval_delegation (tenant_id, delegator_user_id) where active;

do $$
begin
  execute 'alter table approval_delegation enable row level security';
  execute 'alter table approval_delegation force row level security';
  execute 'create policy tenant_isolation on approval_delegation using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
end$$;
