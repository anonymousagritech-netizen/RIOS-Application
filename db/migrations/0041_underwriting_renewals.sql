-- 0041_underwriting_renewals.sql
--
-- Renewal linkage on submissions (brief §7 / §28.8). A submission may renew a
-- prior submission; the expiring premium lets the renewal engine compute rate
-- change and portfolio retention. Additive + idempotent.
alter table submission add column if not exists renewal_of_id uuid references submission(id) on delete set null;
alter table submission add column if not exists expiring_premium_minor bigint;
create index if not exists submission_renewal_idx on submission (tenant_id, renewal_of_id);
