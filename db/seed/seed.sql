-- =============================================================================
-- RIOS — Seed data: a demonstrable tenant with the vertical slice populated
-- Brief §24.1 (realistic test data spanning treaty, fac, retro, accounting, claims)
-- =============================================================================
-- Idempotent-ish: safe to run on a freshly migrated database. Uses a fixed tenant
-- id so the demo login and API examples are stable. Passwords are hashed with
-- pgcrypto bcrypt; the server verifies via crypt() so seed and app agree.

\set tenant_id '11111111-1111-1111-1111-111111111111'

begin;

-- ---------------------------------------------------------------------------
-- Tenant & users
-- ---------------------------------------------------------------------------
insert into tenant (id, code, name, default_currency, default_locale)
values (:'tenant_id'::uuid, 'demo', 'Demo Reinsurance Co.', 'USD', 'en-US')
on conflict (id) do nothing;

insert into app_user (tenant_id, email, display_name, password_hash)
values
  (:'tenant_id'::uuid, 'admin@demo.rios', 'Demo Administrator', crypt('demo1234', gen_salt('bf'))),
  (:'tenant_id'::uuid, 'uw@demo.rios',    'Tara Underwood (Treaty UW)', crypt('demo1234', gen_salt('bf'))),
  (:'tenant_id'::uuid, 'acct@demo.rios',  'Alan Counts (Tech Accountant)', crypt('demo1234', gen_salt('bf'))),
  (:'tenant_id'::uuid, 'claims@demo.rios','Carla Mims (Claims)', crypt('demo1234', gen_salt('bf'))),
  (:'tenant_id'::uuid, 'broker@demo.rios','Morgan Vale (Meridian Brokers)', crypt('demo1234', gen_salt('bf'))),
  (:'tenant_id'::uuid, 'cedent@demo.rios','Priya Rao (Atlantic Mutual)', crypt('demo1234', gen_salt('bf')))
on conflict (tenant_id, email) do nothing;

-- ---------------------------------------------------------------------------
-- Permissions catalog (global) & roles
-- ---------------------------------------------------------------------------
insert into permission (code, module, action, description) values
  ('admin:manage',     'admin',      'manage', 'Full administration & configuration'),
  ('config:read',      'config',     'read',   'Read configuration / reference data'),
  ('config:write',     'config',     'write',  'Change configuration / reference data'),
  ('party:read',       'party',      'read',   'View parties'),
  ('party:write',      'party',      'write',  'Create / edit parties'),
  ('treaty:read',      'treaty',     'read',   'View treaties & contracts'),
  ('treaty:write',     'treaty',     'write',  'Create / edit treaties & contracts'),
  ('treaty:bind',      'treaty',     'bind',   'Bind a contract (state transition)'),
  ('accounting:read',  'accounting', 'read',   'View accounting'),
  ('accounting:post',  'accounting', 'post',   'Post journals / generate statements'),
  ('claims:read',      'claims',     'read',   'View claims'),
  ('claims:write',     'claims',     'write',  'Register / edit claims & reserves'),
  ('facultative:read', 'facultative','read',   'View facultative business'),
  ('facultative:write','facultative','write',  'Cede / accept facultative risks'),
  ('retro:read',       'retrocession','read',  'View retrocession & net position'),
  ('retro:write',      'retrocession','write', 'Create retrocession contracts'),
  ('placement:read',   'placement',  'read',   'View slips & market lines'),
  ('placement:write',  'placement',  'write',  'Author slips, write lines, sign down'),
  ('pricing:read',     'pricing',    'read',   'View rating runs'),
  ('pricing:write',    'pricing',    'write',  'Run pricing / rating'),
  ('bordereaux:read',  'bordereaux', 'read',   'View bordereaux'),
  ('bordereaux:write', 'bordereaux', 'write',  'Upload / process bordereaux'),
  ('exposure:read',    'exposure',   'read',   'View exposure & aggregates'),
  ('exposure:write',   'exposure',   'write',  'Manage accumulations & exposure'),
  ('statement:read',   'statement',  'read',   'View statements of account'),
  ('statement:write',  'statement',  'write',  'Generate / progress statements'),
  ('finance:read',     'finance',    'read',   'View GL / AR / AP / cash'),
  ('finance:post',     'finance',    'post',   'Record cash / reconcile'),
  ('regulatory:read',  'regulatory', 'read',   'View IFRS 17 / Solvency II'),
  ('regulatory:run',   'regulatory', 'run',    'Run regulatory measurements'),
  ('workflow:read',    'workflow',   'read',   'View workflow / approvals / notifications'),
  ('workflow:write',   'workflow',   'write',  'Drive workflow & approvals'),
  ('approval:decide',  'approval',   'decide', 'Approve / reject requests'),
  ('documents:read',   'documents',  'read',   'View documents & templates'),
  ('documents:write',  'documents',  'write',  'Author templates & generate documents'),
  ('reporting:read',   'reporting',  'read',   'View & run reports'),
  ('reporting:write',  'reporting',  'write',  'Author report definitions'),
  ('crm:read',         'crm',        'read',   'View CRM activity & pipeline'),
  ('crm:write',        'crm',        'write',  'Manage CRM activity & opportunities'),
  ('integration:read', 'integration','read',   'View integrations & exports'),
  ('integration:write','integration','write',  'Manage webhooks & data import/export'),
  ('hr:read',          'hr',         'read',   'View HR (employees, departments, leave)'),
  ('hr:write',         'hr',         'write',  'Manage HR records & approve leave'),
  ('procurement:read', 'procurement','read',   'View procurement (vendors, POs)'),
  ('procurement:write','procurement','write',  'Manage requisitions & purchase orders'),
  ('asset:read',       'asset',      'read',   'View assets, licenses & entitlements'),
  ('asset:write',      'asset',      'write',  'Manage assets, licenses & entitlements'),
  ('ops:read',         'ops',        'read',   'View operations, audit & SLA'),
  ('ops:write',        'ops',        'write',  'Manage SLA targets & operations'),
  ('portal:read',      'portal',     'read',   'Access an external counterparty portal'),
  ('treasury:read',    'treasury',   'read',   'View investments, treasury & tax levies'),
  ('treasury:write',   'treasury',   'write',  'Manage investments & tax levy configuration'),
  ('risk:read',        'risk',       'read',   'View risk & capital, RDS scenarios'),
  ('risk:write',       'risk',       'write',  'Manage capital positions & RDS scenarios'),
  ('retention:read',   'retention',  'read',   'View retention policies & legal holds'),
  ('retention:write',  'retention',  'write',  'Manage retention policies & legal holds'),
  ('pii:view',         'pii',        'view',   'View unmasked PII / sensitive fields'),
  ('fls:write',        'fls',        'write',  'Manage field-level security policies'),
  ('product:read',     'product',    'read',   'View insurance products'),
  ('product:write',    'product',    'write',  'Author products & drive lifecycle'),
  ('platform:read',    'platform',   'read',   'View companies, offices, feature flags'),
  ('platform:write',   'platform',   'write',  'Manage companies, offices, feature flags'),
  ('cost:read',        'cost',       'read',   'View cost & capacity'),
  ('cost:write',       'cost',       'write',  'Manage cost & capacity records')
