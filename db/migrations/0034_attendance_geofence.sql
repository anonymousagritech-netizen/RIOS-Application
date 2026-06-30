-- 0034_attendance_geofence.sql
--
-- Geofenced attendance: office locations (lat/lng + radius + tolerance buffer)
-- and the captured punch coordinates / geofence result on each attendance row.
-- RLS enable-only (rios_app enforced; non-superuser owner exempt, per 0031).

create table if not exists office_location (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  name          text not null,
  latitude      double precision not null,
  longitude     double precision not null,
  radius_meters integer not null default 150,
  buffer_meters integer not null default 50,
  address       text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists office_location_tenant_idx on office_location (tenant_id) where is_active;

alter table attendance_record add column if not exists punch_in_lat   double precision;
alter table attendance_record add column if not exists punch_in_lng   double precision;
alter table attendance_record add column if not exists punch_out_lat  double precision;
alter table attendance_record add column if not exists punch_out_lng  double precision;
alter table attendance_record add column if not exists geofence_ok    boolean;
alter table attendance_record add column if not exists punch_in_distance_m integer;

do $$
begin
  execute 'alter table office_location enable row level security';
  begin execute 'create policy tenant_isolation on office_location using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  exception when duplicate_object then null; end;
end$$;

grant select, insert, update, delete on office_location to rios_app;
