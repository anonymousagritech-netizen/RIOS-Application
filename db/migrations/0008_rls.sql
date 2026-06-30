-- =============================================================================
-- RIOS — Migration 0008: Row-Level Security policies & the application role
-- Brief §14.2 (RLS), §14.5 (tenant isolation), §16.3 (data-layer tenancy)
-- =============================================================================
-- The application connects as rios_app (NOT the owner). Per request it runs
--   select set_config('app.tenant_id', '<uuid>', true);
--   select set_config('app.user_id',   '<uuid>', true);
-- and every policy restricts rows to that tenant. The owner/superuser bypasses
-- RLS for migrations and platform-admin tasks only.

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------
-- The app role password is provided at migrate time via the GUC
-- `rios.app_role_password` (set by the migrate runner from RIOS_APP_DB_PASSWORD)
-- and falls back to a strong default. Managed providers (e.g. Neon) reject weak
-- passwords, so this must never be a trivial literal. Keep the value in sync with
-- the password in DATABASE_APP_URL.
do $$
declare
  pw text := coalesce(nullif(current_setting('rios.app_role_password', true), ''),
                      'Rios9Mqlym0Wq5kL3dOSM1ZE');
begin
  if not exists (select 1 from pg_roles where rolname = 'rios_app') then
    execute format('create role rios_app login password %L', pw);
  else
    execute format('alter role rios_app with login password %L', pw);
  end if;
end$$;

grant usage on schema public to rios_app;
grant select, insert, update, delete on all tables in schema public to rios_app;
grant usage, select on all sequences in schema public to rios_app;
alter default privileges in schema public grant select, insert, update, delete on tables to rios_app;
alter default privileges in schema public grant usage, select on sequences to rios_app;

-- Audit log is append-only for the app: no UPDATE/DELETE (§14.3).
revoke update, delete on audit_log from rios_app;

-- Helper: the active tenant for this session (null if unset -> no rows visible).
create or replace function app_current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS + standard tenant policy on every tenant-scoped table.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tenant_tables text[] := array[
    'app_user','role','role_permission','user_role','org_unit',
    'code_list','code_value','currency','exchange_rate','numbering_scheme','config_document',
    'party','party_role','party_contact','party_financial',
    'programme','contract','contract_layer','participation','term_set','risk',
    'financial_event','statement_of_account','gl_account','journal','ledger_posting',
    'cat_event','claim','reserve_movement','recovery',
    'audit_log','outbox'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    -- read/write restricted to the active tenant
    execute format($p$
      create policy tenant_isolation on %I
        using (tenant_id = app_current_tenant())
        with check (tenant_id = app_current_tenant());
    $p$, t);
  end loop;
end$$;

-- The `tenant` table itself: a session may only see its own tenant row.
alter table tenant enable row level security;
alter table tenant force row level security;
create policy tenant_self on tenant
  using (id = app_current_tenant())
  with check (id = app_current_tenant());

-- The `permission` catalog is global, read-only reference data — readable by all.
grant select on permission to rios_app;