on conflict (code) do nothing;

insert into role (tenant_id, code, name, is_system) values
  (:'tenant_id'::uuid, 'ADMIN',   'Administrator', true),
  (:'tenant_id'::uuid, 'TREATY_UW', 'Treaty Underwriter', true),
  (:'tenant_id'::uuid, 'ACCOUNTANT', 'Technical Accountant', true),
  (:'tenant_id'::uuid, 'CLAIMS', 'Claims Handler', true),
  (:'tenant_id'::uuid, 'PORTAL', 'External Portal User', true)
on conflict (tenant_id, code) do nothing;

-- Admin gets everything
insert into role_permission (tenant_id, role_id, permission)
select :'tenant_id'::uuid, r.id, p.code
from role r cross join permission p
where r.tenant_id = :'tenant_id'::uuid and r.code = 'ADMIN'
on conflict do nothing;

-- Treaty UW
insert into role_permission (tenant_id, role_id, permission)
select :'tenant_id'::uuid, r.id, p.code
from role r join permission p on p.code in
  ('config:read','party:read','treaty:read','treaty:write','treaty:bind','accounting:read','claims:read')
where r.tenant_id = :'tenant_id'::uuid and r.code = 'TREATY_UW'
on conflict do nothing;

-- Accountant
insert into role_permission (tenant_id, role_id, permission)
select :'tenant_id'::uuid, r.id, p.code
from role r join permission p on p.code in
  ('config:read','party:read','treaty:read','accounting:read','accounting:post')
where r.tenant_id = :'tenant_id'::uuid and r.code = 'ACCOUNTANT'
on conflict do nothing;

-- Claims
insert into role_permission (tenant_id, role_id, permission)
select :'tenant_id'::uuid, r.id, p.code
from role r join permission p on p.code in
  ('config:read','party:read','treaty:read','claims:read','claims:write','accounting:read')
where r.tenant_id = :'tenant_id'::uuid and r.code = 'CLAIMS'
on conflict do nothing;

-- Portal (external counterparty): only the portal projection endpoints; the
-- portal_grant rows further restrict every read to a single party.
insert into role_permission (tenant_id, role_id, permission)
select :'tenant_id'::uuid, r.id, p.code
from role r join permission p on p.code in ('portal:read')
where r.tenant_id = :'tenant_id'::uuid and r.code = 'PORTAL'
on conflict do nothing;

-- Assign roles to the demo users
insert into user_role (tenant_id, user_id, role_id)
select :'tenant_id'::uuid, u.id, r.id from app_user u join role r on r.tenant_id = u.tenant_id
where u.tenant_id = :'tenant_id'::uuid and (
  (u.email='admin@demo.rios'  and r.code='ADMIN') or
  (u.email='uw@demo.rios'     and r.code='TREATY_UW') or
  (u.email='acct@demo.rios'   and r.code='ACCOUNTANT') or
  (u.email='claims@demo.rios' and r.code='CLAIMS') or
  (u.email='broker@demo.rios' and r.code='PORTAL') or
  (u.email='cedent@demo.rios' and r.code='PORTAL'))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Currencies
