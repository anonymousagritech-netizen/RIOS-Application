-- 0044_notifications.sql
--
-- Enrich the existing in-app notification table (migration 0012) with a kind,
-- severity and deep link so platform events (referrals, SLA breaches, tasks,
-- claims) render as a proper notification centre. Additive + idempotent.

alter table notification add column if not exists kind     text not null default 'SYSTEM';
alter table notification add column if not exists severity text not null default 'INFO';
alter table notification add column if not exists link     text;

do $$
begin
  begin alter table notification add constraint notification_kind_chk
    check (kind in ('SYSTEM','REFERRAL','SLA','TASK','CLAIM','RENEWAL','FINANCE'));
  exception when duplicate_object then null; end;
  begin alter table notification add constraint notification_severity_chk
    check (severity in ('INFO','WARNING','CRITICAL'));
  exception when duplicate_object then null; end;
end$$;
