-- 0048_facultative_admin.sql
--
-- Facultative Administration depth (brief §7). An enterprise facultative
-- workspace on top of the existing `risk` table: market quotes from reinsurers
-- (for quote comparison), placement lines (lead / follow / coinsurance / retro
-- shares that build the signed order), and engineering / inspection reports.
-- Additive + idempotent. RLS enable-only (rios_app enforced; owner exempt).

create table if not exists fac_quote (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id) on delete cascade,
  risk_id            uuid not null references risk(id) on delete cascade,
  reinsurer_party_id uuid references party(id) on delete set null,
  reinsurer_name     text,
  share_pct          numeric(6,3) not null default 0,
  premium_minor      bigint not null default 0,
  rate_pct           numeric(10,6),
  status             text not null default 'QUOTED'
                     check (status in ('PENDING','QUOTED','ACCEPTED','DECLINED','EXPIRED')),
  valid_until        date,
  note               text,
  created_at         timestamptz not null default now()
);
create index if not exists fac_quote_idx on fac_quote (tenant_id, risk_id);

create table if not exists fac_placement_line (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenant(id) on delete cascade,
  risk_id            uuid not null references risk(id) on delete cascade,
  reinsurer_party_id uuid references party(id) on delete set null,
  reinsurer_name     text,
  kind               text not null default 'FOLLOW'
                     check (kind in ('LEAD','FOLLOW','COINSURANCE','RETRO')),
  written_pct        numeric(6,3) not null default 0,
  signed_pct         numeric(6,3) not null default 0,
  premium_minor      bigint not null default 0,
  status             text not null default 'WRITTEN'
                     check (status in ('OFFERED','WRITTEN','SIGNED')),
  created_at         timestamptz not null default now()
);
create index if not exists fac_placement_line_idx on fac_placement_line (tenant_id, risk_id);

create table if not exists fac_engineering (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  risk_id       uuid not null references risk(id) on delete cascade,
  kind          text not null default 'ENGINEERING'
                check (kind in ('ENGINEERING','INSPECTION','SURVEY','VALUATION')),
  inspector     text,
  risk_grade    text check (risk_grade in ('LOW','MODERATE','ELEVATED','HIGH','SEVERE')),
  findings      text,
  inspected_on  date,
  created_at    timestamptz not null default now()
);
create index if not exists fac_engineering_idx on fac_engineering (tenant_id, risk_id);

do $$
declare t text;
begin
  foreach t in array array['fac_quote','fac_placement_line','fac_engineering']
  loop
    execute format('alter table %I enable row level security', t);
    begin execute format('create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    exception when duplicate_object then null; end;
    execute format('grant select, insert, update, delete on %I to rios_app', t);
  end loop;
end$$;
