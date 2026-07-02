-- =============================================================================
-- RIOS - Migration 0071: Field-level security enforcement store (brief §14 - FLS)
--
-- Moves field security from "modelled" to "enforced". `field_security_policy`
-- holds column-masking policies keyed by (entity, field): a caller sees the raw
-- value only if they hold `min_permission` (admin:manage always clears); anyone
-- else sees the value transformed by `mask_strategy`. Masking itself is computed
-- by the pure @rios/domain applyFieldSecurity engine; this table is the config.
--
-- Enforcement is OPT-IN and behaviour-preserving: with no active policy for an
-- entity, reads are byte-identical to before. Complements row-level security
-- (which hides whole rows) by hiding sensitive columns within a visible row.
--
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt) per
-- the 0052 pattern. NO per-tenant seed here - demo policies (if any) live in
-- db/seed/seed.sql so a fresh migrate never injects policies that alter reads.
-- =============================================================================

create table if not exists field_security_policy (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  entity         text not null,
  field          text not null,
  mask_strategy  text not null default 'FULL' check (mask_strategy in ('FULL','PARTIAL','HASH','REDACT')),
  min_permission text not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (tenant_id, entity, field)
);
create index if not exists field_security_policy_entity_idx
  on field_security_policy (tenant_id, entity) where active;

do $$
declare t text := 'field_security_policy';
begin
  execute format('alter table %I enable row level security', t);
  begin
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())',
      t);
  exception when duplicate_object then null; end;
  execute format('grant select, insert, update, delete on %I to rios_app', t);
end$$;