-- ---------------------------------------------------------------------------
insert into currency (tenant_id, code, name, minor_units, symbol) values
  (:'tenant_id'::uuid,'USD','US Dollar',2,'$'),
  (:'tenant_id'::uuid,'EUR','Euro',2,'€'),
  (:'tenant_id'::uuid,'GBP','Pound Sterling',2,'£'),
  (:'tenant_id'::uuid,'JPY','Japanese Yen',0,'¥')
on conflict do nothing;

insert into exchange_rate (tenant_id, from_ccy, to_ccy, rate, rate_date) values
  (:'tenant_id'::uuid,'EUR','USD',1.08,current_date),
  (:'tenant_id'::uuid,'GBP','USD',1.27,current_date)
on conflict do nothing;

insert into numbering_scheme (tenant_id, key, pattern) values
  (:'tenant_id'::uuid,'treaty_reference','TRTY-{YYYY}-{SEQ:5}'),
  (:'tenant_id'::uuid,'facultative_reference','FAC-{YYYY}-{SEQ:5}'),
  (:'tenant_id'::uuid,'retrocession_reference','RETRO-{YYYY}-{SEQ:5}'),
  (:'tenant_id'::uuid,'slip_reference','SLIP-{YYYY}-{SEQ:5}'),
  (:'tenant_id'::uuid,'claim_reference','CLM-{YYYY}-{SEQ:6}'),
  (:'tenant_id'::uuid,'statement_reference','SOA-{YYYY}-{SEQ:5}'),
  (:'tenant_id'::uuid,'employee_reference','EMP-{SEQ:5}'),
  (:'tenant_id'::uuid,'requisition_reference','REQ-{YYYY}-{SEQ:5}'),
  (:'tenant_id'::uuid,'po_reference','PO-{YYYY}-{SEQ:5}')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Code lists (the metadata-driven heart, §10)
-- ---------------------------------------------------------------------------
-- helper to insert a list + its values
create temporary table _cl(key text, name text, code text, label text, sort int, meta jsonb) on commit drop;

insert into _cl values
  ('contract_status','Contract Status','DRAFT','Draft',1,'{"color":"slate"}'),
  ('contract_status','Contract Status','QUOTED','Quoted',2,'{"color":"blue"}'),
  ('contract_status','Contract Status','PLACING','Placing',3,'{"color":"indigo"}'),
  ('contract_status','Contract Status','BOUND','Bound',4,'{"color":"violet"}'),
  ('contract_status','Contract Status','ACTIVE','Active',5,'{"color":"green"}'),
  ('contract_status','Contract Status','EXPIRING','Expiring',6,'{"color":"amber"}'),
  ('contract_status','Contract Status','RUNOFF','Run-off',7,'{"color":"orange"}'),
  ('contract_status','Contract Status','RENEWED','Renewed',8,'{"color":"teal"}'),
  ('contract_status','Contract Status','LAPSED','Lapsed',9,'{"color":"gray"}'),
  ('contract_status','Contract Status','COMMUTED','Commuted',10,'{"color":"rose"}'),
  ('contract_status','Contract Status','CANCELLED','Cancelled',11,'{"color":"red"}'),
  ('claim_status','Claim Status','NOTIFIED','Notified',1,'{"color":"blue"}'),
  ('claim_status','Claim Status','UNDER_REVIEW','Under Review',2,'{"color":"indigo"}'),
  ('claim_status','Claim Status','RESERVED','Reserved',3,'{"color":"violet"}'),
  ('claim_status','Claim Status','PART_PAID','Part-Paid',4,'{"color":"amber"}'),
  ('claim_status','Claim Status','SETTLED','Settled',5,'{"color":"green"}'),
  ('claim_status','Claim Status','RECOVERING','Recovering',6,'{"color":"teal"}'),
  ('claim_status','Claim Status','CLOSED','Closed',7,'{"color":"gray"}'),
  ('claim_status','Claim Status','REOPENED','Reopened',8,'{"color":"orange"}'),
  ('line_of_business','Line of Business','PROPERTY','Property',1,'{}'),
  ('line_of_business','Line of Business','CASUALTY','Casualty',2,'{}'),
  ('line_of_business','Line of Business','MARINE','Marine',3,'{}'),
  ('line_of_business','Line of Business','AVIATION','Aviation',4,'{}'),
  ('line_of_business','Line of Business','ENERGY','Energy',5,'{}'),
  ('line_of_business','Line of Business','MOTOR','Motor',6,'{}'),
  ('party_role','Party Role','cedent','Cedent',1,'{}'),
  ('party_role','Party Role','reinsurer','Reinsurer',2,'{}'),
  ('party_role','Party Role','retrocessionaire','Retrocessionaire',3,'{}'),
  ('party_role','Party Role','broker','Broker',4,'{}'),
  ('party_role','Party Role','coverholder','Coverholder',5,'{}'),
  ('financial_event_type','Financial Event Type','DEPOSIT_PREMIUM','Deposit Premium',1,'{"dir":"DR"}'),
  ('financial_event_type','Financial Event Type','INSTALMENT_PREMIUM','Instalment Premium',2,'{"dir":"DR"}'),
  ('financial_event_type','Financial Event Type','ADJUSTMENT_PREMIUM','Adjustment Premium',3,'{"dir":"DR"}'),
  ('financial_event_type','Financial Event Type','REINSTATEMENT_PREMIUM','Reinstatement Premium',4,'{"dir":"DR"}'),
  ('financial_event_type','Financial Event Type','CEDING_COMMISSION','Ceding Commission',5,'{"dir":"CR"}'),
  ('financial_event_type','Financial Event Type','OVERRIDING_COMMISSION','Overriding Commission',6,'{"dir":"CR"}'),
  ('financial_event_type','Financial Event Type','PROFIT_COMMISSION','Profit Commission',7,'{"dir":"CR"}'),
  ('financial_event_type','Financial Event Type','BROKERAGE','Brokerage',8,'{"dir":"CR"}'),
  ('financial_event_type','Financial Event Type','TAX','Tax',9,'{"dir":"CR"}'),
  ('financial_event_type','Financial Event Type','PAID_LOSS','Paid Loss',10,'{"dir":"CR"}'),
  ('financial_event_type','Financial Event Type','RECOVERY','Recovery',11,'{"dir":"DR"}'),
  ('statement_status','Statement Status','OPEN','Open',1,'{"color":"slate"}'),
  ('statement_status','Statement Status','PREPARED','Prepared',2,'{"color":"blue"}'),
  ('statement_status','Statement Status','UNDER_REVIEW','Under Review',3,'{"color":"indigo"}'),
  ('statement_status','Statement Status','APPROVED','Approved',4,'{"color":"violet"}'),
  ('statement_status','Statement Status','ISSUED','Issued',5,'{"color":"amber"}'),
  ('statement_status','Statement Status','SETTLED','Settled',6,'{"color":"green"}'),
  ('statement_status','Statement Status','CLOSED','Closed',7,'{"color":"gray"}'),
  ('programme_status','Programme Status','OPEN','Open',1,'{"color":"blue"}'),
  ('programme_status','Programme Status','BOUND','Bound',2,'{"color":"green"}'),
  ('programme_status','Programme Status','CLOSED','Closed',3,'{"color":"gray"}');

