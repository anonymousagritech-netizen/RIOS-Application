-- =============================================================================
-- RIOS — Migration 0028: Messaging & integration (brief §3, §12)
-- Transactional outboxes for outbound messages (email/SMS) and domain events
-- (the event bus), a connector registry, and developer-portal API keys. The
-- delivery/relay mechanics are real and tested in-process; the production sinks
-- (SMTP/SMS gateway, Kafka) are provider-configured — see docs/open-questions.md.
-- =============================================================================

-- Outbound message outbox (email + SMS share one table by channel).
create table message_outbox (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  channel     text not null check (channel in ('email','sms')),
  to_addr     text not null,
  subject     text,
  body        text not null,
  status      text not null default 'queued' check (status in ('queued','sent','failed')),
  provider    text,
  error       text,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index on message_outbox (tenant_id, status, created_at);

-- Transactional event outbox (the event bus / outbox pattern).
create table event_outbox (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  event_type    text not null,
  aggregate_type text,
  aggregate_id  uuid,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending' check (status in ('pending','published')),
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);
create index on event_outbox (tenant_id, status, created_at);

-- A registered connector (REST/SFTP/Kafka/webhook).
create table connector (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  key         citext not null,
  name        text not null,
  kind        text not null check (kind in ('rest','sftp','kafka','webhook')),
  config      jsonb not null default '{}'::jsonb,
  enabled     boolean not null default true,
  last_status text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);
create index on connector (tenant_id) where enabled;

-- Developer-portal API keys (only a hash + prefix are stored).
create table api_key (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  name        text not null,
  prefix      text not null,
  key_hash    text not null,
  scopes      text[] not null default '{}',
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index on api_key (tenant_id) where revoked_at is null;

do $$
declare t text;
begin
  foreach t in array array['message_outbox','event_outbox','connector','api_key'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
