-- =============================================================================
-- RIOS - Migration 0080: Bureau / ACORD message store (brief §7, §28 - market
-- connectivity). Moves bureau messaging from Designed-for to Delivered:
--   * bureau_message - one row per ACORD EBOT/ECOT message exchanged with the
--     London-market / DXC bureau network. Outbound messages are built in the
--     pure @rios/domain acord engine from a statement (EBOT) or claim (ECOT),
--     validated, canonically serialized and persisted here with their status.
--   * The default in-repo connector is a *loopback* transport: it acknowledges
--     an outbound message and can echo it back inbound so the round trip is
--     demonstrable without a live DXC credential. A real bureau adapter writes
--     here with its own external_ref/source behind the same BureauConnector
--     interface.
-- Money lives on the linked statement/claim; this table stores the message
-- envelope (payload jsonb) and lifecycle only. Additive + idempotent. RLS
-- enable-only (rios_app enforced via tenant_isolation; owner exempt).
-- =============================================================================

create table if not exists bureau_message (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  direction      text not null check (direction in ('OUTBOUND','INBOUND')),
  message_type   text not null check (message_type in ('EBOT','ECOT')),
  uti            text not null,                       -- unique transaction reference
  umr            text,                                -- unique market reference (slip)
  -- the canonical ACORD envelope produced by @rios/domain serializeAcord
  payload        jsonb not null,
  status         text not null default 'BUILT'
                   check (status in ('BUILT','SENT','ACKNOWLEDGED','RECEIVED','REJECTED')),
  external_ref   text,                                -- bureau/DXC reference on ack
  connector      text not null default 'LOOPBACK',    -- which adapter transported it
  errors         text,                                -- validation errors if REJECTED
  statement_id   uuid references statement_of_account(id) on delete set null,
  claim_id       uuid references claim(id) on delete set null,
  created_by     uuid references app_user(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists bureau_message_idx on bureau_message (tenant_id, status, created_at desc);
create index if not exists bureau_message_type_idx on bureau_message (tenant_id, message_type, direction);
create index if not exists bureau_message_uti_idx on bureau_message (tenant_id, uti);

do $$
declare t text;
begin
  foreach t in array array['bureau_message']
  loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