-- materialise lists
insert into code_list (tenant_id, key, name, is_system)
select distinct :'tenant_id'::uuid, key, name, true from _cl
on conflict (tenant_id, key) do nothing;

insert into code_value (tenant_id, code_list_id, code, label, sort_order, meta)
select :'tenant_id'::uuid, cl.id, c.code, c.label, c.sort, c.meta
from _cl c join code_list cl on cl.tenant_id = :'tenant_id'::uuid and cl.key = c.key
on conflict (code_list_id, code, effective_from) do nothing;

-- ---------------------------------------------------------------------------
-- Designer surfaces: a published workflow definition & a business rule set
-- (§10.3). These live in config_document and are interpreted by @rios/domain.
-- ---------------------------------------------------------------------------
insert into config_document (tenant_id, kind, key, version, status, body)
values (:'tenant_id'::uuid, 'workflow', 'treaty.lifecycle', 1, 'published', jsonb_build_object(
  'key','treaty.lifecycle',
  'name','Treaty lifecycle',
  'initial','DRAFT',
  'states', jsonb_build_array('DRAFT','QUOTED','PLACING','BOUND','ACTIVE','CANCELLED'),
  'finalStates', jsonb_build_array('CANCELLED'),
  'transitions', jsonb_build_array(
    jsonb_build_object('event','quote','from','DRAFT','to','QUOTED','label','Quote'),
    jsonb_build_object('event','place','from','QUOTED','to','PLACING','label','Place'),
    jsonb_build_object('event','bind','from','PLACING','to','BOUND','permission','treaty:bind','label','Bind'),
    jsonb_build_object('event','activate','from','BOUND','to','ACTIVE','label','Activate'),
    jsonb_build_object('event','cancel','from','DRAFT','to','CANCELLED','label','Cancel'),
    jsonb_build_object('event','cancel','from','QUOTED','to','CANCELLED','label','Cancel')
  )))
on conflict (tenant_id, kind, key, version) do nothing;

insert into config_document (tenant_id, kind, key, version, status, body)
values (:'tenant_id'::uuid, 'rule', 'treaty.bind.guards', 1, 'published', jsonb_build_object(
  'key','treaty.bind.guards',
  'name','Treaty bind guards',
  'rules', jsonb_build_array(
    jsonb_build_object(
      'id','premium-required',
      'when', jsonb_build_object('field','premiumMinor','op','empty'),
      'then', jsonb_build_array(jsonb_build_object('type','error','message','Premium is required before binding.'))),
    jsonb_build_object(
      'id','large-line-referral',
      'when', jsonb_build_object('all', jsonb_build_array(
        jsonb_build_object('field','premiumMinor','op','gte','value',10000000),
        jsonb_build_object('field','lob','op','in','value', jsonb_build_array('PROPERTY','MARINE')))),
      'then', jsonb_build_array(
        jsonb_build_object('type','route','target','senior-uw'),
        jsonb_build_object('type','flag','target','large-line'))),
    jsonb_build_object(
      'id','default-brokerage',
      'when', jsonb_build_object('field','brokeragePct','op','empty'),
      'then', jsonb_build_array(jsonb_build_object('type','set','target','brokeragePct','value',10)))
  )))
