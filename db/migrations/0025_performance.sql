-- =============================================================================
-- RIOS — Migration 0025: Performance management (brief §14)
-- Employee review cycles with weighted goals. The overall rating is computed by
-- @rios/domain (weightedRating/ratingBand); goals are stored as a json array on
-- the review so a cycle is a single document.
-- =============================================================================

create table performance_review (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id) on delete cascade,
  employee_id     uuid not null references employee(id) on delete cascade,
  period          text not null,                 -- 'FY2026', 'Q2-2026', ...
  status          text not null default 'draft' check (status in ('draft','in_review','finalised')),
  -- goals: [{ "title": "...", "weight": 2, "score": 4 }]
  goals           jsonb not null default '[]'::jsonb,
  overall_score   numeric(4,2) not null default 0,
  band            text,
  summary         text,
  reviewer_id     uuid references app_user(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, employee_id, period)
);
create index on performance_review (tenant_id, employee_id);
create index on performance_review (tenant_id, status);

do $$
begin
  execute 'alter table performance_review enable row level security';
  execute 'alter table performance_review force row level security';
  execute 'create policy tenant_isolation on performance_review using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
end$$;
