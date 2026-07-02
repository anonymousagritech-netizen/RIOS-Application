-- 0070_regulatory_content.sql
--
-- Regulatory / Returns: jurisdiction content as VERSIONED CONFIG + a real
-- FILING-VALIDATION engine (moves "Regulatory / Returns" from Partial towards
-- Delivered).
--
-- Two capabilities are delivered here:
--
--  1. regulatory_content_version - jurisdiction filing content (Schedule F
--     provision factor bands, Solvency II QRT required-cell maps + control ties,
--     IRDAI return line maps) stored as VERSIONED, per-jurisdiction config that a
--     deployment can override and certify. tenant_id NULL = global/default
--     content (the illustrative, is_certified=false defaults the platform ships
--     as code; a deployment inserts its own certified versions). tenant_id set =
--     a tenant override / certified version. Newer version wins; rows are
--     append-only (no UPDATE/DELETE grant) so the version history is immutable.
--
--  2. filing_validation (+ _item) - the persisted result of validating an
--     assembled pack against the required cells / control totals / factor bands
--     of its effective content version. status PASS/WARN/FAIL with per-rule
--     detail. This is the real, delivered validation capability.
--
-- HONESTY (CLAUDE.md): the shipped default content is is_certified=false
-- ("illustrative default, not certified"); certified factor tables / official
-- cell codes are per-deployment jurisdiction configuration, not invented here.
--
-- NO per-tenant seed lives in this migration (migrations run BEFORE seed on a
-- fresh install, so any insert-from-tenant here would insert nothing). Global
-- default content ships as code with a code fallback in the loader; tenant
-- overrides are written at runtime through POST /api/regulatory/content.
--
-- Money is integer minor units. Additive + idempotent. RLS enabled; grants
-- mirror 0052/0058/0068 (rios_app enforced, owner exempt).

-- Versioned, per-jurisdiction filing content. tenant_id NULL => global/default.
create table if not exists regulatory_content_version (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid references tenant(id) on delete cascade,   -- NULL = global/default content
  jurisdiction   text not null,
  content_key    text not null,
  version        int  not null default 1,
  effective_from date not null default current_date,
  body           jsonb not null,
  is_certified   boolean not null default false,
  created_by     uuid references app_user(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- One row per (scope, jurisdiction, key, version). COALESCE folds the NULL
-- global scope to a fixed sentinel so a unique CONSTRAINT can't be used - a
-- unique INDEX over the expression is the idiom.
create unique index if not exists regulatory_content_version_uidx
  on regulatory_content_version
     (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), jurisdiction, content_key, version);
create index if not exists regulatory_content_version_lookup_idx
  on regulatory_content_version (jurisdiction, content_key, version desc);

-- A filing-validation run: which pack, as-of which date, and the verdict.
create table if not exists filing_validation (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  pack_code    text not null,
  as_of        date not null,
  status       text not null check (status in ('PASS','WARN','FAIL')),
  created_by   uuid references app_user(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists filing_validation_idx on filing_validation (tenant_id, pack_code, created_at desc);

-- One row per validation rule evaluated (required cell / control tie / factor band).
create table if not exists filing_validation_item (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  validation_id uuid not null references filing_validation(id) on delete cascade,
  rule_key      text not null,
  severity      text not null check (severity in ('ERROR','WARN')),
  message       text not null,
  expected      jsonb,
  actual        jsonb,
  ok            boolean not null
);
create index if not exists filing_validation_item_idx on filing_validation_item (tenant_id, validation_id);

-- RLS: regulatory_content_version has the NULL-global carve-out (everyone may
-- READ global defaults; a tenant may only WRITE its own scoped rows). The two
-- filing_validation tables are ordinary tenant-isolated append-only logs.
alter table regulatory_content_version enable row level security;
do $$
begin
  begin
    execute 'create policy tenant_isolation on regulatory_content_version '
         || 'using (tenant_id is null or tenant_id = app_current_tenant()) '
         || 'with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;
-- Append-only: no UPDATE/DELETE (version history is immutable).
grant select, insert on regulatory_content_version to rios_app;

do $$
declare t text;
begin
  foreach t in array array['filing_validation','filing_validation_item']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    -- Append-only audit-style log: insert + read only.
    execute format('grant select, insert on %I to rios_app', t);
  end loop;
end$$;
