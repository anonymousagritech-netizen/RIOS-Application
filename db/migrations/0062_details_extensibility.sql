-- 0062_details_extensibility.sql
--
-- Extensibility: a metadata-driven `details jsonb` bag for entities that lack a
-- flexible terms/parameters column. This backs the Dynamic Form Engine (adaptive
-- forms) on the frontend: the form definition lives in reference data / code
-- lists, and the captured answers are persisted here without a schema change per
-- field. Additive and idempotent - no RLS changes are needed, since the new
-- column inherits each table's existing row-level-security policies.
--
-- Affected tables: claim (FNOL), cash_call, risk (the facultative single-risk
-- cession), party (CRO/compliance adaptive fields).

alter table claim     add column if not exists details jsonb not null default '{}'::jsonb;
alter table cash_call add column if not exists details jsonb not null default '{}'::jsonb;
alter table risk      add column if not exists details jsonb not null default '{}'::jsonb;
alter table party     add column if not exists details jsonb not null default '{}'::jsonb;