on conflict (tenant_id, kind, key, version) do nothing;

-- ---------------------------------------------------------------------------
-- Parties (one entity can hold several roles — §7 implication)
-- ---------------------------------------------------------------------------
insert into party (tenant_id, reference, legal_name, short_name, kind, country, identifiers) values
  (:'tenant_id'::uuid,'PTY-0001','Atlantic Mutual Insurance Company','Atlantic Mutual','organisation','US','{"naic":"12345"}'),
  (:'tenant_id'::uuid,'PTY-0002','Helvetia Re AG','Helvetia Re','organisation','CH','{"lei":"5299000ABCDE"}'),
  (:'tenant_id'::uuid,'PTY-0003','Meridian Reinsurance Brokers Ltd','Meridian Brokers','organisation','GB','{}'),
  (:'tenant_id'::uuid,'PTY-0004','Coral Bay Captive Ltd','Coral Bay','captive','BM','{}'),
  (:'tenant_id'::uuid,'PTY-0005','Syndicate 4242','Synd 4242','syndicate','GB','{"lloyds_syndicate":"4242"}')
on conflict do nothing;

insert into party_role (tenant_id, party_id, role_code)
select :'tenant_id'::uuid, p.id, r.role_code from party p
cross join (values ('cedent'),('reinsurer'),('broker')) as r(role_code)
where p.tenant_id = :'tenant_id'::uuid and (
  (p.short_name='Atlantic Mutual' and r.role_code='cedent') or
  (p.short_name='Helvetia Re'     and r.role_code='reinsurer') or
  (p.short_name='Helvetia Re'     and r.role_code='cedent') or   -- also cedes its own retro
  (p.short_name='Meridian Brokers' and r.role_code='broker') or
  (p.short_name='Coral Bay'        and r.role_code='cedent') or
  (p.short_name='Synd 4242'        and r.role_code='reinsurer'))
on conflict do nothing;

-- Portal grants: bind the demo portal users to a party + portal surface.
insert into portal_grant (tenant_id, user_id, party_id, portal_type)
select :'tenant_id'::uuid, u.id, p.id, g.portal_type
from app_user u
  join party p on p.tenant_id = :'tenant_id'::uuid
  cross join (values
    ('broker@demo.rios','Meridian Brokers','broker'),
    ('cedent@demo.rios','Atlantic Mutual','cedent')
  ) as g(email, party_name, portal_type)
where u.tenant_id = :'tenant_id'::uuid
  and u.email = g.email and p.short_name = g.party_name
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- A sample treaty: Atlantic Mutual property CAT XL, placed via Meridian
-- ---------------------------------------------------------------------------
insert into programme (tenant_id, reference, name, cedent_party_id, period_start, period_end, currency, status)
select :'tenant_id'::uuid,'PRG-2026-001','Atlantic Mutual 2026 Property CAT Programme',
       p.id, date '2026-01-01', date '2026-12-31','USD','OPEN'
from party p where p.tenant_id=:'tenant_id'::uuid and p.short_name='Atlantic Mutual'
on conflict do nothing;

insert into contract (tenant_id, reference, name, contract_kind, basis, np_type, line_of_business,
                      direction, programme_id, cedent_party_id, broker_party_id, currency,
                      period_start, period_end, status, wording_ref)
select :'tenant_id'::uuid,'TRTY-2026-00001','Atlantic Mutual Property CAT XL 2026',
       'TREATY','NON_PROPORTIONAL','CAT_XL','PROPERTY','INWARDS',
       prg.id, ced.id, brk.id, 'USD', date '2026-01-01', date '2026-12-31','BOUND','MRC-2026-AMIC-CATXL'
from programme prg
  join party ced on ced.tenant_id=:'tenant_id'::uuid and ced.short_name='Atlantic Mutual'
  join party brk on brk.tenant_id=:'tenant_id'::uuid and brk.short_name='Meridian Brokers'
where prg.tenant_id=:'tenant_id'::uuid and prg.reference='PRG-2026-001'
on conflict do nothing;

-- Two XL layers: $5m xs $5m and $10m xs $10m
insert into contract_layer (tenant_id, contract_id, layer_no, name, currency,
                            attachment_minor, limit_minor, reinstatements, reinstatement_rates, rate_on_line)
select :'tenant_id'::uuid, c.id, 1, '$5m xs $5m', 'USD',
       500000000, 500000000, 1, '[1.0]'::jsonb, 0.10
from contract c where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

insert into contract_layer (tenant_id, contract_id, layer_no, name, currency,
                            attachment_minor, limit_minor, reinstatements, reinstatement_rates, rate_on_line)
