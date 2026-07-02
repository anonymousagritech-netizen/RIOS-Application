-- 0074_binding_authority.sql
--
-- Binding / delegated authority (moves Delegation from Partial to Delivered;
-- workbook gap: "binding-authority depth is a follow-on"). A reinsurer or
-- managing agent grants binding authority to a coverholder (a party) or an
-- internal underwriter (a user), bounded by a per-risk line, an aggregate cap,
-- an optional line-of-business and territory scope, and a validity window.
--
--   binding_authority  the grant itself, with limits and lifecycle status.
--   authority_usage     consumption ledger - each bound line increments the aggregate.
--   authority_breach    detected breaches (over-line / over-aggregate / out-of-scope
--                       / expired) for the audit + referral trail.
--
-- The authority *check* is the pure @rios/domain resolver (checkAuthority); this
-- migration only provides the durable record. Money is integer minor units.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).
-- No per-tenant seed here (a demo grant lives in db/seed/seed.sql).

create table if not exists binding_authority (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id) on delete cascade,
  grantee_party_id    uuid references party(id) on delete cascade,     -- a coverholder
  grantee_user_id     uuid references app_user(id) on delete cascade,  -- or an internal UW
  name                text not null,
  lob                 text,                                            -- null = any line of business
  territory           text,                                            -- null = any territory
  max_line_minor      bigint not null,
  max_aggregate_minor bigint not null,
  currency            char(3) not null,
  valid_from          date,
  valid_to            date,
  status              text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','EXPIRED')),
  created_at          timestamptz not null default now(),
  created_by          uuid references app_user(id) on delete set null
);
create index if not exists binding_authority_idx on binding_authority (tenant_id, status);

create table if not exists authority_usage (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  authority_id  uuid not null references binding_authority(id) on delete cascade,
  contract_id   uuid,
  bound_minor   bigint not null,
  bound_at      timestamptz not null default now(),
  note          text,
  created_by    uuid references app_user(id) on delete set null
);
create index if not exists authority_usage_idx on authority_usage (tenant_id, authority_id, bound_at desc);

create table if not exists authority_breach (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  authority_id    uuid not null references binding_authority(id) on delete cascade,
  kind            text not null check (kind in ('LINE','AGGREGATE','LOB','TERRITORY','EXPIRED')),
  attempted_minor bigint,
  limit_minor     bigint,
  context         jsonb not null default '{}'::jsonb,
  detected_at     timestamptz not null default now(),
  detected_by     uuid references app_user(id) on delete set null
);
create index if not exists authority_breach_idx on authority_breach (tenant_id, authority_id, detected_at desc);

do $$
declare t text;
begin
  foreach t in array array['binding_authority','authority_usage','authority_breach']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
