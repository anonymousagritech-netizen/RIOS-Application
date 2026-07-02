-- 0079_metric_definition.sql
--
-- Semantic metric layer (brief §13 - reporting / BI). A metric_definition is a
-- named, governed business measure ('gross_written_premium', 'loss_ratio', ...)
-- defined ONCE as data and resolved consistently against live data through the
-- reporting module's governed aggregation (an allowlisted source + measure +
-- aggregation - never raw SQL from the stored expression). A metric may be
-- per-tenant OR global (tenant_id null -> a shipped default any tenant may read
-- but only the owner may write). This is the semantic layer: define a metric
-- once, resolve it the same way everywhere.
--
-- Additive + idempotent. RLS: NULL-global read carve-out (like
-- regulatory_content_version); writes are tenant-scoped.

create table if not exists metric_definition (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenant(id) on delete cascade,   -- null = global default
  key           citext not null,
  name          text not null,
  description   text,
  -- allowlisted reporting source the metric aggregates over
  source        text not null,
  -- the aggregation spec (governed, resolved by reporting, NOT raw SQL):
  --   { kind:'aggregation', measure, agg, filters?, asOfField? }
  --   { kind:'ratio', numerator:{...}, denominator:{...} }
  expression    jsonb not null default '{}'::jsonb,
  unit          text,                          -- 'currency_minor' | 'ratio' | 'count'
  format        text,                          -- 'money' | 'percent' | 'number'
  created_by    uuid references app_user(id) on delete set null,
  created_at    timestamptz not null default now()
);
-- Unique key per scope (global rows collapse the null tenant to a fixed sentinel).
create unique index if not exists metric_definition_key_idx
  on metric_definition (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
create index if not exists metric_definition_tenant_idx on metric_definition (tenant_id);

alter table metric_definition enable row level security;
do $$
begin
  begin
    execute 'create policy tenant_isolation on metric_definition '
         || 'using (tenant_id is null or tenant_id = app_current_tenant()) '
         || 'with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;
grant select, insert, update, delete on metric_definition to rios_app;