select :'tenant_id'::uuid, c.id, 2, '$10m xs $10m', 'USD',
       1000000000, 1000000000, 2, '[1.0,0.5]'::jsonb, 0.06
from contract c where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

-- Reinsurer participations on layer 1 (signed down from written)
insert into participation (tenant_id, contract_id, layer_id, party_id, written_line, signed_line, order_pct, status)
select :'tenant_id'::uuid, c.id, l.id, re.id, 0.50, 0.40, 1.0, 'SIGNED'
from contract c
  join contract_layer l on l.contract_id=c.id and l.layer_no=1
  join party re on re.tenant_id=:'tenant_id'::uuid and re.short_name='Helvetia Re'
where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

insert into participation (tenant_id, contract_id, layer_id, party_id, written_line, signed_line, order_pct, status)
select :'tenant_id'::uuid, c.id, l.id, re.id, 0.75, 0.60, 1.0, 'SIGNED'
from contract c
  join contract_layer l on l.contract_id=c.id and l.layer_no=1
  join party re on re.tenant_id=:'tenant_id'::uuid and re.short_name='Synd 4242'
where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

-- Term set (deposit premium, reinstatement basis, brokerage)
insert into term_set (tenant_id, contract_id, terms)
select :'tenant_id'::uuid, c.id, jsonb_build_object(
  'estimatedPremiumIncome', 5000000,
  'depositPremium', 500000,
  'depositPct', 80,
  'minimumPct', 90,
  'brokeragePct', 10,
  'taxesPct', 0,
  'reinstatementBasis', 'pro-rata as to time and amount',
  'currency','USD')
from contract c where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- A standard GL chart (minimal) for posting demonstrations
-- ---------------------------------------------------------------------------
insert into gl_account (tenant_id, code, name, type, is_control) values
  (:'tenant_id'::uuid,'1100','Reinsurance Debtors (Control)','asset',true),
  (:'tenant_id'::uuid,'2100','Reinsurance Creditors (Control)','liability',true),
  (:'tenant_id'::uuid,'4000','Ceded Premium Income','income',false),
  (:'tenant_id'::uuid,'5000','Commission Expense','expense',false),
  (:'tenant_id'::uuid,'5100','Claims / Loss Expense','expense',false),
  (:'tenant_id'::uuid,'1000','Cash at Bank','asset',false)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Treasury: an investment portfolio backing reserves, and a premium-tax /
-- levy stack (§9, §13). Valuations & levy maths live in @rios/domain.
-- ---------------------------------------------------------------------------
insert into investment_holding (tenant_id, portfolio, name, instrument_type, currency,
                                face_value_minor, book_value_minor, market_value_minor, coupon_rate, maturity_date)
values
  (:'tenant_id'::uuid,'GENERAL','US Treasury 2.5% 2029','BOND','USD',
     500000000, 498000000, 505000000, 0.025, date '2029-05-15'),
  (:'tenant_id'::uuid,'GENERAL','Corporate Bond AA 4.2% 2031','BOND','USD',
     300000000, 300000000, 294000000, 0.042, date '2031-03-01'),
  (:'tenant_id'::uuid,'GENERAL','3-month T-Bill','BILL','USD',
     200000000, 199000000, 199500000, 0.0480, date '2026-09-30'),
  (:'tenant_id'::uuid,'GENERAL','Money Market Fund','FUND','USD',
     0, 150000000, 150000000, null, null)
on conflict do nothing;

insert into tax_levy (tenant_id, code, name, jurisdiction, rate, basis, active) values
  (:'tenant_id'::uuid,'PREM_TAX','Premium Tax','US', 0.0500,'premium',true),
  (:'tenant_id'::uuid,'FET','Federal Excise Tax','US', 0.0100,'premium',true),
  (:'tenant_id'::uuid,'STAMP','Stamp Duty','GB', 0.0050,'premium',true)
on conflict (tenant_id, code) do nothing;

-- ---------------------------------------------------------------------------
-- Risk & capital: a current capital position and a library of Realistic
-- Disaster Scenarios (§13). Metrics are computed by @rios/domain.
-- ---------------------------------------------------------------------------
insert into capital_position (tenant_id, as_of_date, currency, own_funds_minor, scr_minor, mcr_minor, note)
values (:'tenant_id'::uuid, date '2026-06-30','USD', 1800000000, 1200000000, 540000000,
        'Q2 2026 own funds vs standard-formula SCR')
on conflict (tenant_id, as_of_date) do nothing;

insert into rds_scenario (tenant_id, code, name, peril, region, currency, gross_loss_minor, assumed_recovery_minor)
values
  (:'tenant_id'::uuid,'RDS-FL-WIND','Florida Windstorm (two events)','Windstorm','US Southeast','USD', 900000000, 600000000),
  (:'tenant_id'::uuid,'RDS-EU-FLOOD','Northern European Flood','Flood','Europe','USD', 450000000, 250000000),
  (:'tenant_id'::uuid,'RDS-JP-QUAKE','Japanese Earthquake','Earthquake','Japan','USD', 1200000000, 850000000)
on conflict (tenant_id, code) do nothing;

