-- 0055_soa_verification.sql
--
-- SOA (statement of account) verification engine (industry-gap-analysis §2.2
-- item 8). A verification run recomputes the expected commission / sliding-scale
-- / reinstatement figures from the contract's typed terms via @rios/domain and
-- compares them with what the cedent's statement actually carries; each compared
-- line is persisted as an item with its deviation and tolerance verdict.
-- Money is integer minor units. Additive + idempotent. RLS enable-only
-- (rios_app enforced; owner exempt).

create table if not exists soa_verification (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  statement_id  uuid not null references statement_of_account(id) on delete cascade,
  status        text not null check (status in ('VERIFIED','DEVIATIONS','FAILED')),
  tolerance_pct numeric not null default 1,
  created_by    uuid references app_user(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists soa_verification_idx on soa_verification (tenant_id, statement_id, created_at desc);

create table if not exists soa_verification_item (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  verification_id  uuid not null references soa_verification(id) on delete cascade,
  item_key         text not null,
  expected_minor   bigint,
  actual_minor     bigint,
  deviation_minor  bigint,
  within_tolerance boolean,
  note             text
);
create index if not exists soa_verification_item_idx on soa_verification_item (tenant_id, verification_id);

do $$
declare t text;
begin
  foreach t in array array['soa_verification','soa_verification_item']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
