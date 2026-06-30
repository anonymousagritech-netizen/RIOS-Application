-- =============================================================================
-- RIOS - Migration 0022: Field-level security (brief §14 - RLS/FLS)
-- Column-masking policies: a sensitive field is masked unless the viewer holds
-- the required permission. Masking is computed by @rios/domain (applyMasking);
-- this table holds the policy. Complements row-level security.
-- =============================================================================

create table field_policy (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  entity_type         text not null,
  field               text not null,
  classification      text not null default 'PII',
  required_permission text not null,
  strategy            text not null default 'redact' check (strategy in ('redact','partial','hash','none')),
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  unique (tenant_id, entity_type, field)
);
create index on field_policy (tenant_id, entity_type) where active;

do $$
begin
  execute 'alter table field_policy enable row level security';
  execute 'alter table field_policy force row level security';
  execute 'create policy tenant_isolation on field_policy using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
end$$;
