-- 0037_underwriting.sql
--
-- Underwriting Workbench: a submission is the unit of work that flows through the
-- underwriting lifecycle (Submission → Triage → Analysis → Pricing → Referral →
-- Quoted → Bound / Declined / Lapsed). It carries the risk score, the priced
-- terms and the workflow stage; every stage move / note / decision is recorded
-- in submission_activity as an auditable, append-only trail.
-- RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

create table if not exists submission (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id) on delete cascade,
  reference         text not null,
  title             text not null,
  kind              text not null default 'TREATY' check (kind in ('TREATY','FACULTATIVE')),
  basis             text check (basis in ('PROPORTIONAL','NON_PROPORTIONAL')),
  structure         text,               -- QUOTA_SHARE / SURPLUS / PER_RISK_XL / CAT_XL / AGG_XL / STOP_LOSS
  line_of_business  text,
  cedent_party_id   uuid references party(id) on delete set null,
  broker_party_id   uuid references party(id) on delete set null,
  currency          char(3) not null default 'USD',
  inception         date,
  expiry            date,
  territory         text,
  sum_insured_minor bigint,
  attachment_minor  bigint,
  limit_minor       bigint,
  est_premium_minor bigint,             -- estimated premium income (EPI)
  target_premium_minor bigint,          -- technical / target premium
  loss_ratio_pct    numeric,            -- historical, drives risk score
  cat_exposed       boolean not null default false,
  class_hazard      integer,            -- 1..5
  prior_claims      integer,
  years_with_cedent integer,
  risk_score        integer,            -- 0..100
  risk_band         text,               -- LOW / MODERATE / ELEVATED / HIGH
  stage             text not null default 'SUBMISSION'
                    check (stage in ('SUBMISSION','TRIAGE','ANALYSIS','PRICING','REFERRAL','QUOTED','BOUND','DECLINED','LAPSED')),
  bound_contract_id uuid references contract(id) on delete set null,
  assigned_to       uuid references app_user(id) on delete set null,
  terms             jsonb,
  created_by        uuid references app_user(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, reference)
);
create index if not exists submission_tenant_stage_idx on submission (tenant_id, stage, created_at desc);

create table if not exists submission_activity (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  submission_id uuid not null references submission(id) on delete cascade,
  kind          text not null,          -- STAGE / NOTE / SCORE / PRICE / REFERRAL / DECISION / CREATE
  from_stage    text,
  to_stage      text,
  note          text,
  actor         uuid references app_user(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists submission_activity_idx on submission_activity (tenant_id, submission_id, created_at desc);

do $$
begin
  execute 'alter table submission enable row level security';
  begin execute 'create policy tenant_isolation on submission using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
  execute 'alter table submission_activity enable row level security';
  begin execute 'create policy tenant_isolation on submission_activity using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on submission to rios_app;
grant select, insert, update, delete on submission_activity to rios_app;
