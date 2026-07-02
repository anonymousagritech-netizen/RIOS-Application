-- 0060: governed reserving workflow (industry gap analysis Tier-3 #13).
--
-- Triangles -> IBNR with an actuarial recommendation (the chain-ladder engine in
-- @rios/domain computes it; the server only orchestrates) -> management approval
-- (maker/checker: a DIFFERENT user approves) -> GL booking through the existing
-- journal/ledger_posting path, plus actual-vs-expected (AvE) monitoring rows.
-- The input triangle is snapshotted as jsonb so the recommendation is always
-- reproducible from what the actuary saw. Money is integer minor units.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists ibnr_study (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenant(id) on delete cascade,
  name                 text not null,
  as_of                date not null,
  lob                  text,
  method               text not null,
  triangle             jsonb not null,          -- input cumulative triangle snapshot (minor units)
  recommendation_minor bigint not null,
  currency             char(3) not null,
  rationale            text,
  status               text not null default 'DRAFT'
                         check (status in ('DRAFT','RECOMMENDED','APPROVED','BOOKED','REJECTED')),
  rejection_reason     text,
  created_by           uuid references app_user(id) on delete set null,
  recommended_by       uuid references app_user(id) on delete set null,
  approved_by          uuid references app_user(id) on delete set null,
  approved_at          timestamptz,
  booked_at            timestamptz,
  journal_id           uuid references journal(id) on delete set null,
  created_at           timestamptz not null default now()
);
create index if not exists ibnr_study_idx on ibnr_study (tenant_id, status, as_of desc);

create table if not exists ibnr_ave (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  study_id       uuid not null references ibnr_study(id) on delete cascade,
  period         date not null,
  expected_minor bigint not null,
  actual_minor   bigint not null,
  currency       char(3) not null,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists ibnr_ave_idx on ibnr_ave (tenant_id, study_id, period);

do $$
declare t text;
begin
  foreach t in array array['ibnr_study','ibnr_ave']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