-- ---------------------------------------------------------------------------
-- Data retention policies & a sample legal hold (§14). The disposition decision
-- is computed by @rios/domain; a hold always overrides a policy.
-- ---------------------------------------------------------------------------
insert into retention_policy (tenant_id, entity_type, retention_days, action, active, note) values
  (:'tenant_id'::uuid,'claim',        3650,'archive',true,'Claims kept 10 years'),
  (:'tenant_id'::uuid,'statement',    2555,'archive',true,'Statements kept 7 years'),
  (:'tenant_id'::uuid,'audit_log',   3650,'archive',true,'Audit retained 10 years'),
  (:'tenant_id'::uuid,'notification',  365,'purge',  true,'Notifications purged after 1 year')
on conflict (tenant_id, entity_type) do nothing;

insert into legal_hold (tenant_id, name, reason, entity_type, active)
values (:'tenant_id'::uuid,'Windstorm litigation hold','Pending coverage dispute on 2026 Atlantic Windstorm','claim',true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Field-level security: mask a party's regulatory identifiers unless the viewer
-- holds pii:view (§14). Masking is computed by @rios/domain.
-- ---------------------------------------------------------------------------
insert into field_policy (tenant_id, entity_type, field, classification, required_permission, strategy) values
  (:'tenant_id'::uuid,'party','identifiers','PII','pii:view','redact')
on conflict (tenant_id, entity_type, field) do nothing;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (§3). Next-run/due decisions are computed by @rios/domain.
-- ---------------------------------------------------------------------------
insert into scheduled_job (tenant_id, key, name, job_type, interval_minutes, enabled, next_run_at) values
  (:'tenant_id'::uuid,'statement-sweep','Statement sweep','statement_sweep', 1440, true, now()),
  (:'tenant_id'::uuid,'retention-scan','Retention eligibility scan','retention_scan', 1440, true, now()),
  (:'tenant_id'::uuid,'fx-refresh','FX rate refresh','fx_refresh', 60, true, now()),
  (:'tenant_id'::uuid,'audit-archive','Audit archive','audit_archive', 10080, false, null)
on conflict (tenant_id, key) do nothing;

-- ---------------------------------------------------------------------------
-- An approval delegation: the accountant delegates posting approval to the
-- underwriter while away (§3). The "may act" decision is computed by @rios/domain.
-- ---------------------------------------------------------------------------
insert into approval_delegation (tenant_id, delegator_user_id, delegate_user_id, scope_permission, reason, active)
select :'tenant_id'::uuid, acct.id, uw.id, 'accounting:post', 'Cover during leave', true
from app_user acct, app_user uw
where acct.tenant_id = :'tenant_id'::uuid and acct.email = 'acct@demo.rios'
  and uw.tenant_id = :'tenant_id'::uuid and uw.email = 'uw@demo.rios'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- A couple of employees and a performance review (§14). The overall rating is
-- computed by @rios/domain from the weighted goals.
-- ---------------------------------------------------------------------------
insert into employee (tenant_id, employee_no, first_name, last_name, email, position, user_id, hire_date, status)
select :'tenant_id'::uuid, 'EMP-90001','Tara','Underwood','uw@demo.rios','Treaty Underwriter', u.id, date '2021-04-01','active'
from app_user u where u.tenant_id=:'tenant_id'::uuid and u.email='uw@demo.rios'
on conflict (tenant_id, employee_no) do nothing;

insert into employee (tenant_id, employee_no, first_name, last_name, email, position, user_id, hire_date, status)
select :'tenant_id'::uuid, 'EMP-90002','Alan','Counts','acct@demo.rios','Technical Accountant', u.id, date '2020-09-15','active'
from app_user u where u.tenant_id=:'tenant_id'::uuid and u.email='acct@demo.rios'
on conflict (tenant_id, employee_no) do nothing;

insert into performance_review (tenant_id, employee_id, period, status, goals, overall_score, band, summary)
select :'tenant_id'::uuid, e.id, 'FY2026','in_review',
  '[{"title":"Portfolio profitability","weight":3,"score":4},
    {"title":"Renewal retention","weight":2,"score":4},
    {"title":"Compliance & audit","weight":1,"score":3}]'::jsonb,
  3.83,'meets','Strong technical year; develop leadership exposure.'
from employee e where e.tenant_id=:'tenant_id'::uuid and e.employee_no='EMP-90001'
on conflict (tenant_id, employee_id, period) do nothing;

-- ---------------------------------------------------------------------------
-- Insurance products (§14). Lifecycle driven by @rios/domain PRODUCT_LIFECYCLE.
-- ---------------------------------------------------------------------------
insert into insurance_product (tenant_id, code, name, line_of_business, version, status, definition) values
  (:'tenant_id'::uuid,'PROP-CAT-XL','Property Catastrophe XL','PROPERTY',1,'ACTIVE',
    '{"basis":"NON_PROPORTIONAL","npType":"CAT_XL","reinstatements":2}'::jsonb),
  (:'tenant_id'::uuid,'MARINE-QS','Marine Quota Share','MARINE',1,'DRAFT',
    '{"basis":"PROPORTIONAL","proportionalType":"QUOTA_SHARE","cededShare":0.4}'::jsonb),
  (:'tenant_id'::uuid,'CAS-XL','Casualty Per-Risk XL','CASUALTY',1,'SUSPENDED',
    '{"basis":"NON_PROPORTIONAL","npType":"PER_RISK_XL"}'::jsonb)
