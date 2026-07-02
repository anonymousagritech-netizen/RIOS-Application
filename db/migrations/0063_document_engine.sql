-- 0063_document_engine.sql
--
-- Enterprise Document Engine: real file storage, versioning, categories,
-- cross-entity linking, an approval workflow, search, and a configurable
-- per-record attachment limit. Extends the template-only `document` module
-- (migrations 0013/0014) without breaking the existing template columns.
--
-- Binary payloads are stored as base64 text (`content_base64`) - simple,
-- JSON-friendly, and adequate for a foundation slice; a production build
-- would swap this for object storage behind the same API. Additive +
-- idempotent. RLS: tenant_isolation policy + rios_app grants on new tables.

-- ---------------------------------------------------------------------------
-- Extend `document` (head row) with real-file + workflow metadata.
-- ---------------------------------------------------------------------------
alter table document add column if not exists file_name       text;
alter table document add column if not exists mime_type       text;
alter table document add column if not exists size_bytes      bigint;
alter table document add column if not exists content_base64  text;
alter table document add column if not exists category        text;
alter table document add column if not exists ocr_text        text;
alter table document add column if not exists extraction      jsonb not null default '{}'::jsonb;
alter table document add column if not exists doc_status      text not null default 'UPLOADED';
alter table document add column if not exists current_version int not null default 1;
alter table document add column if not exists checksum        text;
alter table document add column if not exists uploaded_by     uuid;
alter table document add column if not exists tags            text[];

-- Guard the workflow states with a named check (idempotent add).
do $$
begin
  alter table document add constraint document_doc_status_chk
    check (doc_status in ('DRAFT','UPLOADED','REVIEWED','APPROVED','LOCKED','ARCHIVED'));
exception when duplicate_object then null;
end$$;

create index if not exists document_category_idx on document (tenant_id, category);
create index if not exists document_doc_status_idx on document (tenant_id, doc_status);

-- ---------------------------------------------------------------------------
-- Version history: every upload/replace appends an immutable row.
-- ---------------------------------------------------------------------------
create table if not exists document_version (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  document_id    uuid not null references document(id) on delete cascade,
  version        int not null,
  file_name      text,
  mime_type      text,
  size_bytes     bigint,
  content_base64 text,
  ocr_text       text,
  extraction     jsonb not null default '{}'::jsonb,
  change_summary text,
  uploaded_by    uuid,
  created_at     timestamptz not null default now(),
  unique (tenant_id, document_id, version)
);
create index if not exists document_version_idx on document_version (tenant_id, document_id, version desc);

-- ---------------------------------------------------------------------------
-- Cross-entity links: one document reused across many records, no duplication.
-- ---------------------------------------------------------------------------
create table if not exists document_link (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  document_id uuid not null references document(id) on delete cascade,
  entity_type text not null,
  entity_id   uuid not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (tenant_id, document_id, entity_type, entity_id)
);
create index if not exists document_link_entity_idx on document_link (tenant_id, entity_type, entity_id);
create index if not exists document_link_doc_idx on document_link (tenant_id, document_id);

-- ---------------------------------------------------------------------------
-- Generic per-tenant settings. Nothing seeded; code applies defaults when the
-- row is absent (e.g. maxAttachmentsPerRecord defaults to 10).
-- ---------------------------------------------------------------------------
create table if not exists app_setting (
  tenant_id  uuid not null references tenant(id) on delete cascade,
  key        text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- ---------------------------------------------------------------------------
-- RLS + rios_app grants on the new tables (owner remains exempt).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['document_version','document_link','app_setting'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    begin
      execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
