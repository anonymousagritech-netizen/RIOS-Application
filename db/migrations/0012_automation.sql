-- =============================================================================
-- RIOS - Migration 0012: Workflow, Rules, Approval & Notification engines
-- Brief §9.3, §10.3 - metadata-driven process & automation (definitions live in
-- config_document; this migration holds the runtime instance/state tables)
-- =============================================================================

-- A running instance of a workflow definition (config_document kind='workflow').
create table workflow_instance (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  workflow_key  citext not null,               -- references config_document.key
  workflow_version int not null default 1,
  entity_type   text not null,                 -- 'contract','claim','statement', …
  entity_id     uuid,
  current_state text not null,
  status        text not null default 'running' check (status in ('running','completed','cancelled','error')),
  context       jsonb not null default '{}'::jsonb,
  started_by    uuid references app_user(id),
  started_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index on workflow_instance (tenant_id, entity_type, entity_id);
create index on workflow_instance (tenant_id, status);

-- A task within a workflow instance (assignment, due date, completion).
create table workflow_task (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  instance_id   uuid not null references workflow_instance(id) on delete cascade,
  name          text not null,
  assignee_user_id uuid references app_user(id),
  assignee_role citext,
  status        text not null default 'pending' check (status in ('pending','in_progress','done','skipped')),
  due_at        timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index on workflow_task (tenant_id, instance_id);
create index on workflow_task (tenant_id, status) where status <> 'done';

-- Maker-checker / four-eyes approval requests (§14.1, §12.6).
create table approval_request (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  entity_type   text not null,
  entity_id     uuid,
  action        text not null,                 -- e.g. 'bind','post','commute'
  requested_by  uuid references app_user(id),
  -- the change being approved, for the reviewer to see exactly what will happen (§4.3)
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  decided_by    uuid references app_user(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create index on approval_request (tenant_id, status);

-- A configurable business rule (definition in config_document kind='rule'); this
-- table records evaluations for audit/explainability.
create table rule_evaluation (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  rule_key      citext not null,
  entity_type   text,
  entity_id     uuid,
  passed        boolean not null,
  detail        jsonb not null default '{}'::jsonb,
  evaluated_at  timestamptz not null default now()
);
create index on rule_evaluation (tenant_id, rule_key);

-- Notifications (in-app/email/SMS) produced by the notification engine.
create table notification (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  recipient_user_id uuid references app_user(id),
  channel       text not null default 'in_app' check (channel in ('in_app','email','sms')),
  subject       text,
  body          text,
  entity_type   text,
  entity_id     uuid,
  is_read       boolean not null default false,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index on notification (tenant_id, recipient_user_id, is_read);

do $$
declare t text;
begin
  foreach t in array array['workflow_instance','workflow_task','approval_request','rule_evaluation','notification'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