on conflict (tenant_id, code, version) do nothing;

-- ---------------------------------------------------------------------------
-- A catastrophe event and notified claims, so claims analytics & catastrophe
-- summaries have real data to aggregate (§13). Claims are independent of the
-- financial_event/statement reconciliation chain the integration tests assert.
-- ---------------------------------------------------------------------------
insert into cat_event (tenant_id, event_code, name, peril, region, event_date, status) values
  (:'tenant_id'::uuid,'WS-2026-ATLANTIC','2026 Atlantic Windstorm','Windstorm','North Atlantic', date '2026-03-14','OPEN')
on conflict (tenant_id, event_code) do nothing;

insert into claim (tenant_id, reference, contract_id, cat_event_id, description, loss_date,
                   currency, gross_loss_minor, outstanding_minor, paid_minor, status)
select :'tenant_id'::uuid, 'CLM-2026-000001', c.id, ce.id,
       'Windstorm property damage — coastal portfolio', date '2026-03-14',
       'USD', 750000000, 500000000, 250000000, 'RESERVED'
from contract c
  join cat_event ce on ce.tenant_id=:'tenant_id'::uuid and ce.event_code='WS-2026-ATLANTIC'
where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

insert into claim (tenant_id, reference, contract_id, cat_event_id, description, loss_date,
                   currency, gross_loss_minor, outstanding_minor, paid_minor, status)
select :'tenant_id'::uuid, 'CLM-2026-000002', c.id, ce.id,
       'Windstorm — secondary surge losses', date '2026-03-15',
       'USD', 320000000, 320000000, 0, 'NOTIFIED'
from contract c
  join cat_event ce on ce.tenant_id=:'tenant_id'::uuid and ce.event_code='WS-2026-ATLANTIC'
where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

insert into claim (tenant_id, reference, contract_id, description, loss_date,
                   currency, gross_loss_minor, outstanding_minor, paid_minor, status)
select :'tenant_id'::uuid, 'CLM-2026-000003', c.id,
       'Attritional fire loss', date '2026-02-02',
       'USD', 90000000, 0, 90000000, 'SETTLED'
from contract c
where c.tenant_id=:'tenant_id'::uuid and c.reference='TRTY-2026-00001'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Platform & org: companies, offices, feature flags, cost/capacity (§9.1, §13).
-- ---------------------------------------------------------------------------
insert into company (tenant_id, code, name, country, base_currency, status) values
  (:'tenant_id'::uuid,'CO-GRP','Demo Reinsurance Group','US','USD','active'),
  (:'tenant_id'::uuid,'CO-EU','Demo Re Europe SE','DE','EUR','active'),
  (:'tenant_id'::uuid,'CO-UK','Demo Re (UK) Ltd','GB','GBP','active')
on conflict (tenant_id, code) do nothing;

update company set parent_id = g.id
from (select id from company where tenant_id=:'tenant_id'::uuid and code='CO-GRP') g
where company.tenant_id=:'tenant_id'::uuid and company.code in ('CO-EU','CO-UK');

insert into office (tenant_id, company_id, code, name, city, country, is_head_office, status)
select :'tenant_id'::uuid, c.id, v.code, v.name, v.city, v.country, v.hq, 'open'
from (values
  ('CO-GRP','OFF-NYC','New York HQ','New York','US', true),
  ('CO-EU','OFF-MUC','Munich Office','Munich','DE', true),
  ('CO-UK','OFF-LON','London Office','London','GB', true)
) as v(co, code, name, city, country, hq)
join company c on c.tenant_id=:'tenant_id'::uuid and c.code = v.co
on conflict (tenant_id, code) do nothing;

insert into feature_flag (tenant_id, key, name, enabled, seat_limit, plan) values
  (:'tenant_id'::uuid,'ai-assistant','AI Assistant', true, null, 'enterprise'),
  (:'tenant_id'::uuid,'portals','External Portals', true, 50, 'enterprise'),
  (:'tenant_id'::uuid,'voice-assistant','Voice Assistant', false, null, 'enterprise'),
  (:'tenant_id'::uuid,'advanced-analytics','Advanced Analytics', true, null, 'enterprise')
on conflict (tenant_id, key) do nothing;

insert into cost_record (tenant_id, category, period, amount_minor, currency, capacity_provisioned, capacity_used, capacity_unit) values
  (:'tenant_id'::uuid,'compute','2026-06', 1850000,'USD', 32, 21, 'vCPU'),
  (:'tenant_id'::uuid,'storage','2026-06',  420000,'USD', 2000, 1340, 'GB'),
  (:'tenant_id'::uuid,'licenses','2026-06', 980000,'USD', 50, 38, 'seats'),
  (:'tenant_id'::uuid,'staff','2026-06',  12500000,'USD', null, null, null)
on conflict (tenant_id, category, period) do nothing;

commit;
