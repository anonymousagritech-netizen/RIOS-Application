-- =============================================================================
-- RIOS — Migration 0007: Immutable audit log
-- Brief §4.3 (auditable & reversible), §14.3 (immutable audit), §9.2
-- =============================================================================
-- Every material action is attributable (who/what/when/before/after). The log is
-- append-only; a hash chain makes tampering evident (§14.3 "tamper-evident").

create table audit_log (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid,
  actor_label   text,                         -- denormalised for fast display
  action        text not null,                -- 'create','update','delete','post','bind','confirm', …
  entity_type   text not null,                -- 'contract','claim','financial_event', …
  entity_id     uuid,
  -- before/after snapshots (null where not applicable)
  before        jsonb,
  after         jsonb,
  -- request context for forensics
  context       jsonb not null default '{}'::jsonb,  -- ip, user agent, request id, assistant?=true
  -- tamper-evidence: hash of (prev_hash || this row's canonical content)
  prev_hash     bytea,
  row_hash      bytea
);

create index on audit_log (tenant_id, occurred_at desc);
create index on audit_log (tenant_id, entity_type, entity_id);
create index on audit_log (tenant_id, actor_user_id);

comment on table audit_log is
  'Append-only, tamper-evident audit trail. No UPDATE/DELETE is granted to the app role (see 0008_rls). The hash chain lets an auditor detect any retro-active edit (§14.3).';

-- Outbox for reliable event publication tied to the local transaction (§9.3, §15.2).
create table outbox (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null,
  topic         text not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  published_at  timestamptz,
  attempts      int not null default 0
);

create index on outbox (published_at) where published_at is null;
