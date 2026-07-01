-- 0043_tasks.sql
--
-- Task management & SLA monitoring (brief §19 / Operations). A task is a unit of
-- assignable work with a priority, a due date (SLA) and an optional link to the
-- business entity it concerns (a submission, claim, treaty, party…). Referrals,
-- renewals and reviews across the platform can raise tasks so nothing falls
-- through the cracks; the operations console tracks them to done.
-- RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

create table if not exists task (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  title         text not null,
  description   text,
  kind          text not null default 'GENERAL'
                check (kind in ('GENERAL','REFERRAL','REVIEW','RENEWAL','CLAIM','PLACEMENT','COMPLIANCE')),
  priority      text not null default 'MEDIUM' check (priority in ('LOW','MEDIUM','HIGH','URGENT')),
  status        text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED')),
  assignee      uuid references app_user(id) on delete set null,
  due_at        timestamptz,
  entity_type   text,                       -- e.g. 'submission', 'claim', 'party'
  entity_id     uuid,
  entity_label  text,                       -- denormalised for display
  created_by    uuid references app_user(id) on delete set null,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists task_tenant_status_idx on task (tenant_id, status, due_at);
create index if not exists task_assignee_idx on task (tenant_id, assignee, status);

do $$
begin
  execute 'alter table task enable row level security';
  begin execute 'create policy tenant_isolation on task using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on task to rios_app;
