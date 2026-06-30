-- =============================================================================
-- RIOS — Migration 0010: Bordereaux ingestion (premium & loss)
-- Brief §7.10, §9.6, §29.6 — mapped, validated ingestion → Financial Events / Losses
-- =============================================================================

-- A reusable column mapping from a source file layout to RIOS fields (§10 — config).
create table bordereau_mapping (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  kind          text not null check (kind in ('PREMIUM','LOSS')),
  -- { "sourceColumn": "targetField", ... } plus type/transform metadata
  mapping       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (tenant_id, name)
);

-- An ingested bordereau file (header). Lines are validated; valid ones convert
-- to Financial Events (premium) or Claims/loss events (§29.6).
create table bordereau (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  contract_id   uuid references contract(id) on delete set null,
  programme_id  uuid references programme(id) on delete set null,
  mapping_id    uuid references bordereau_mapping(id),
  kind          text not null check (kind in ('PREMIUM','LOSS')),
  reference     text,
  period_start  date,
  period_end    date,
  currency      char(3),
  status        citext not null default 'UPLOADED',  -- UPLOADED/VALIDATED/REJECTED/PROCESSED
  row_count     int not null default 0,
  error_count   int not null default 0,
  total_minor   bigint not null default 0,
  uploaded_by   uuid references app_user(id),
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);
create index on bordereau (tenant_id, status);
create index on bordereau (tenant_id, contract_id);

-- One row of a bordereau, with its raw payload, validation result, and the
-- financial_event it produced (if any). Partition-ready for large files (§16.2).
create table bordereau_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  bordereau_id  uuid not null references bordereau(id) on delete cascade,
  line_no       int not null,
  raw           jsonb not null default '{}'::jsonb,
  mapped        jsonb not null default '{}'::jsonb,
  amount_minor  bigint,
  currency      char(3),
  is_valid      boolean not null default false,
  errors        jsonb not null default '[]'::jsonb,
  financial_event_id uuid references financial_event(id) on delete set null,
  claim_id      uuid references claim(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (bordereau_id, line_no)
);
create index on bordereau_line (tenant_id, bordereau_id) where not is_valid;

do $$
declare t text;
begin
  foreach t in array array['bordereau_mapping','bordereau','bordereau_line'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());', t);
  end loop;
end$$;
