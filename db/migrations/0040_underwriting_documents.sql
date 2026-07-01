-- 0040_underwriting_documents.sql
--
-- Underwriting data room: documents attached to a submission (slip, SOV, loss
-- run, wording, financials, bordereau, correspondence). This is a versioned
-- register with an extraction record and a lightweight signature seal - the
-- blob itself lives in object storage (an integration point; storage_ref holds
-- the pointer). Superseding a document chains versions via supersedes_id.
-- The domain @rios/domain underwritingDocuments describes the kinds, the
-- extraction shape and the version/signature helpers.
-- RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

create table if not exists submission_document (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  submission_id uuid not null references submission(id) on delete cascade,
  name          text not null,
  kind          text not null default 'OTHER'
                check (kind in ('SLIP','SOV','LOSS_RUN','WORDING','FINANCIALS','EMAIL','BORDEREAU','OTHER')),
  version       integer not null default 1,
  mime          text,
  size_bytes    bigint,
  storage_ref   text,                       -- object-store pointer (integration point)
  status        text not null default 'RECEIVED'
                check (status in ('RECEIVED','EXTRACTED','REVIEWED','SIGNED','SUPERSEDED')),
  extraction    jsonb,                       -- ExtractionResult from the OCR/AI provider
  supersedes_id uuid references submission_document(id) on delete set null,
  signature     text,                        -- signature digest when signed
  signed_by     uuid references app_user(id) on delete set null,
  signed_at     timestamptz,
  uploaded_by   uuid references app_user(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists submission_document_idx on submission_document (tenant_id, submission_id, created_at desc);

do $$
begin
  execute 'alter table submission_document enable row level security';
  begin execute 'create policy tenant_isolation on submission_document using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on submission_document to rios_app;
