-- =============================================================================
-- RIOS - Migration 0072: Retention schedules, right-to-erasure & hold linkage
-- Moves Retention from "designed-for" to "delivered" (brief §14, §16.2).
--
-- Builds on 0021 (retention_policy + legal_hold). Adds:
--   * retention_schedule - per-entity disposal schedules (age from CREATED or
--     CLOSED date, then ARCHIVE / ANONYMISE / DELETE) used to compute due
--     candidates. This is advisory: nothing is auto-deleted.
--   * erasure_request     - a maker/checker right-to-erasure workflow. An
--     approved request is executed honestly (the subject's PII is anonymised /
--     soft-deleted) but is BLOCKED_BY_HOLD if an ACTIVE legal_hold covers it.
--   * legal_hold gains an explicit status + released_by so a hold has a full
--     ACTIVE -> RELEASED lifecycle with attribution (kept in sync with `active`).
--
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).
-- gen_random_uuid() PKs. NO per-tenant seed here (that lives in db/seed).
-- =============================================================================

create table if not exists retention_schedule (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  entity           text not null,
  retention_months int not null check (retention_months >= 0),
  basis            text not null default 'CREATED' check (basis in ('CREATED','CLOSED')),
  action           text not null check (action in ('ARCHIVE','ANONYMISE','DELETE')),
  active           boolean not null default true,
  created_by       uuid references app_user(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists retention_schedule_idx on retention_schedule (tenant_id) where active;

create table if not exists erasure_request (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  subject_entity text not null,
  subject_id     uuid not null,
  reason         text,
  status         text not null default 'REQUESTED'
                   check (status in ('REQUESTED','APPROVED','EXECUTED','REJECTED','BLOCKED_BY_HOLD')),
  requested_by   uuid references app_user(id) on delete set null,
  approved_by    uuid references app_user(id) on delete set null,
  executed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists erasure_request_idx on erasure_request (tenant_id, status);

-- Give legal_hold a first-class ACTIVE -> RELEASED status + release attribution.
-- `active` (from 0021) stays the authoritative flag; status mirrors it.
alter table legal_hold add column if not exists status      text not null default 'ACTIVE';
alter table legal_hold add column if not exists released_by uuid references app_user(id) on delete set null;
do $$
begin
  begin
    alter table legal_hold add constraint legal_hold_status_chk check (status in ('ACTIVE','RELEASED'));
  exception when duplicate_object then null; end;
end$$;

do $$
declare t text;
begin
  foreach t in array array['retention_schedule','erasure_request']
  loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
