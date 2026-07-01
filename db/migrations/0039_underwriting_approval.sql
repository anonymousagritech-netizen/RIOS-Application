-- 0039_underwriting_approval.sql
--
-- Underwriting approval / referral engine (brief §7 / §28.7). When a submission
-- exceeds delegated authority (risk band or limit), binding is referred up a
-- chain: underwriter → senior underwriter → chief underwriter → committee. Each
-- referral is one submission_approval row carrying the required level, the SLA
-- due time and the decision. The domain approval matrix (@rios/domain
-- underwritingApproval) decides which level is required; this table records the
-- request and its outcome, and gates the bind until it is APPROVED.
-- RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

create table if not exists submission_approval (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  submission_id uuid not null references submission(id) on delete cascade,
  level         text not null check (level in ('UNDERWRITER','SENIOR_UW','CHIEF_UW','COMMITTEE')),
  reason        text,                       -- the matrix rule that drove the referral
  status        text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  sla_due_at    timestamptz,                -- expected turnaround (level SLA)
  requested_by  uuid references app_user(id) on delete set null,
  decided_by    uuid references app_user(id) on delete set null,
  decided_at    timestamptz,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists submission_approval_idx on submission_approval (tenant_id, submission_id, created_at desc);
create index if not exists submission_approval_queue_idx on submission_approval (tenant_id, status, sla_due_at);

do $$
begin
  execute 'alter table submission_approval enable row level security';
  begin execute 'create policy tenant_isolation on submission_approval using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on submission_approval to rios_app;
