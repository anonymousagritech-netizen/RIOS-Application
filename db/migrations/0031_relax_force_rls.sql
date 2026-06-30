-- 0031_relax_force_rls.sql
--
-- Make the deployment portable to managed Postgres (e.g. Neon), where the
-- database OWNER role is NOT a real superuser.
--
-- Background
-- ----------
-- Migrations 0008..0030 set `FORCE ROW LEVEL SECURITY` on every tenant table.
-- FORCE makes RLS apply even to the table owner. Locally this is harmless
-- because the owner role (`rios`) is a SUPERUSER, and superusers bypass RLS
-- regardless of FORCE. On Neon the owner (`neondb_owner`) is a *non-superuser*
-- owner, so FORCE actually subjects the owner connection to RLS - which breaks
-- the two flows that legitimately run on the owner connection and rely on
-- bypassing RLS:
--   * login (reads app_user / role / role_permission before any tenant
--     context exists -> would return 0 rows), and
--   * seed / migrations (INSERTs hit RLS WITH CHECK with no app.tenant_id set).
--
-- Security note
-- -------------
-- This only relaxes FORCE for the OWNER connection (DATABASE_URL), used solely
-- for migrations, seed and login. The application's runtime connection is
-- `rios_app`, which is NOT the table owner, so ENABLE ROW LEVEL SECURITY still
-- fully enforces tenant isolation against it. The attack surface (the app role)
-- is unchanged; we are only restoring the standard "owner is exempt" behaviour
-- that a superuser owner already had locally.
--
-- Idempotent: only touches tables that currently have FORCE set.

do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relforcerowsecurity
  loop
    execute format('alter table public.%I no force row level security;', r.relname);
  end loop;
end $$;
