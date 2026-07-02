-- 0068_consolidation.sql
--
-- Legal-entity consolidation (Legal Entities gap: a real multi-entity
-- consolidation engine with recorded intercompany eliminations, replacing the
-- honest "this is only a reporting VIEW, not a legal-entity consolidation
-- engine" caveat of the previous /api/accounting/consolidation view).
--
-- No legal_entity/entity table existed before this migration (the org module's
-- org_unit is a directory/reporting hierarchy, not a consolidation entity with
-- functional currency + ownership), so we create a purpose-built legal_entity.
--
-- Entity attribution of GL postings: additive, behaviour-preserving. We add a
-- nullable entity_id to the journal HEADER (not to ledger_posting lines - a
-- journal is one entity's balanced booking, so the header is the natural, less
-- invasive place). NULL = the primary/default entity, exactly the meaning every
-- existing report already assumes, so all existing trial-balance / P&L /
-- reconciliation queries (which never filter on entity_id) are byte-identical.
--
-- consolidation_run + consolidation_elimination record what a run computed, so
-- eliminations are auditable rather than only living in a live view.
--
-- Money is integer minor units. Additive + idempotent. RLS enable-only
-- (rios_app enforced; owner exempt) - grants mirror 0052/0058.

-- A legal entity in the consolidation group. parent_entity_id builds the
-- hierarchy (group -> subsidiaries). ownership_pct is the group's holding in
-- this entity (100 = wholly owned / the parent) and drives minority interest.
create table if not exists legal_entity (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  code                text not null,
  name                text not null,
  parent_entity_id    uuid references legal_entity(id) on delete set null,
  functional_currency char(3) not null default 'USD',
  ownership_pct       numeric not null default 100 check (ownership_pct >= 0 and ownership_pct <= 100),
  created_at          timestamptz not null default now(),
  created_by          uuid references app_user(id) on delete set null,
  unique (tenant_id, code)
);
create index if not exists legal_entity_idx on legal_entity (tenant_id, code);
create index if not exists legal_entity_parent_idx on legal_entity (tenant_id, parent_entity_id);

-- Additive, behaviour-preserving entity attribution on the journal header.
-- NULL = primary/default entity; existing queries do not read this column.
alter table journal add column if not exists entity_id uuid references legal_entity(id) on delete set null;
create index if not exists journal_entity_idx on journal (tenant_id, entity_id);

-- A consolidation run: the group + as-of date it consolidated, who ran it.
create table if not exists consolidation_run (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  as_of           date not null,
  group_entity_id uuid references legal_entity(id) on delete set null,
  status          text not null default 'completed' check (status in ('draft','completed','error')),
  currency        char(3),
  created_by      uuid references app_user(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists consolidation_run_idx on consolidation_run (tenant_id, as_of desc);

-- The intercompany eliminations a run computed (auditable). One row per entity
-- leg removed from the group accounts. amount_minor is the removed net balance
-- (debit - credit) in integer minor units.
create table if not exists consolidation_elimination (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  run_id           uuid not null references consolidation_run(id) on delete cascade,
  account_code     text not null,
  entity_id        uuid references legal_entity(id) on delete set null,
  counter_entity_id uuid references legal_entity(id) on delete set null,
  amount_minor     bigint not null default 0,
  currency         char(3),
  reason           text
);
create index if not exists consolidation_elimination_run_idx on consolidation_elimination (tenant_id, run_id);

do $$
declare t text;
begin
  foreach t in array array['legal_entity','consolidation_run','consolidation_elimination']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
