-- =============================================================================
-- RIOS - Migration 0029: Security & resilience (brief §14, §15, §19)
-- KMS key registry (envelope encryption), backup/DR run catalog, and locale
-- message store for i18n. SOC/SIEM reads the existing audit_log; SAML reuses the
-- existing identity_provider table. The dev KMS master key is environment-config;
-- production uses a managed HSM/KMS - see docs/open-questions.md.
-- =============================================================================

-- A data-encryption key (DEK), stored WRAPPED by the KMS master key. The raw DEK
-- never touches the database.
create table kms_key (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  alias        citext not null,
  version      int not null default 1,
  algorithm    text not null default 'AES-256-GCM',
  -- base64( iv || authTag || wrappedDek )
  wrapped_key  text not null,
  status       text not null default 'active' check (status in ('active','rotated','disabled')),
  created_at   timestamptz not null default now(),
  unique (tenant_id, alias, version)
);
create index on kms_key (tenant_id, alias) where status = 'active';

-- A backup / snapshot run (DR catalog).
create table backup_run (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  kind         text not null default 'snapshot' check (kind in ('full','incremental','snapshot')),
  status       text not null default 'completed' check (status in ('running','completed','failed')),
  location     text,
  size_bytes   bigint,
  note         text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  created_by   uuid references app_user(id)
);
create index on backup_run (tenant_id, started_at desc);

-- Locale messages for i18n (key → message per locale).
create table locale_message (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenant(id) on delete cascade,
  locale     citext not null,
  key        text not null,
  message    text not null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, locale, key)
);
create index on locale_message (tenant_id, locale);

do $$
declare t text;
begin
  foreach t in array array['kms_key','backup_run','locale_message'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
