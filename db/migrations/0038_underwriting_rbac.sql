-- 0038_underwriting_rbac.sql
--
-- Role-based authorization for the underwriting module (brief §5 / §28.5). Adds
-- the underwriting permission vocabulary and the senior underwriting role
-- hierarchy (Chief / Senior Underwriter, Actuary). Additive + idempotent: it
-- neither drops data nor re-seeds, so it is safe to apply to a live database.
--
-- Only underwriting:approve is enforced in code today (the approval matrix gates
-- quoting/binding a HIGH-risk or large-limit submission); the rest are the
-- forward vocabulary the UI and future endpoints check against.

insert into permission (code, module, action, description) values
  ('underwriting:read',    'underwriting', 'read',    'View underwriting submissions & analytics'),
  ('underwriting:write',   'underwriting', 'write',   'Create & progress underwriting submissions'),
  ('underwriting:price',   'underwriting', 'price',   'Run technical pricing & scenarios'),
  ('underwriting:approve', 'underwriting', 'approve', 'Approve high-risk / large-limit quotes & binds (senior/chief)')
on conflict (code) do nothing;

-- New underwriting roles for every tenant.
insert into role (tenant_id, code, name, is_system)
select t.id, v.code, v.name, true
from tenant t
cross join (values
  ('CHIEF_UW',  'Chief Underwriter'),
  ('SENIOR_UW', 'Senior Underwriter'),
  ('ACTUARY',   'Actuary')
) as v(code, name)
on conflict (tenant_id, code) do nothing;

-- ADMIN keeps everything (the seed's cross-join ran before these permissions
-- existed, so grant the new codes explicitly).
insert into role_permission (tenant_id, role_id, permission)
select r.tenant_id, r.id, p.code
from role r cross join permission p
where r.code = 'ADMIN' and p.code like 'underwriting:%'
on conflict do nothing;

-- Chief & Senior Underwriter: full underwriting incl. approval + treaty bind.
insert into role_permission (tenant_id, role_id, permission)
select r.tenant_id, r.id, p.code
from role r join permission p on p.code in
  ('config:read','party:read','treaty:read','treaty:write','treaty:bind','accounting:read','claims:read',
   'reporting:read','underwriting:read','underwriting:write','underwriting:price','underwriting:approve')
where r.code in ('CHIEF_UW','SENIOR_UW')
on conflict do nothing;

-- Actuary: read + pricing/scenarios, no bind or approval authority.
insert into role_permission (tenant_id, role_id, permission)
select r.tenant_id, r.id, p.code
from role r join permission p on p.code in
  ('config:read','party:read','treaty:read','accounting:read','reporting:read',
   'underwriting:read','underwriting:price')
where r.code = 'ACTUARY'
on conflict do nothing;

-- The existing Treaty Underwriter gains underwriting read/write/price - but NOT
-- approve, so binds of HIGH-risk / large-limit business must be referred up.
insert into role_permission (tenant_id, role_id, permission)
select r.tenant_id, r.id, p.code
from role r join permission p on p.code in
  ('underwriting:read','underwriting:write','underwriting:price')
where r.code = 'TREATY_UW'
on conflict do nothing;
