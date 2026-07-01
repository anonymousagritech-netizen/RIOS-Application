-- 0045_treaty_admin.sql
--
-- Treaty administration depth (brief §28). Adds versioning (immutable snapshots
-- of a treaty at a point in time), special clauses / wording, and a tax schedule
-- on top of the existing contract / contract_layer / contract_endorsement model.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists treaty_version (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid not null references contract(id) on delete cascade,
  version_no    int not null,
  note          text,
  snapshot      jsonb not null default '{}'::jsonb,   -- terms/layers/status at snapshot time
  created_by    uuid references app_user(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (contract_id, version_no)
);
create index if not exists treaty_version_idx on treaty_version (tenant_id, contract_id, version_no desc);

create table if not exists treaty_clause (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid not null references contract(id) on delete cascade,
  code          text,
  title         text not null,
  category      text not null default 'GENERAL'
                check (category in ('GENERAL','EXCLUSION','CONDITION','WARRANTY','COMMISSION','REINSTATEMENT','SANCTIONS','WORDING')),
  body          text,
  created_at    timestamptz not null default now()
);
create index if not exists treaty_clause_idx on treaty_clause (tenant_id, contract_id);

create table if not exists treaty_tax (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid not null references contract(id) on delete cascade,
  kind          text not null,                        -- e.g. FET, IPT, withholding
  rate_pct      numeric not null default 0,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists treaty_tax_idx on treaty_tax (tenant_id, contract_id);

do $$
declare t text;
begin
  foreach t in array array['treaty_version','treaty_clause','treaty_tax']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
